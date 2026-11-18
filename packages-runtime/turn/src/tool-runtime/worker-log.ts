/**
 * Caller-scoped inspection of owned subagent workers and their turn/tool logs.
 */
import {
  AgentCallbackJob,
  AgentCallJob,
  BotCallJob,
  CallJob,
  CompletionExpectation,
  FailureOutcome,
  ProgrammaticJob,
  reactChunks,
  SessionRoot,
  SessionTurn,
  spawnDescriptionArgs,
  SuccessfulOutcome,
  tapeCompletion,
  ToolCallJob,
  TurnNotificationChunk,
} from "@inhuman.tools/harness-model";

import { liftToolImages, paintObservation } from "../context/squeeze.js";

const MIN_PREFIX = 4;
const THOUGHT_PREVIEW_CHARS = 600;
const ASSISTANT_PREVIEW_CHARS = 2000;
const TOOL_OUTPUT_PREVIEW_CHARS = 500;
const RESPOND_PREVIEW_CHARS = 8000;
const INLINE_PREVIEW_CHARS = 240;

// SessionRoot extends thenable WorkContainer; return a wrapper from async load so await does not unwrap .then().
export type WorkerSessionHandle = {
  readonly root: SessionRoot;
};

export type WorkerSessionLoader = {
  peek(sessionId: string): SessionRoot | undefined;
  load(sessionId: string): Promise<WorkerSessionHandle | undefined>;
};

export type ResolvedOwnedWorker =
  | {
      readonly ok: true;
      readonly workerSessionId: string;
      readonly calls: readonly CallJob[];
      readonly canonicalRef: string;
      readonly botName?: string;
    }
  | { readonly ok: false; readonly error: string };

const workerSessionLoaders = new WeakMap<object, WorkerSessionLoader>();

export function bindWorkerSessionLoader(root: object, loader: WorkerSessionLoader | undefined): void {
  if (loader === undefined) {
    workerSessionLoaders.delete(root);
    return;
  }
  workerSessionLoaders.set(root, loader);
}

export function workerSessionLoaderOf(root: object | null | undefined): WorkerSessionLoader | undefined {
  return root == null ? undefined : workerSessionLoaders.get(root);
}

function safeUuid(node: { readonly uuid: string }): string {
  try {
    return node.uuid;
  } catch {
    return "";
  }
}

function shortJobRef(node: { readonly uuid: string }): string | undefined {
  const id = safeUuid(node);
  return id.length >= 8 ? `job:${id.slice(0, 8)}` : undefined;
}

function reachableTurns(root: SessionRoot): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (let cell: unknown = root.head; cell instanceof SessionTurn && !out.includes(cell); cell = cell.turnTail) {
    out.push(cell);
  }
  return out;
}

function collectCallerWork(caller: SessionRoot): {
  readonly calls: CallJob[];
  readonly nonCalls: Array<ToolCallJob | ProgrammaticJob>;
} {
  const calls: CallJob[] = [];
  const nonCalls: Array<ToolCallJob | ProgrammaticJob> = [];
  const seen = new Set<ToolCallJob | ProgrammaticJob>();
  const visit = (job: ToolCallJob | ProgrammaticJob): void => {
    if (seen.has(job)) return;
    seen.add(job);
    if (job instanceof CallJob) calls.push(job);
    else nonCalls.push(job);
    for (const child of job.children) {
      if (child instanceof ToolCallJob || child instanceof ProgrammaticJob) visit(child);
    }
  };
  for (const turn of reachableTurns(caller)) {
    for (const cell of reactChunks(turn)) {
      if (cell instanceof ToolCallJob || cell instanceof ProgrammaticJob) visit(cell);
    }
  }
  for (const node of caller.motionWork()) {
    if (node instanceof ToolCallJob || node instanceof ProgrammaticJob) visit(node);
  }
  return { calls, nonCalls };
}

function callSpecOf(call: CallJob): string {
  const spec = call.argString("spec").trim();
  if (spec !== "") return spec;
  return call instanceof BotCallJob ? call.botName.trim() : "";
}

function resolvedForCall(hit: CallJob, allCalls: readonly CallJob[], botName?: string): ResolvedOwnedWorker {
  const wid = hit.workerSessionId;
  const related = wid !== "" ? allCalls.filter((call) => call.workerSessionId === wid) : [hit];
  const ref = shortJobRef(hit);
  const canonicalRef =
    wid !== "" ? `agent:${wid}` : ref !== undefined ? `${ref}#log` : `agent:${hit.toolCallId || hit.name}`;
  return {
    ok: true,
    workerSessionId: wid,
    calls: related,
    canonicalRef,
    ...(botName == null ? {} : { botName }),
  };
}

export function resolveOwnedWorker(caller: SessionRoot, rawTarget: string): ResolvedOwnedWorker {
  const trimmed = rawTarget.trim();
  if (trimmed === "") return { ok: false, error: "worker target is required" };
  const { calls, nonCalls } = collectCallerWork(caller);

  if (trimmed.startsWith("job:")) {
    const prefix = trimmed.slice("job:".length).replace(/#log$/, "");
    if (prefix.length < MIN_PREFIX) return { ok: false, error: `ref ${trimmed} is too short` };
    const hits = calls.filter((call) => safeUuid(call).startsWith(prefix));
    if (hits.length === 0) {
      if (nonCalls.some((node) => safeUuid(node).startsWith(prefix))) {
        return { ok: false, error: `job:${prefix} is not an agent call` };
      }
      return { ok: false, error: `unknown or unreachable ref job:${prefix}#log` };
    }
    if (hits.length > 1) return { ok: false, error: `ref job:${prefix}#log is ambiguous` };
    const hit = hits[0];
    if (hit === undefined) return { ok: false, error: `unknown or unreachable ref job:${prefix}#log` };
    return resolvedForCall(hit, calls);
  }

  const key = trimmed.startsWith("agent:") ? trimmed.slice("agent:".length).trim() : trimmed;
  if (key === "") return { ok: false, error: `unknown or unreachable worker ${trimmed}` };

  const exactCalls = calls.filter((call) => call.workerSessionId === key);
  const rosterBotEntry = Object.entries(caller.botsRoster).find(([, id]) => id === key);
  if (exactCalls.length > 0 || rosterBotEntry != null) {
    return {
      ok: true,
      workerSessionId: key,
      calls: exactCalls,
      canonicalRef: `agent:${key}`,
      ...(rosterBotEntry == null ? {} : { botName: rosterBotEntry[0] }),
    };
  }

  const byToolCallId = calls.filter((call) => call.toolCallId === key);
  if (byToolCallId.length > 0) {
    const ids = [...new Set(byToolCallId.map((call) => call.workerSessionId))];
    const firstCall = byToolCallId[0];
    if (ids.length === 1 && firstCall !== undefined) return resolvedForCall(firstCall, calls);
    return { ok: false, error: `ambiguous worker "${key}" — pass workerSessionId` };
  }

  const rosterId = Object.hasOwn(caller.botsRoster, key) ? caller.botsRoster[key] : undefined;
  if (typeof rosterId === "string" && rosterId !== "") {
    return {
      ok: true,
      workerSessionId: rosterId,
      calls: calls.filter((call) => call.workerSessionId === rosterId),
      canonicalRef: `agent:${rosterId}`,
      botName: key,
    };
  }

  const bySpec = calls.filter((call) => callSpecOf(call) === key);
  if (bySpec.length > 0) {
    const ids = [...new Set(bySpec.map((call) => call.workerSessionId).filter((id) => id !== ""))];
    const soleId = ids[0];
    if (ids.length === 1 && soleId !== undefined && bySpec.every((call) => call.workerSessionId === soleId)) {
      return {
        ok: true,
        workerSessionId: soleId,
        calls: calls.filter((call) => call.workerSessionId === soleId),
        canonicalRef: `agent:${soleId}`,
        botName: key,
      };
    }
    const soleSpecCall = bySpec[0];
    if (ids.length === 0 && bySpec.length === 1 && soleSpecCall !== undefined) {
      return resolvedForCall(soleSpecCall, calls, key);
    }
    return {
      ok: false,
      error: `ambiguous worker "${key}" — pass workerSessionId${ids.length > 0 ? `: ${ids.join(", ")}` : ""}`,
    };
  }

  if (key.length >= MIN_PREFIX) {
    const prefixIds = [
      ...new Set(
        [...calls.map((call) => call.workerSessionId), ...Object.values(caller.botsRoster)].filter(
          (id) => id !== "" && id.startsWith(key),
        ),
      ),
    ];
    const solePrefixId = prefixIds[0];
    if (prefixIds.length === 1 && solePrefixId !== undefined) {
      return {
        ok: true,
        workerSessionId: solePrefixId,
        calls: calls.filter((call) => call.workerSessionId === solePrefixId),
        canonicalRef: `agent:${solePrefixId}`,
      };
    }
    if (prefixIds.length > 1) {
      return { ok: false, error: `ambiguous worker prefix "${key}": ${prefixIds.join(", ")}` };
    }
    const uuidHits = calls.filter((call) => safeUuid(call).startsWith(key));
    const soleUuidHit = uuidHits[0];
    if (uuidHits.length === 1 && soleUuidHit !== undefined) return resolvedForCall(soleUuidHit, calls);
    if (uuidHits.length > 1) return { ok: false, error: `ambiguous worker prefix "${key}"` };
  }

  return { ok: false, error: `unknown or unreachable worker ${trimmed}` };
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function clipOneLine(text: string, maxChars: number): string {
  return clipText(text.replaceAll(/\s+/g, " ").trim(), maxChars);
}

function jobStateLabel(job: ToolCallJob | ProgrammaticJob): string {
  if (job.cancelled) return "cancelled";
  if (!job.completed) return job.background ? "background" : "in-flight";
  return job.outcomeSnap?.ok === false ? "failed" : "completed";
}

function renderToolObservation(job: ToolCallJob): string {
  const lifted = liftToolImages(job.observationPayload()).payload;
  return paintObservation(lifted).trim();
}

function renderCallSummary(call: CallJob): string {
  const ref = shortJobRef(call) ?? "job:?";
  const toolPart = call.toolCallId !== "" ? `, toolCallId=${call.toolCallId}` : "";
  const state =
    call.cancelled || (call.outcome instanceof FailureOutcome && call.outcome.code === "cancelled")
      ? "cancelled"
      : !call.completed
        ? call.background
          ? "running_in_background"
          : "running"
        : call.outcome instanceof SuccessfulOutcome
          ? "completed"
          : "failed";
  const desc = call instanceof AgentCallJob ? `, description=${JSON.stringify(call.description)}` : "";
  const outcomeDetail =
    call.outcome instanceof FailureOutcome && call.outcome.message.trim() !== ""
      ? ` — ${clipOneLine(call.outcome.message, 160)}`
      : "";
  const notes = call.notifications.map((note) => note.message.trim()).filter((msg) => msg !== "");
  const notifyDetail = notes.length > 0 ? ` | notify: ${clipOneLine(notes.join("; "), 200)}` : "";
  return `- ${ref} (${call.name}${toolPart}${desc}): state=${state}${outcomeDetail}${notifyDetail}`;
}

function appendToolLines(
  job: ToolCallJob,
  indent: string,
  lines: string[],
  onActivity: (summary: string) => void,
): void {
  const state = jobStateLabel(job);
  if (job instanceof AgentCallbackJob) {
    lines.push(`${indent}tool ${job.name} (${state})`);
    onActivity(`tool ${job.name} (${state})`);
    const response =
      job.argString("response").trim() || (job.args?.value !== undefined ? (JSON.stringify(job.args.value) ?? "") : "");
    if (response !== "") {
      lines.push(`${indent}  response:\n${clipText(response, RESPOND_PREVIEW_CHARS)}`);
    }
    return;
  }
  if (job instanceof AgentCallJob) {
    const summary = JSON.stringify(spawnDescriptionArgs(job));
    lines.push(`${indent}tool ${job.name} (${state}): ${summary}`);
    onActivity(`tool ${job.name} (${state})`);
    if (job.completed) {
      const outcome = renderToolObservation(job);
      if (outcome !== "") lines.push(`${indent}  outcome: ${clipText(outcome, TOOL_OUTPUT_PREVIEW_CHARS)}`);
    }
    return;
  }
  lines.push(`${indent}tool ${job.name} (${state}): ${clipOneLine(job.invocation(), INLINE_PREVIEW_CHARS)}`);
  onActivity(`tool ${job.name} (${state})`);
  if (job.completed) {
    const out = renderToolObservation(job);
    if (out !== "") lines.push(`${indent}  output: ${clipText(out, TOOL_OUTPUT_PREVIEW_CHARS)}`);
  }
}

function workerStatusOf(resolved: Extract<ResolvedOwnedWorker, { ok: true }>, worker: SessionRoot): string {
  if (worker.asking) return "awaiting_approval";
  const hasOpenCallback = resolved.calls.some(
    (call) => !call.completed && !call.cancelled && worker.agentCallbacks[safeUuid(call)] != null,
  );
  if (worker.midMotion || hasOpenCallback) return "running";
  const latestCall = resolved.calls.at(-1);
  if (latestCall?.outcome instanceof SuccessfulOutcome) return "completed";
  if (
    worker.head?.cancelled ||
    (worker.head?.broke ?? "").trim() !== "" ||
    latestCall?.outcome instanceof FailureOutcome
  ) {
    return "interrupted";
  }
  return "idle";
}

export function renderWorkerLog(
  resolved: Extract<ResolvedOwnedWorker, { ok: true }>,
  worker: SessionRoot | undefined,
): string {
  const callLines = resolved.calls.map(renderCallSummary);
  if (worker == null) {
    const status = resolved.workerSessionId === "" ? "not_started" : "unavailable_session";
    const lines = [
      ...(resolved.workerSessionId === "" ? [] : [`workerSessionId: ${resolved.workerSessionId}`]),
      ...(resolved.botName == null ? [] : [`spec: ${resolved.botName}`]),
      `status: ${status}`,
      ...(callLines.length > 0 ? ["calls:", ...callLines] : []),
    ];
    return lines.join("\n");
  }

  const turns = reachableTurns(worker).toReversed();
  const bodyLines: string[] = [];
  let lastActivity = "";
  const noteActivity = (summary: string): void => {
    lastActivity = summary;
  };

  for (const [index, turn] of turns.entries()) {
    const broke = turn.broke.trim();
    const turnState =
      turn.cancelled || turn.cancelRequested
        ? "cancelled"
        : broke !== ""
          ? "broke"
          : turn.reducerExited
            ? "closed"
            : "running";
    const turnHeader = `[Turn ${index + 1} — ${turnState} · rounds=${turn.rounds}${broke !== "" ? ` · broke=${JSON.stringify(broke)}` : ""}]`;
    bodyLines.push("", turnHeader);
    noteActivity(turnHeader);

    const requestId = turn.agentRequestId.trim();
    const matchedCall = requestId === "" ? undefined : resolved.calls.find((call) => safeUuid(call) === requestId);
    if (matchedCall instanceof AgentCallJob) {
      bodyLines.push(`task: ${matchedCall.description}`);
    } else if (turn.completionMessage.trim() !== "") {
      bodyLines.push(`task: ${clipOneLine(turn.completionMessage, INLINE_PREVIEW_CHARS)}`);
    }

    let round = 0;
    for (const chunk of reactChunks(turn)) {
      const completion = tapeCompletion(chunk) ?? (chunk instanceof CompletionExpectation ? chunk : null);
      if (completion != null) {
        round += 1;
        const roundLabel = `Round ${round} (${completion.outcome ?? "in-flight"})`;
        bodyLines.push(`  ${roundLabel}`);
        noteActivity(roundLabel);
        const thought = completion.responseThought.trim();
        if (thought !== "") bodyLines.push(`    thought: ${clipText(thought, THOUGHT_PREVIEW_CHARS)}`);
        const text = completion.responseText.trim();
        if (text !== "") bodyLines.push(`    assistant: ${clipText(text, ASSISTANT_PREVIEW_CHARS)}`);
        continue;
      }
      if (chunk instanceof ProgrammaticJob) {
        const state = jobStateLabel(chunk);
        const progSummary = `tool ${chunk.toolName} (${state}): ${clipOneLine(chunk.expr, INLINE_PREVIEW_CHARS)}`;
        bodyLines.push(`  ${progSummary}`);
        noteActivity(progSummary);
        for (const inner of chunk.toolCalls) {
          appendToolLines(inner, "    ", bodyLines, noteActivity);
        }
        if (chunk.toolCalls.length === 0 && chunk.completed) {
          const out = chunk.resultText().trim();
          if (out !== "") bodyLines.push(`    output: ${clipText(out, TOOL_OUTPUT_PREVIEW_CHARS)}`);
        }
        continue;
      }
      if (chunk instanceof ToolCallJob) {
        appendToolLines(chunk, "  ", bodyLines, noteActivity);
        continue;
      }
      if (chunk instanceof TurnNotificationChunk) {
        const notice = chunk.notificationText().trim();
        if (notice !== "") bodyLines.push(`  notice: ${clipOneLine(notice, 300)}`);
      }
    }
  }

  const modelRef = [worker.kvs.connection?.trim(), worker.kvs.model?.trim()].filter(Boolean).join("/") || "(inherited)";
  const specName = worker.agent.spec.name.trim() || (resolved.botName ?? "(anonymous)");
  const openCallbacks = Object.keys(worker.agentCallbacks).sort();
  const headerLines = [
    `workerSessionId: ${resolved.workerSessionId}`,
    `spec: ${specName}`,
    `model: ${modelRef}`,
    `status: ${workerStatusOf(resolved, worker)}`,
    ...(openCallbacks.length > 0 ? [`openCallbacks: ${openCallbacks.join(", ")}`] : []),
    ...(callLines.length > 0 ? ["calls:", ...callLines] : []),
    ...(lastActivity !== "" ? [`lastActivity: ${lastActivity}`] : []),
  ];
  return [...headerLines, ...bodyLines].join("\n");
}
