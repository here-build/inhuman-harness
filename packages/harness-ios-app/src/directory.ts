import { isConversationOverview } from "@inhuman.tools/harness-model";

import { projectPulse, type RowLight } from "../../harness-web-app/src/shell/light.js";
import { rowTitle } from "../../harness-web-app/src/shell/row-title.js";
import { orderSessions, shortAge } from "../../harness-web-app/src/shell/session-order.js";
import { wireAccount } from "../../harness-web-app/src/shell/wire-account.js";

/** The daemon's socket. A Simulator shares this Mac's loopback; a phone does not. */
export const SOCKET_ORIGIN = "ws://127.0.0.1:8787";

/** Search appears once a list is longer than this. */
export const SEARCH_AFTER = 8;

/** A model list shorter than this is a system menu. The page uses the same cut. */
export const MODEL_MENU_UNDER = 20;

export type Glance = {
  readonly title?: string;
  readonly status?: string;
  readonly lastPrompt?: string;
  readonly lastMessageAt?: number | null;
  readonly unfinished?: string;
  readonly openTurn?: boolean;
  readonly recipeScope?: string;
  readonly oneShot?: boolean;
  readonly askLine?: string;
  readonly questionLine?: string;
  readonly model?: string;
};

/** A connection face, enough to tell that its model failed and to say so. */
export type ConnectionFace = {
  readonly name?: string;
  readonly readyState?: string | null;
  readonly error?: string;
  readonly live?: {
    readonly models?: unknown;
    readonly identity?: unknown;
    readonly keyMask?: unknown;
    readonly account?: unknown;
  } | null;
};

export type AttentionKind = "ask" | "question" | "bad";

const BAD_STATUS = /\b(?:fail(?:ed|ure)?|error|denied|refused)\b/i;

/** The sentence for a session that failed. Null when nothing is wrong. */
export function sessionProblem(
  glance: Glance | undefined,
  connections: Readonly<Record<string, ConnectionFace | undefined>> | null | undefined,
): string | null {
  const model = text(glance?.model).trim();
  if (model !== "" && connections != null) {
    for (const spec of Object.values(connections)) {
      if (spec?.readyState !== "failed") continue;
      const models = spec.live?.models;
      if (!Array.isArray(models) || !models.includes(model)) continue;
      return wireAccount(spec, text(spec.name)).description || "The model didn’t connect.";
    }
  }
  const status = text(glance?.status).trim();
  return BAD_STATUS.test(status) ? status : null;
}

/** An ask or a question needs you. A failure is bad. A decision outranks a failure. */
export function attentionKind(
  glance: Glance | undefined,
  connections: Readonly<Record<string, ConnectionFace | undefined>> | null | undefined,
): AttentionKind | null {
  if (glance?.unfinished === "ask") return "ask";
  if (glance?.unfinished === "question") return "question";
  return sessionProblem(glance, connections) == null ? null : "bad";
}

export function attentionTone(kinds: readonly AttentionKind[]): "yellow" | "red" | "clear" {
  if (kinds.some((kind) => kind === "ask" || kind === "question")) return "yellow";
  if (kinds.includes("bad")) return "red";
  return "clear";
}

/** Sessions that need a decision or failed, grouped by project. Global follows the projects. */
export function attentionSections(
  projects: readonly { readonly path: string; readonly name: string; readonly sessionIds: readonly string[] }[],
  looseIds: readonly string[],
  kindFor: (id: string) => AttentionKind | null,
  atFor: (id: string) => number,
): WaitingSection[] {
  const placed = new Set(projects.flatMap((project) => project.sessionIds));
  const loose = looseIds.filter((id) => !placed.has(id));
  const sources = [...projects, ...(loose.length > 0 ? [{ path: "", name: "Global", sessionIds: loose }] : [])];
  const rank = (kind: AttentionKind): number => (kind === "ask" ? 0 : kind === "question" ? 1 : 2);
  const sections: WaitingSection[] = [];
  for (const source of sources) {
    const ids = source.sessionIds.filter((id) => kindFor(id) != null);
    if (ids.length === 0) continue;
    const sessionIds = [...ids].sort(
      (a, b) => rank(kindFor(a) ?? "bad") - rank(kindFor(b) ?? "bad") || atFor(b) - atFor(a),
    );
    sections.push({ path: source.path, name: source.name, sessionIds });
  }
  return sections;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Same admission as the browser rail: a conversation with a title, a status, or a prompt. */
export function isListed(glance: Glance | undefined, force = false): boolean {
  if (force) return true;
  if (!isConversationOverview(glance)) return false;
  return (
    text(glance?.title).trim() !== "" || text(glance?.status).trim() !== "" || text(glance?.lastPrompt).trim() !== ""
  );
}

export function sessionLabel(glance: Glance | undefined, liveTitle = ""): string {
  return rowTitle({ live: liveTitle, title: text(glance?.title), lastPrompt: text(glance?.lastPrompt) });
}

/** The decision, when the glance has one. Otherwise the session's own name. */
export function waitingTitle(glance: Glance | undefined, liveTitle = ""): string {
  const ask = text(glance?.askLine).trim();
  if (ask !== "") return ask;
  const question = text(glance?.questionLine).trim();
  if (question !== "") return question;
  return sessionLabel(glance, liveTitle);
}

/** Missing stamp sorts as newest, matching the browser rail. */
export function recency(glance: Glance | undefined): number {
  return glance?.lastMessageAt ?? Number.POSITIVE_INFINITY;
}

export function ageLabel(glance: Glance | undefined, now: number): string {
  return shortAge(glance?.lastMessageAt, now);
}

export function orderedIds(
  ids: readonly string[],
  lightFor: (id: string) => RowLight,
  atFor: (id: string) => number,
): string[] {
  return orderSessions(ids, lightFor, atFor);
}

export function projectStatus(lights: readonly RowLight[]): { readonly waiting: number; readonly light: RowLight } {
  return {
    waiting: lights.filter((light) => light === "waiting-for-you").length,
    light: projectPulse(lights),
  };
}

export type WaitingSection = {
  readonly path: string;
  readonly name: string;
  readonly sessionIds: readonly string[];
};

/** Waiting sessions, grouped by project. A session in no project is Global, after the projects. */
export function waitingSections(
  projects: readonly { readonly path: string; readonly name: string; readonly sessionIds: readonly string[] }[],
  looseIds: readonly string[],
  lightFor: (id: string) => RowLight,
  atFor: (id: string) => number,
): WaitingSection[] {
  const placed = new Set(projects.flatMap((project) => project.sessionIds));
  const loose = looseIds.filter((id) => !placed.has(id));
  const sources = [...projects, ...(loose.length > 0 ? [{ path: "", name: "Global", sessionIds: loose }] : [])];
  const sections: WaitingSection[] = [];
  for (const source of sources) {
    const waiting = source.sessionIds.filter((id) => lightFor(id) === "waiting-for-you");
    if (waiting.length === 0) continue;
    sections.push({ path: source.path, name: source.name, sessionIds: orderSessions(waiting, lightFor, atFor) });
  }
  return sections;
}

export function countWaiting(ids: readonly string[], lightFor: (id: string) => RowLight): number {
  const seen = new Set<string>();
  let count = 0;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (lightFor(id) === "waiting-for-you") count += 1;
  }
  return count;
}

export type BotGroup = {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly bots: readonly { readonly name: string; readonly sessionId: string }[];
};

function rosterEntries(roster: Readonly<Record<string, string>>): { name: string; sessionId: string }[] {
  return Object.entries(roster).map(([name, sessionId]) => ({ name, sessionId }));
}

export function botGroups(
  globalRoster: Readonly<Record<string, string>>,
  projects: readonly {
    readonly path: string;
    readonly name: string;
    readonly roster: Readonly<Record<string, string>>;
  }[],
): BotGroup[] {
  const groups: BotGroup[] = [];
  const globalBots = rosterEntries(globalRoster);
  if (globalBots.length > 0) groups.push({ key: "", name: "Global", path: "", bots: globalBots });
  for (const project of projects) {
    const bots = rosterEntries(project.roster);
    if (bots.length === 0) continue;
    groups.push({ key: project.path, name: project.name, path: project.path, bots });
  }
  return groups;
}

export function matchesQuery(query: string, parts: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return parts.some((part) => part.toLowerCase().includes(needle));
}

/** The command, or the path, once. The page already shows the rest inside the transcript. */
export function actLine(args: Readonly<Record<string, unknown>> | null | undefined): string {
  const command = text(args?.command).trim();
  if (command !== "") return command;
  return text(args?.path).trim();
}

export function isAccepted(result: unknown): boolean {
  return typeof result === "object" && result != null && "ok" in result && result.ok === true;
}

export type TurnVisual = {
  readonly mime: string;
  readonly bytesBase64: string;
  readonly sourcePath?: string | null;
};

export function turnParams(
  prompt: string,
  visuals?: readonly TurnVisual[],
): { readonly prompt: string; readonly visuals?: readonly TurnVisual[] } {
  if (visuals == null || visuals.length === 0) return { prompt };
  return {
    prompt,
    visuals: visuals.map((visual) => {
      const sourcePath = visual.sourcePath;
      if (typeof sourcePath !== "string" || sourcePath === "") {
        return { mime: visual.mime, bytesBase64: visual.bytesBase64 };
      }
      return { mime: visual.mime, bytesBase64: visual.bytesBase64, sourcePath };
    }),
  };
}

export function answerParams(input: {
  readonly sessionId: string;
  readonly jobId: string;
  readonly allow: boolean;
  readonly comment?: string;
}): { readonly sessionId: string; readonly jobId: string; readonly allow: boolean; readonly comment?: string } {
  const note = input.comment?.trim() ?? "";
  return {
    sessionId: input.sessionId,
    jobId: input.jobId,
    allow: input.allow,
    ...(note === "" ? {} : { comment: note }),
  };
}

export function modelParams(
  key: "connection" | "model",
  value: string,
): { readonly key: "connection" | "model"; readonly value: string; readonly remember: true } {
  return { key, value, remember: true };
}

export function mintId(): string {
  return globalThis.crypto.randomUUID();
}
