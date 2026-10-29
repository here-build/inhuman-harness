/**
 * Session commands: turn admit (mint/steer/queue/continue), compact, cancel,
 * rewind, retry, and prompt-queue drain. Transport and document persistence
 * stay on the host.
 */
import { asSystemPrompt, asUserPrompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  admitSteer,
  CompactJob,
  findEvalTurnByRequestId,
  findTurnById,
  HOST_QUEUE_VERBS,
  isAtTip,
  isRewindPin,
  looksLikePath,
  onTipChain,
  reactChunks,
  ReACTChunk,
  refreshSystemPrompt,
  resolvedTip,
  SessionSystemPrompt,
  SessionTurn,
  skillMatchesVerb,
  tapeCompletion,
  userVisualsJson,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";

import type { SessionCommandHost } from "./types.js";
import { compactRejectReason, stampCompactInputs } from "../context/index.js";

export type CommandFail = {
  readonly ok: false;
  readonly reason: string;
  readonly invalid?: boolean;
};

export type TurnAdmitResult =
  | {
      readonly ok: true;
      readonly action: "noop" | "mint" | "steer" | "queue" | "continue";
    }
  | CommandFail;

export type CompactAdmitResult = { readonly ok: true; readonly compacted: false } | CommandFail;

export type RewindResult = { readonly ok: true; readonly turnId: string } | CommandFail;

export type CancelTurnArgs = { readonly turnId: string } | { readonly requestId: string };

type TurnKind = "steer" | "queue" | "continue";

function requestTurnCancel(turn: SessionTurn, requestId?: string, cancelledEval?: Record<string, string>): void {
  turn.cancelRequested = true;
  if (requestId != null && requestId !== "" && cancelledEval != null) {
    cancelledEval[requestId] = "1";
  }
}

function refreshTurn(host: SessionCommandHost, turn: SessionTurn): void {
  refreshSystemPrompt(turn, {
    constitution: asSystemPrompt(host.constitution),
    env: host.env(),
  });
  host.applyBotNotice?.(turn);
}

/** R1: the policy in force when the turn is minted. A later config or kv edit applies from the next turn. */
function retentionStamp(host: SessionCommandHost): { readonly retentionJson?: string } {
  const json = host.retentionJson?.() ?? "";
  return json === "" ? {} : { retentionJson: json };
}

function mintContinueTurn(host: SessionCommandHost, head: SessionTurn): void {
  const turn = new SessionTurn({
    turnTail: head,
    prompt: asUserPrompt(""),
    queue: [new ReACTChunk()],
    toolsDefinition: host.toolsFor(head),
    ...retentionStamp(host),
  });
  host.session.seatHead(turn);
  refreshTurn(host, turn);
  host.log?.("continue admitted");
}

function skillSplit(
  host: SessionCommandHost,
  text: UserPrompt,
): { readonly prompt: UserPrompt; readonly derived: UserPrompt | null } {
  host.syncSkills?.();
  return host.expandSkill?.(text, host.session.skills, host.queuedVerbs()) ?? { prompt: text, derived: null };
}

function mintUserTurn(
  host: SessionCommandHost,
  text: UserPrompt,
  visuals: readonly UserVisualIdentity[] = [],
): SessionTurn {
  const split = skillSplit(host, text);
  const tail =
    host.session.head ??
    new SessionSystemPrompt({
      constitution: asSystemPrompt(host.constitution),
      env: host.env(),
      skills: host.session.skills.map((skill) => skill.clone()),
    });
  const turn = new SessionTurn({
    turnTail: tail,
    prompt: split.prompt,
    derivedMessage: split.derived,
    toolsDefinition: host.toolsFor(tail),
    ...retentionStamp(host),
    ...(visuals.length === 0 ? {} : { visualsJson: userVisualsJson(visuals) }),
  });
  turn.markStarted();
  host.session.seatHead(turn);
  refreshTurn(host, turn);
  host.log?.(`turn ${text}`);
  return turn;
}

function mintCompactTurn(host: SessionCommandHost, focus: string): CompactAdmitResult {
  if (host.session.head == null) {
    host.log?.("compact no-head");
    return { ok: false, reason: "no-head" };
  }
  const rejected = compactRejectReason(host.session.head);
  if (rejected != null) {
    host.log?.(`compact ${rejected}`);
    return { ok: false, reason: rejected };
  }
  const job = new CompactJob({ reason: "user" });
  // F8: the cut's inputs are facts of this job from here on, not live settings.
  stampCompactInputs(job, host.compactKeepTurns?.() ?? 1, host.session.kvs);
  const turn = new SessionTurn({
    turnTail: host.session.head,
    prompt: asUserPrompt(focus),
    queue: [job],
    reloadTools: true,
  });
  turn.pushChild(job);
  turn.markStarted();
  host.session.seatHead(turn);
  refreshTurn(host, turn);
  host.log?.("compact admitted");
  return { ok: true, compacted: false };
}

export function admitTurn(
  host: SessionCommandHost,
  args: { readonly prompt: string; readonly kind?: TurnKind; readonly visuals?: readonly UserVisualIdentity[] },
): TurnAdmitResult {
  const visuals = args.visuals ?? [];
  const prompt = asUserPrompt(args.prompt.trim());
  if (visuals.length > 0 && (args.kind === "steer" || args.kind === "queue" || args.kind === "continue")) {
    return { ok: false, reason: "an image can't be sent with that", invalid: true };
  }
  if (args.kind === "continue") {
    if (host.session.findRunningTurn() != null) return { ok: true, action: "noop" };
    if (!isAtTip(host.session.head, host.session.tip)) {
      return { ok: false, reason: "off-tip", invalid: true };
    }
    const head = host.session.head;
    if (!head?.lastTurnIncomplete) return { ok: true, action: "noop" };
    if ((host.session.kvs.connection ?? "").trim() === "") {
      return { ok: false, reason: "connection is required", invalid: true };
    }
    mintContinueTurn(host, head);
    return { ok: true, action: "continue" };
  }
  if (prompt === "" && visuals.length === 0) return { ok: true, action: "noop" };
  if ((host.session.kvs.connection ?? "").trim() === "") {
    return { ok: false, reason: "connection is required", invalid: true };
  }
  const running = host.session.findRunningTurn();
  if (running != null) {
    if (visuals.length > 0) return { ok: false, reason: "an image can't be sent with that", invalid: true };
    // A steer is an expectation that the turn claims it at its next round.
    // A turn that can't (stopped, an eval, a compact) won't, so the row is
    // an expectation of a future turn instead: the queue lane, which the
    // session mints from once that turn has exited.
    const kind = args.kind !== "queue" && host.session.steerTurn === running ? "steer" : "queue";
    const split = skillSplit(host, prompt);
    if (kind === "queue") admitQueue(host.session, split.prompt, running.uuid, split.derived);
    else admitSteer(host.session, split.prompt, running.uuid, split.derived);
    host.log?.(`turn ${kind} ${prompt}`);
    return { ok: true, action: kind };
  }
  mintUserTurn(host, prompt, visuals);
  return { ok: true, action: "mint" };
}

export function admitCompact(host: SessionCommandHost, focus = ""): CompactAdmitResult {
  if (host.session.findRunningTurn() != null) {
    return { ok: false, reason: "already running", invalid: true };
  }
  return mintCompactTurn(host, focus);
}

export function cancelTurnCommand(host: SessionCommandHost, args: CancelTurnArgs): { readonly ok: true } {
  if ("requestId" in args) {
    const existing = findEvalTurnByRequestId(host.session, args.requestId);
    if (existing != null) {
      requestTurnCancel(existing, args.requestId, host.session.cancelledEvalRequests);
      host.cancelOwned(existing);
    } else {
      host.session.cancelledEvalRequests[args.requestId] = "1";
    }
    host.log?.(`turn/cancel request ${args.requestId}`);
    return { ok: true };
  }
  const turn = findTurnById(host.session, args.turnId) ?? host.loadTurn?.(args.turnId);
  if (turn instanceof SessionTurn) {
    requestTurnCancel(turn, turn.evalSpec?.requestId, host.session.cancelledEvalRequests);
    host.cancelOwned(turn);
  }
  host.log?.(`turn/cancel turn ${args.turnId}`);
  return { ok: true };
}

export function rewindTurn(host: SessionCommandHost, turnId: string): RewindResult {
  const live = host.session.head;
  if (live == null) return { ok: false, reason: "no-head", invalid: true };
  const loaded = host.loadTurn?.(turnId) ?? findTurnById(host.session, turnId);
  if (!(loaded instanceof SessionTurn)) return { ok: false, reason: "unknown-id", invalid: true };
  const ceiling = resolvedTip(live, host.session.tip);
  if (!isRewindPin(loaded) && loaded !== ceiling) return { ok: false, reason: "not-a-pin", invalid: true };
  if (!onTipChain(loaded, ceiling, live)) return { ok: false, reason: "off-chain", invalid: true };
  const open = host.session.liveChain.filter((turn) => turn.inLoop);
  host.session.rewindHead(loaded, ceiling);
  for (const turn of open) {
    requestTurnCancel(turn, turn.evalSpec?.requestId, host.session.cancelledEvalRequests);
    host.cancelOwned(turn);
  }
  host.restorePluginState?.();
  host.log?.(`turn/rewind ${turnId}`);
  return { ok: true, turnId: loaded.uuid };
}

export function retryTurn(host: SessionCommandHost): { readonly ok: true } {
  const turn = host.session.findRunningTurn();
  if (turn != null) {
    const live = reactChunks(turn)
      .map((chunk) => tapeCompletion(chunk))
      .filter((pew) => pew != null && pew.outcome == null);
    const completion = live.at(-1);
    if (completion != null) host.skipBackoff?.(completion);
  }
  host.log?.("turn/retry");
  return { ok: true };
}

export function drainPromptQueue(host: SessionCommandHost): void {
  if (host.closed) return;
  if (host.session.findRunningTurn() != null) return;
  const item = host.session.promptQueue[0];
  if (item == null) return;
  host.syncSkills?.();
  const trimmed = item.text.trim();
  if (!looksLikePath(trimmed) && trimmed.startsWith("/")) {
    const token = (trimmed.split("\n")[0] ?? "").trim().split(/\s/)[0] ?? "";
    const verb = token.startsWith("/") && token.length >= 2 ? token.slice(1) : null;
    if (verb === "compact") {
      host.session.promptQueue.shift();
      mintCompactTurn(host, trimmed.slice(trimmed.indexOf("compact") + "compact".length).trim());
      return;
    }
    if (verb === "rename") {
      host.session.promptQueue.shift();
      const rest = trimmed.slice(trimmed.indexOf("rename") + "rename".length).trim();
      host.rename?.(rest === "--auto" ? "" : rest);
      drainPromptQueue(host);
      return;
    }
    const verbs = new Set<string>([...HOST_QUEUE_VERBS, ...host.queuedVerbs()]);
    if (verb !== null && verbs.has(verb)) {
      host.session.promptQueue.shift();
      host.log?.(`queue reject host-verb ${item.text}`);
      return;
    }
    if (verb !== null && !host.session.skills.some((skill) => skillMatchesVerb(skill, verb))) {
      host.session.promptQueue.shift();
      host.log?.(`queue reject unknown-command ${item.text}`);
      return;
    }
  }
  if ((host.session.kvs.connection ?? "").trim() === "") return;
  host.session.promptQueue.shift();
  mintUserTurn(host, asUserPrompt(trimmed));
}
