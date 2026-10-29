/**
 * Drawer projection over the existing gatherer. Tape order is the tree.
 * Does not intern workers. Does not wait on Agent.parent.
 *
 * Compact meter: left is the live huddle — unfinished calls whose worker
 * is not a pal. Right is pals this tape already talked to: keepAlive
 * workers, or conversations. One-shots are never pals. A pal
 * currently working stays on the right only. Drawer Subagents rows are
 * unfinished Calls; settled Calls stay off that list. A tape mention
 * still resolves through `mentionedAgentCall`, including a settled Call.
 */
import { recordString } from "@inhuman.tools/harness-model/json-record";
import {
  isConversationOverview,
  occupiedSessionIds,
  type KernelAgentRelation,
} from "@inhuman.tools/harness-model/kernel";
import {
  AgentCallJob,
  CallJob,
  isNoteClaimed,
  ProgrammaticJob,
  SessionTurn,
  reactChunks,
  type SessionUnfinished,
  type SessionUnit,
  BotCallJob,
} from "@inhuman.tools/harness-model/session";
import { comparer, computed, type IComputedValue } from "mobx";

import { ClientAgent, type AgentTempo } from "./client-agents.js";
import type { Client } from "./client.js";

/** Ceiling for this-project conversations in the drawer. Not a visible-row target. */
export const DRAWER_RECENT_SESSION_LIMIT = 20;

/** U+25B8. Text play — resident background work. Not emoji. */
export const SESSION_FACE_PLAY = "▸";
/** U+2016. Text pause — parked leftover work. Not emoji. */
export const SESSION_FACE_PAUSE = "‖";
/** Occupied ask. Paint is `attention` — same hue as the always-approve chip. */
export const SESSION_FACE_ASK = "awaiting approval";
/** Speech-question pin. Not license cover. */
export const SESSION_FACE_QUESTION = "has a question";

export type AgentDrawerCall = {
  readonly key: string;
  readonly spec: string;
  readonly tempo: AgentTempo;
  readonly status: string;
  readonly prompt: string;
  readonly notifies: readonly string[];
  readonly result: string;
  readonly sessionId: string;
  readonly oneShot: boolean;
  readonly completed: boolean;
  readonly model: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly unfinished: SessionUnfinished;
  readonly mark: string;
  readonly children: readonly AgentDrawerCall[];
};

export type AgentDrawerProgram = {
  readonly key: string;
  readonly name: string;
  readonly children: readonly AgentDrawerCall[];
};

export type AgentDrawerCallNode =
  | { readonly kind: "program"; readonly program: AgentDrawerProgram }
  | { readonly kind: "call"; readonly call: AgentDrawerCall };

export type AgentDrawerCollaborator = {
  readonly key: string;
  readonly sessionId: string;
  readonly spec: string;
  readonly tempo: AgentTempo;
  readonly status: string;
  readonly keepAlive: boolean;
  readonly prompt: string;
  readonly notifies: readonly string[];
  readonly result: string;
};

export type AgentDrawerSession = {
  readonly key: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly model: string;
  readonly lastMessageAt: number;
  readonly occupied: boolean;
  readonly resident: boolean;
  readonly periodArmed: boolean;
  readonly openTurn: boolean;
  readonly openToolCount: number;
  readonly unfinished: SessionUnfinished;
  readonly tempo: AgentTempo;
  readonly mark: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly current: boolean;
};

export type AgentDrawerRowKind = "call" | "bot" | "session";

export type AgentDrawerRow = {
  readonly key: string;
  readonly kind: AgentDrawerRowKind;
  readonly spec: string;
  readonly recap: string;
  readonly indent: number;
  readonly prompt: string;
  readonly notifies: readonly string[];
  readonly result: string;
  readonly tempo: AgentTempo;
  readonly model: string;
  readonly mark: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly unfinished: SessionUnfinished;
  readonly current: boolean;
  /** Worker or conversation id. Empty until a Call intern stamps `workerSessionId`. */
  readonly sessionId: string;
};

export type AgentDrawerProjection = {
  readonly calls: readonly AgentDrawerCallNode[];
  readonly collaborators: readonly AgentDrawerCollaborator[];
  readonly sessions: readonly AgentDrawerSession[];
};

export type AgentMeterGroup = {
  readonly spec: string;
  readonly count: number;
};

export type AgentMeterProjection = {
  readonly calls: readonly AgentMeterGroup[];
  readonly bots: readonly string[];
};

const turnCallChunksCache = new WeakMap<SessionTurn, IComputedValue<readonly (CallJob | ProgrammaticJob)[]>>();

function turnCallChunks(turn: SessionTurn): readonly (CallJob | ProgrammaticJob)[] {
  let box = turnCallChunksCache.get(turn);
  if (box === undefined) {
    box = computed(
      () => {
        const out: (CallJob | ProgrammaticJob)[] = [];
        for (const chunk of reactChunks(turn)) {
          if (chunk instanceof CallJob) {
            out.push(chunk);
          } else if (chunk instanceof ProgrammaticJob && chunk.toolCalls.some((inner) => inner instanceof CallJob)) {
            out.push(chunk);
          }
        }
        return out;
      },
      { equals: comparer.shallow },
    );
    turnCallChunksCache.set(turn, box);
  }
  return box.get();
}

export function projectAgentDrawer(client: Client): AgentDrawerProjection {
  const seen = new Set<CallJob>();
  const calls: AgentDrawerCallNode[] = [];
  for (const turn of tapeTurns(client)) {
    for (const chunk of turnCallChunks(turn)) {
      if (chunk instanceof ProgrammaticJob) {
        const nested: AgentDrawerCall[] = [];
        for (const inner of chunk.toolCalls) {
          if (!(inner instanceof CallJob)) continue;
          if (seen.has(inner)) continue;
          seen.add(inner);
          nested.push(projectCall(client, inner));
        }
        if (nested.length === 0) continue;
        const expr = chunk.expr.trim();
        const toolName = typeof chunk.toolName === "string" ? chunk.toolName.trim() : "";
        const name =
          expr !== "" && expr !== "()" ? expr : toolName === "" || toolName === "scheme_repl" ? "scheme" : toolName;
        calls.push({
          kind: "program",
          program: { key: `program:${chunk.toolCallId}`, name, children: nested },
        });
        continue;
      }
      if (!(chunk instanceof CallJob)) continue;
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      calls.push({ kind: "call", call: projectCall(client, chunk) });
    }
  }
  for (const leftover of client.agentCalls) {
    if (seen.has(leftover)) continue;
    seen.add(leftover);
    calls.push({ kind: "call", call: projectCall(client, leftover) });
  }
  return { calls, collaborators: projectCollaborators(client), sessions: projectRecentSessions(client) };
}

/** Call row for a tape mention. Settled calls stay off `flattenAgentDrawer` and still resolve. */
export function mentionedAgentCall(
  client: Client,
  key: string,
): { readonly key: string; readonly sessionId: string } | null {
  if (!key.startsWith("call:") || key.length === "call:".length) return null;
  const walk = (call: AgentDrawerCall): AgentDrawerCall | null => {
    if (call.key === key) return call;
    for (const child of call.children) {
      const hit = walk(child);
      if (hit != null) return hit;
    }
    return null;
  };
  for (const node of projectAgentDrawer(client).calls) {
    const roots = node.kind === "program" ? node.program.children : [node.call];
    for (const call of roots) {
      const hit = walk(call);
      if (hit != null) return { key: hit.key, sessionId: hit.sessionId };
    }
  }
  return null;
}

export function flattenAgentDrawer(proj: AgentDrawerProjection): readonly AgentDrawerRow[] {
  const rows: AgentDrawerRow[] = [];
  const emit = (call: AgentDrawerCall, indent: number): void => {
    const live = !call.completed;
    if (live) rows.push(callRow(call, indent));
    const next = live ? indent + 1 : indent;
    for (const child of call.children) emit(child, next);
  };
  for (const node of proj.calls) {
    if (node.kind === "program") {
      for (const call of node.program.children) emit(call, 0);
      continue;
    }
    emit(node.call, 0);
  }
  for (const bot of proj.collaborators) {
    rows.push({
      key: bot.key,
      kind: "bot",
      spec: bot.spec,
      recap: bot.status,
      indent: 0,
      prompt: bot.prompt,
      notifies: bot.notifies,
      result: bot.result,
      tempo: bot.tempo,
      model: "",
      mark: "",
      lastPrompt: "",
      askLine: "",
      unfinished: "",
      current: false,
      sessionId: bot.sessionId,
    });
  }
  for (const session of proj.sessions) {
    rows.push({
      key: session.key,
      kind: "session",
      spec: session.title,
      recap: session.status,
      indent: 0,
      prompt: "",
      notifies: [],
      result: "",
      tempo: session.tempo,
      model: session.model,
      mark: session.mark,
      lastPrompt: session.lastPrompt,
      askLine: session.askLine,
      unfinished: session.unfinished,
      current: session.current,
      sessionId: session.sessionId,
    });
  }
  return rows;
}

export function projectRecentSessions(client: Client): readonly AgentDrawerSession[] {
  const occupied = occupiedSessionIds(client.kernelPlexus.awareness);
  const rows: AgentDrawerSession[] = [];
  for (const id of Object.keys(client.projectRoot.sessions)) {
    const sessionId = id.trim();
    if (sessionId === "") continue;
    const glance = client.kernelRoot.sessions[sessionId];
    if (!isConversationOverview(glance)) continue;
    const title = fieldText(glance.title);
    const status = fieldText(glance.status);
    const current = sessionId === client.sessionId;
    // Intern stamps lastMessageAt. Title is first prompt / rename / metadata;
    // status is update_metadata. Either means a session happened.
    if (title === "" && status === "") continue;
    const unfinished = unfinishedOf(glance);
    rows.push({
      key: `session:${sessionId}`,
      sessionId,
      title: title === "" ? sessionId : title,
      status,
      lastMessageAt:
        typeof glance.lastMessageAt === "number" && Number.isFinite(glance.lastMessageAt) ? glance.lastMessageAt : 0,
      occupied: occupied.has(sessionId),
      resident: glance.resident === true,
      periodArmed: glance.periodArmed === true,
      openTurn: glance.openTurn === true,
      openToolCount: fieldCount(glance.openToolCount),
      unfinished,
      lastPrompt: fieldText(glance.lastPrompt),
      askLine: unfinished === "question" ? fieldText(glance.questionLine) : fieldText(glance.askLine),
      current,
      tempo:
        glance.asking === true || unfinished === "question"
          ? "blocked"
          : glance.midMotion === true ||
              glance.openTurn === true ||
              fieldCount(glance.openToolCount) > 0 ||
              fieldCount(glance.openCallbackCount) > 0
            ? "active"
            : "idle",
      model: fieldText(glance.model),
      mark: sessionOverviewMark({
        current,
        occupied: occupied.has(sessionId),
        resident: glance.resident === true,
        unfinished: unfinishedOf(glance),
        periodArmed: glance.periodArmed === true,
      }),
    });
  }
  rows.sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.sessionId.localeCompare(b.sessionId));
  return rows.slice(0, DRAWER_RECENT_SESSION_LIMIT);
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fieldCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function unfinishedOf(glance: {
  readonly unfinished?: string;
  readonly asking?: boolean;
  readonly midMotion?: boolean;
  readonly openTurn?: boolean;
  readonly openToolCount?: number;
  readonly periodArmed?: boolean;
}): SessionUnfinished {
  const stamped = glance.unfinished;
  switch (true) {
    case stamped === "ask":
    case stamped === "tools":
    case stamped === "turn":
    case stamped === "question":
      return stamped;
    case glance.asking === true:
      return "ask";
    case fieldCount(glance.openToolCount) > 0:
      return "tools";
    case glance.openTurn === true:
      return "turn";
    case glance.midMotion === true && glance.periodArmed !== true:
      return "tools";
    default:
      return "";
  }
}

export function sessionOverviewMark(input: {
  readonly current: boolean;
  readonly occupied: boolean;
  readonly resident: boolean;
  readonly unfinished: SessionUnfinished;
  readonly periodArmed: boolean;
}): string {
  switch (true) {
    case input.current:
      return "this session";
    case input.unfinished === "question":
      return SESSION_FACE_QUESTION;
    case input.occupied && input.unfinished === "ask":
      return SESSION_FACE_ASK;
    case input.occupied && input.unfinished !== "":
      return "active";
    case input.occupied:
      return "idle";
    case input.unfinished !== "" && input.resident:
      return SESSION_FACE_PLAY;
    case input.unfinished !== "":
      return SESSION_FACE_PAUSE;
    case input.resident && input.periodArmed:
      return "bot";
    default:
      return "";
  }
}

export function projectAgentMeter(
  client: Client,
  proj: AgentDrawerProjection = projectAgentDrawer(client),
): AgentMeterProjection | null {
  const pals = new Set(proj.collaborators.map((bot) => bot.sessionId));
  const live: string[] = [];
  for (const node of proj.calls) {
    const bag = node.kind === "program" ? node.program.children : [node.call];
    for (const call of bag) {
      if (call.completed) continue;
      if (call.tempo !== "active" && call.tempo !== "blocked") continue;
      if (call.sessionId !== "" && pals.has(call.sessionId)) continue;
      live.push(call.spec);
    }
  }
  if (live.length === 0 && proj.collaborators.length === 0) return null;
  const groups: AgentMeterGroup[] = [];
  const index = new Map<string, number>();
  for (const spec of live) {
    const name = spec.trim() === "" ? "agent" : spec;
    const at = index.get(name);
    if (at === undefined) {
      index.set(name, groups.length);
      groups.push({ spec: name, count: 1 });
    } else {
      groups[at] = { spec: name, count: groups[at]!.count + 1 };
    }
  }
  return { calls: groups, bots: proj.collaborators.map((bot) => bot.spec) };
}

function callRow(call: AgentDrawerCall, indent: number): AgentDrawerRow {
  return {
    key: call.key,
    kind: "call",
    spec: call.spec,
    recap: call.status,
    indent,
    prompt: call.prompt,
    notifies: call.notifies,
    result: call.result,
    tempo: call.tempo,
    model: call.model,
    mark: call.mark,
    lastPrompt: call.lastPrompt,
    askLine: call.askLine,
    unfinished: call.unfinished,
    current: false,
    sessionId: call.sessionId,
  };
}

function projectCall(client: Client, call: CallJob): AgentDrawerCall {
  const sessionId = call.workerSessionId.trim();
  const spec = recordString(call.args, "spec");
  const bot = call instanceof BotCallJob ? call.botName.trim() || call.contributionBotName.trim() : "";
  const face = workerFace(client, sessionId, call.completed);
  const faceName = call instanceof AgentCallJob ? fieldText(call.faceName) : "";
  return {
    key: `call:${call.toolCallId}`,
    spec: spec === "" ? (bot === "" ? face.specName || faceName || "agent" : bot) : spec,
    tempo: face.tempo,
    status: face.status,
    prompt: spawnPrompt(call),
    notifies: notifyLines(call),
    result: resultText(call),
    sessionId,
    oneShot: call instanceof AgentCallJob,
    completed: call.completed,
    model: face.model,
    lastPrompt: face.lastPrompt,
    askLine: face.askLine,
    unfinished: face.unfinished,
    mark: face.mark,
    children: kernelChildren(client, sessionId, new Set([client.sessionId])),
  };
}

function kernelChildren(client: Client, callerSessionId: string, path: ReadonlySet<string>): AgentDrawerCall[] {
  if (callerSessionId === "" || path.has(callerSessionId)) return [];
  const nextPath = new Set(path);
  nextPath.add(callerSessionId);
  const out: AgentDrawerCall[] = [];
  const bag = client.kernelRoot.agentCalls;
  for (const id of Object.keys(bag).sort()) {
    const rel = bag[id];
    if (rel == null || rel.callerSessionId !== callerSessionId) continue;
    if (nextPath.has(rel.workerSessionId.trim())) continue;
    const row = projectRelation(client, id, rel, nextPath);
    if (row != null) out.push(row);
  }
  return out;
}

function projectRelation(
  client: Client,
  id: string,
  rel: KernelAgentRelation,
  path: ReadonlySet<string>,
): AgentDrawerCall | null {
  const worker = rel.workerSessionId.trim();
  if (worker === "") return null;
  const spec = rel.spec.trim();
  const face = workerFace(client, worker, rel.completed);
  return {
    key: `call:${id}`,
    spec: spec === "" ? "agent" : spec,
    tempo: face.tempo,
    status: face.status,
    prompt: "",
    notifies: [],
    result: "",
    sessionId: worker,
    oneShot: rel.oneShot,
    completed: rel.completed,
    model: face.model,
    lastPrompt: face.lastPrompt,
    askLine: face.askLine,
    unfinished: face.unfinished,
    mark: face.mark,
    children: kernelChildren(client, worker, path),
  };
}

function workerFace(
  client: Client,
  sessionId: string,
  completed: boolean,
): {
  readonly tempo: AgentTempo;
  readonly status: string;
  readonly model: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly unfinished: SessionUnfinished;
  readonly mark: string;
  readonly specName: string;
} {
  const agent = sessionId === "" ? null : new ClientAgent(client, sessionId);
  const glance = agent?.overview ?? null;
  const unfinished = glance == null ? "" : unfinishedOf(glance);
  const tempo: AgentTempo = completed ? "idle" : (agent?.tempo ?? "active");
  return {
    tempo,
    status: agent?.status ?? "",
    model: agent?.model ?? "",
    lastPrompt: fieldText(glance?.lastPrompt),
    askLine: unfinished === "question" ? fieldText(glance?.questionLine) : fieldText(glance?.askLine),
    unfinished,
    mark: callGlanceMark({ unfinished, tempo }),
    specName: fieldText(glance?.specName) || (agent?.specName ?? ""),
  };
}

function callGlanceMark(input: { readonly unfinished: SessionUnfinished; readonly tempo: AgentTempo }): string {
  if (input.unfinished === "question") return SESSION_FACE_QUESTION;
  if (input.unfinished === "ask" || input.tempo === "blocked") return SESSION_FACE_ASK;
  if (input.tempo === "active") return "active";
  return "";
}

function projectCollaborators(client: Client): AgentDrawerCollaborator[] {
  const seen = new Set<string>();
  const out: AgentDrawerCollaborator[] = [];
  const take = (agent: ClientAgent): void => {
    if (agent.sessionId === "" || seen.has(agent.sessionId)) return;
    seen.add(agent.sessionId);
    if (!isCollaborator(client, agent)) return;
    const last = agent.lastCall;
    const spec = isConversationOverview(agent.overview)
      ? agent.title.trim() || agent.specName
      : agent.specName.trim() || agent.title;
    out.push({
      key: `bot:${agent.sessionId}`,
      sessionId: agent.sessionId,
      spec,
      tempo: agent.tempo,
      status: agent.status,
      keepAlive: agent.keepAlive,
      prompt: last == null ? "" : spawnPrompt(last),
      notifies: last == null ? [] : notifyLines(last),
      result: last == null ? "" : resultText(last),
    });
  };
  for (const agent of client.agents) take(agent);
  for (const call of client.agentCalls) {
    const id = call.workerSessionId.trim();
    if (id === "" || seen.has(id)) continue;
    take(new ClientAgent(client, id));
  }
  return out;
}

function isCollaborator(client: Client, agent: ClientAgent): boolean {
  if (agent.sessionId === client.sessionId) return false;
  if (!agent.interacted) return false;
  if (agent.oneShot) return false;
  if (agent.keepAlive) return true;
  return isConversationOverview(agent.overview) && agent.sessionId in client.projectRoot.sessions;
}

function tapeTurns(client: Client): SessionTurn[] {
  const spine: SessionTurn[] = [];
  const seen = new Set<SessionUnit>();
  let cell: SessionUnit | null = client.sessionRoot.head;
  while (cell !== null && !seen.has(cell)) {
    seen.add(cell);
    if (cell instanceof SessionTurn) spine.push(cell);
    cell = cell.turnTail;
  }
  spine.reverse();
  return spine;
}

function spawnPrompt(call: CallJob): string {
  return recordString(call.args, "message");
}

function notifyLines(call: CallJob): string[] {
  const out: string[] = [];
  for (const note of call.notifications) {
    if (isNoteClaimed(note)) continue;
    const message = note.message.trim();
    if (message !== "") out.push(message);
  }
  return out;
}

function resultText(call: CallJob): string {
  if (!call.completed) return "";
  const payload = call.observationPayload();
  if (typeof payload === "string") return payload;
  if (payload == null) return "";
  return String(payload);
}
