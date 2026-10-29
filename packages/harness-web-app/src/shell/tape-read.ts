import {
  type BlobPeek,
  CallJob,
  clampChars,
  CONTEXT_NEED_TOOL_NAME,
  CompletionJob,
  FailureOutcome,
  ProgrammaticJob,
  SESSION_DESCRIPTION_MAX_CHARS,
  SCHEME_REPL_TOOL_NAME,
  SESSION_TITLE_MAX_CHARS,
  SessionTurn,
  type SessionRoot,
  ToolCallJob,
  TurnNotificationChunk,
  UPDATE_METADATA_TOOL_NAME,
  type SessionOverview,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";

import { displayPath } from "./read-line.js";
import { schemeHostCallsOnly } from "./scheme-unwrap.js";
import { reduceSession, type FileFact, type SessionEvent } from "./session-reducer.js";
import {
  fileFact,
  outcomeOf,
  schemeReceipt,
  schemeSummary,
  toolReceipt,
  type ToolBody,
  type ToolOutcome,
} from "./tool-receipt.js";

export type ToolCell = {
  readonly kind: "tool";
  readonly id: string;
  /** The verb and its object. The outcome is a separate fact, not text. */
  readonly summary: string;
  readonly outcome: ToolOutcome;
  readonly body: ToolBody;
  readonly file?: FileFact;
  /** A call of the read family. Presence, not a successful fact, is what folds the row. */
  readonly look?: Look;
  readonly edits?: { readonly mutationIds: readonly string[]; readonly roundIds: readonly string[] };
  /** Inner calls of a scheme invocation. They are not sibling tape rows. */
  readonly nested?: readonly TapeCell[];
  /** A program that made calls: its dataflow graph opens from here, its inner jobs give the graph's cards their state. */
  readonly program?: ProgrammaticJob;
};

/** How the tape says what a read-family call looked at: `Reading`, `Searching for`, `Finding`. */
export type LookVerb = "read" | "search" | "find";

/** What one read-family call (tool-behavior's `readCall` set) looked at, before display paths. */
type Look = {
  readonly verb: LookVerb;
  /** A file or directory path to read; the pattern or query to search. */
  readonly target: string;
  readonly dir: boolean;
  /** Where a search looked, raw. */
  readonly scope: string;
};

export type LookItem = {
  readonly id: string;
  readonly verb: LookVerb;
  /** The display path (a directory ends in `/`), or the pattern or query. */
  readonly label: string;
  /** The raw path to open. Empty for a search, which opens its result. */
  readonly path: string;
  /** Where a search looked, as a display path. */
  readonly scope?: string;
  /** What the sidebar shows: the file read in full, the listing, the matches; the failure on a failed call. */
  readonly text?: string;
  readonly outcome: ToolOutcome;
};

/** A run of read-family calls, said as one ambient line per verb. */
export type ReadLineCell = {
  readonly kind: "reads";
  readonly id: string;
  readonly items: readonly LookItem[];
};

export type TapeBodyCell = Exclude<TapeCell, { kind: "progress" | "round" | "agent" | "settle" }>;

/** How a spawned agent's call ended. A running background call already holds an `ok` ack, so this reads the call's own outcome. */
export type AgentOutcome = "live" | "ok" | "failed" | "cancelled";

/** An agent this session spawned. Its note lives beside the tape from the spawn until the result comes back. */
export type AgentCell = {
  readonly kind: "agent";
  readonly id: string;
  readonly sessionId: string;
  readonly spec: string;
  /** The spawn message's first line; the worker's own title wins when it has one. */
  readonly message: string;
  /** A background call returns at once; its result comes back later as a notification. */
  readonly background: boolean;
  readonly outcome: AgentOutcome;
};

export type ProgressItem = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
};

export type TapeCell =
  | { readonly kind: "round"; readonly id: string; readonly model?: string; readonly connection?: string }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
      /** Picture identity. Omitted on a hand-built cell that has no pictures. */
      readonly visuals?: readonly UserVisualIdentity[];
    }
  | { readonly kind: "speech"; readonly id: string; readonly text: string; readonly thought: string }
  | ToolCell
  | ReadLineCell
  | AgentCell
  /** Background results this round took in: where those agents' spans close. */
  | { readonly kind: "settle"; readonly id: string; readonly calls: readonly string[] }
  | {
      readonly kind: "progress";
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly items: readonly ProgressItem[];
    };

export function turnsOldestFirst(root: SessionRoot): SessionTurn[] {
  const stack: SessionTurn[] = [];
  let cursor: unknown = root.head;
  while (cursor instanceof SessionTurn) {
    stack.push(cursor);
    cursor = cursor.turnTail;
  }
  stack.reverse();
  return stack;
}

export { NEW_CONVERSATION, rowTitle } from "./row-title.js";

/** `Image N · mime · width×height`, plus a resize and a source path when the turn stored them. */
export function userPictureLine(index: number, visual: UserVisualIdentity): string {
  const parts = [`Image ${index + 1}`, visual.mime, `${visual.width}×${visual.height}`];
  if (visual.resizedFrom != null) {
    parts.push(`resized from ${visual.resizedFrom.width}×${visual.resizedFrom.height}`);
  }
  if (visual.sourcePath != null && visual.sourcePath !== "") parts.push(visual.sourcePath);
  return parts.join(" · ");
}

/**
 * One turn, reduced on its own. A later turn starts from a cleared file map.
 * `blobs` serves the text a file mutation's prior keeps in a blob; omitted, the dial's seated cache does.
 */
export function projectTurn(turn: SessionTurn, projectPath: string, blobs?: BlobPeek): TapeCell[] {
  const cells: SessionEvent[] = [{ kind: "turn", id: turn.uuid }];
  const prompt = String(turn.prompt).trim();
  const visuals = turn.visuals;
  if (prompt !== "" || visuals.length > 0) {
    cells.push({ kind: "user", id: `${turn.uuid}:user`, text: prompt, visuals });
  }
  const tools: ToolCallJob[] = [];
  const subjects = new Map<string, string>();
  let roundId = `${turn.uuid}:round`;
  let roundModel = "";
  let roundConnection = "";
  let roundCells: TapeCell[] = [];
  const flushRound = (): void => {
    if (roundCells.length === 0) return;
    cells.push({ kind: "round", id: roundId, model: roundModel, connection: roundConnection });
    // Metadata describes the entire completion round, even when its tool
    // runs last or is nested inside a Scheme program. Last update wins.
    const marks = roundCells.filter((cell) => cell.kind === "progress");
    const merged = mergeProgress(marks);
    if (merged != null) cells.push({ ...merged, id: `${roundId}:title` });
    cells.push(...roundCells.filter((cell) => cell.kind !== "progress"));
    roundCells = [];
  };
  for (const chunk of [...turn.doneWork, ...turn.queue]) {
    try {
      projectChunk(chunk);
    } catch (error) {
      // One unreadable job is one failed row, not a blank tape.
      roundCells.push({
        kind: "tool",
        id: chunk.uuid,
        summary: "unreadable step",
        outcome: "failed",
        body: { kind: "text", text: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  // A turn that broke says why, as a failed row at the end of its tape.
  if (turn.broke !== "") {
    roundCells.push({
      kind: "tool",
      id: `${turn.uuid}:broke`,
      summary: "turn stopped",
      outcome: "failed",
      body: { kind: "text", text: turn.broke },
    });
  }
  flushRound();
  return foldReads(reduceSession(cells, projectPath), projectPath);

  function projectChunk(chunk: (typeof turn.doneWork)[number]): void {
    if (chunk instanceof CompletionJob) {
      flushRound();
      roundId = chunk.uuid;
      roundModel = chunk.expectation.model.trim();
      roundConnection = chunk.expectation.connectionId;
      const text = chunk.expectation.responseText.trim();
      const thought = chunk.expectation.responseThought.trim();
      if (text !== "" || thought !== "") {
        roundCells.push({ kind: "speech", id: chunk.uuid, text, thought });
      }
    } else if (chunk instanceof ToolCallJob) {
      pushTool(roundCells, chunk, tools, projectPath, subjects, blobs);
    } else if (chunk instanceof ProgrammaticJob) {
      const nested: TapeCell[] = [];
      for (const tool of chunk.toolCalls) pushTool(nested, tool, tools, projectPath, subjects, blobs);
      // A program that only signals context_need has no tape row.
      if (chunk.toolCalls.length > 0 && chunk.toolCalls.every((tool) => tool.name === CONTEXT_NEED_TOOL_NAME)) {
        return;
      }
      const admitted = new Set(chunk.toolCalls.map((tool) => tool.name));
      if (chunk.toolName === SCHEME_REPL_TOOL_NAME && nested.length > 0 && schemeHostCallsOnly(chunk.expr, admitted)) {
        roundCells.push(...nested);
        return;
      }
      const nestedMark = mergeProgress(nested.filter((cell) => cell.kind === "progress"));
      if (nestedMark != null) roundCells.push(nestedMark);
      // An agent the program spawned is the round's, like its progress: it lives beside the tape, not in the receipt.
      roundCells.push(...nested.filter((cell) => cell.kind === "agent"), {
        kind: "tool",
        id: chunk.uuid,
        summary: schemeSummary(chunk),
        outcome: outcomeOf(chunk.completed, chunk.outcomeSnap),
        body: schemeReceipt(chunk),
        nested: nested.filter((cell) => cell.kind !== "agent"),
        ...(chunk.toolCalls.length > 0 ? { program: chunk } : {}),
      });
    } else if (chunk instanceof TurnNotificationChunk) {
      const calls = chunk.notifications
        .filter((note) => note.result && note.parent instanceof CallJob)
        .map((note) => (note.parent as CallJob).uuid);
      if (calls.length > 0) roundCells.push({ kind: "settle", id: chunk.uuid, calls });
    }
  }
}

export function tapeCells(root: SessionRoot, blobs?: BlobPeek): TapeCell[] {
  return turnsOldestFirst(root).flatMap((turn) => projectTurn(turn, root.path, blobs));
}

/** Title, task, and goal updates share one progress mark. Empty updates stay off the tape. */
export function metadataMark(job: ToolCallJob): {
  readonly title: string;
  readonly description: string;
  readonly items: readonly ProgressItem[];
} | null {
  if (job.name !== UPDATE_METADATA_TOOL_NAME) return null;
  const args = job.args;
  if (args == null || typeof args.current_turn_title !== "string") return null;
  const title = clampChars(args.current_turn_title.trim(), SESSION_TITLE_MAX_CHARS);
  if (title === "") return null;
  const raw = args.current_turn_description;
  const description = typeof raw === "string" ? clampChars(raw.trim(), SESSION_DESCRIPTION_MAX_CHARS) : "";
  return { title, description, items: [] };
}

const TASK_TOOLS = new Set(["task__create", "task__start", "task__drop", "task__after", "task__validate"]);
const GOAL_TOOLS = new Set(["goal__set", "goal__clear"]);

/** A task or goal call is a progress item. Anything else stays a tape row. */
export function progressItem(job: ToolCallJob, subjects: ReadonlyMap<string, string> = new Map()): ProgressItem | null {
  if (TASK_TOOLS.has(job.name)) return taskItem(job, subjects);
  if (GOAL_TOOLS.has(job.name)) return goalItem(job);
  return null;
}

function taskItem(job: ToolCallJob, subjects: ReadonlyMap<string, string>): ProgressItem | null {
  const id = job.argString("taskId").trim();
  const subject = textArg(job, "subject");
  const named = subject !== "" ? subject : (subjects.get(id) ?? "");
  const label = named !== "" ? named : id;
  if (label === "") return null;
  if (job.name === "task__create") return { id: job.uuid, label, detail: textArg(job, "description") };
  if (job.name === "task__start") return { id: job.uuid, label, detail: "in progress" };
  if (job.name === "task__drop") return { id: job.uuid, label, detail: dropped(textArg(job, "reason")) };
  if (job.name === "task__after") {
    const after = job.argString("after").trim();
    return { id: job.uuid, label, detail: after === "" ? "waiting" : `after ${after}` };
  }
  return { id: job.uuid, label, detail: "done" };
}

function goalItem(job: ToolCallJob): ProgressItem | null {
  if (job.name === "goal__clear") return { id: job.uuid, label: "Goal", detail: "cleared" };
  const text = textArg(job, "text");
  if (text === "") return null;
  return { id: job.uuid, label: "Goal", detail: text };
}

function dropped(reason: string): string {
  return reason === "" ? "dropped" : `dropped · ${reason}`;
}

function textArg(job: ToolCallJob, key: string): string {
  const value = job.args?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** One note per round. The latest title wins; task and goal lines accumulate in call order. */
export function mergeProgress(
  marks: readonly Extract<TapeCell, { kind: "progress" }>[],
): Extract<TapeCell, { kind: "progress" }> | null {
  let title = "";
  let description = "";
  const items: ProgressItem[] = [];
  for (const mark of marks) {
    if (mark.title !== "") {
      title = mark.title;
      description = mark.description;
    }
    items.push(...mark.items);
  }
  const head = marks.at(0);
  if (head === undefined || (title === "" && items.length === 0)) return null;
  return { kind: "progress", id: head.id, title, description, items };
}

/** Consecutive read-family rows collapse into one line; the same look twice is said once. Any other tool splits the run. */
function foldReads(cells: readonly TapeCell[], projectPath: string): TapeCell[] {
  const folded: TapeCell[] = [];
  let run: LookItem[] = [];
  const seen = new Set<string>();
  const flush = (): void => {
    const head = run.at(0);
    if (head !== undefined) folded.push({ kind: "reads", id: head.id, items: run });
    run = [];
    seen.clear();
  };
  for (const cell of cells) {
    if (cell.kind === "tool" && cell.look != null) {
      const item = lookItem(cell, cell.look, projectPath);
      const key = `${item.verb}\0${item.label}\0${item.scope ?? ""}`;
      if (!seen.has(key)) run.push(item);
      seen.add(key);
      continue;
    }
    flush();
    if (cell.kind === "tool") {
      const nested = cell.nested == null ? cell : { ...cell, nested: foldReads(cell.nested, projectPath) };
      folded.push(shownDiff(nested, projectPath));
    } else {
      folded.push(cell);
    }
  }
  flush();
  return folded;
}

function lookItem(cell: ToolCell, look: Look, projectPath: string): LookItem {
  const shown = look.target === "" ? "." : displayPath(projectPath, look.target);
  const label = !look.dir ? shown : shown === "." || shown === "" ? "./" : shown.endsWith("/") ? shown : `${shown}/`;
  const scope = look.scope === "" ? "" : displayPath(projectPath, look.scope);
  // A full read carries its bytes; a partial one opens from disk. A listing, matches, or failure is the result text.
  const body = cell.body;
  const result = body.kind === "text" || body.kind === "markdown" || body.kind === "code" ? body.text : "";
  const text =
    cell.outcome === "ok" && look.verb === "read" && !look.dir
      ? cell.file?.kind === "read"
        ? cell.file.content
        : undefined
      : result === ""
        ? undefined
        : result;
  return {
    id: cell.id,
    verb: look.verb,
    label: look.verb === "read" ? label : look.target,
    path: look.verb === "read" ? look.target || "." : "",
    ...(scope === "" || scope === "." ? {} : { scope }),
    ...(text === undefined ? {} : { text }),
    outcome: cell.outcome,
  };
}

/** The read family, as tool-behavior guards it: these calls only look. */
function lookOf(job: ToolCallJob): Look | undefined {
  const scope = job.argString("cwd") || job.argString("path");
  const search = (verb: LookVerb, target: string): Look | undefined =>
    target.trim() === "" ? undefined : { verb, target, dir: false, scope };
  switch (job.name) {
    case "read_file": {
      const path = job.argString("path");
      return path === "" ? undefined : { verb: "read", target: path, dir: false, scope: "" };
    }
    case "list_dir":
      return { verb: "read", target: job.argString("path"), dir: true, scope: "" };
    case "grep":
      return search("search", job.argString("pattern"));
    case "glob":
      return search("find", job.argString("pattern"));
    case "fff_search":
      return search("find", job.argString("query"));
    default:
      return undefined;
  }
}

/** Display only. The reducer's file key stays the raw path. */
function shownDiff(cell: ToolCell, projectPath: string): ToolCell {
  if (cell.body.kind !== "diff") return cell;
  return { ...cell, body: { ...cell.body, path: displayPath(projectPath, cell.body.path) } };
}

function pushTool(
  cells: TapeCell[],
  job: ToolCallJob,
  tools: ToolCallJob[],
  projectPath: string,
  subjects: Map<string, string>,
  blobs?: BlobPeek,
): void {
  if (job instanceof CallJob) {
    cells.push(agentCell(job));
    return;
  }
  const mark = metadataMark(job);
  if (mark != null) {
    cells.push({ kind: "progress", id: job.uuid, ...mark });
    return;
  }
  const item = progressItem(job, subjects);
  if (item != null) {
    const id = job.argString("taskId").trim();
    const subject = textArg(job, "subject");
    if (id !== "" && subject !== "") subjects.set(id, subject);
    cells.push({ kind: "progress", id: job.uuid, title: "", description: "", items: [item] });
    return;
  }
  if (
    job.name === UPDATE_METADATA_TOOL_NAME ||
    job.name === CONTEXT_NEED_TOOL_NAME ||
    TASK_TOOLS.has(job.name) ||
    GOAL_TOOLS.has(job.name)
  ) {
    return;
  }
  const look = lookOf(job);
  cells.push({
    kind: "tool",
    id: job.uuid,
    summary: toolSummary(job),
    outcome: outcomeOf(job.completed, job.outcomeSnap),
    body: toolReceipt(job, tools, projectPath, blobs),
    file: fileFact(job, blobs),
    ...(look === undefined ? {} : { look }),
  });
  tools.push(job);
}

/** The verb and its object, shared by the tape row and the ask cover. */
export function toolSummary(job: ToolCallJob): string {
  const args = job.args;
  const object = firstString(args, ["command", "path", "file_path", "pattern", "query", "url"]);
  return object === "" ? job.name : `${job.name} ${object}`;
}

function firstString(args: Readonly<Record<string, unknown>> | null, keys: readonly string[]): string {
  if (args == null) return "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

export { type ToolBody } from "./tool-receipt.js";

export function agentCell(job: CallJob): AgentCell {
  const message = job.argString("message");
  return {
    kind: "agent",
    id: job.uuid,
    sessionId: job.workerSessionId.trim(),
    spec: job.argString("spec").trim(),
    message:
      message
        .split(/\r?\n/)
        .find((line) => line.trim() !== "")
        ?.trim() ?? "",
    background: job.background,
    outcome: !job.completed
      ? "live"
      : job.cancelled
        ? "cancelled"
        : job.outcome instanceof FailureOutcome
          ? "failed"
          : "ok",
  };
}

export type AgentState = AgentOutcome | "asking";

export type AgentFace = {
  readonly name: string;
  readonly model: string;
  readonly task: string;
  readonly status: string;
  readonly state: AgentState;
};

/** The note: who, on which model, doing what, and how it is going. The live half is the kernel's glance of the worker. */
export function agentFace(cell: AgentCell, glance: SessionOverview | null): AgentFace {
  const asking =
    cell.outcome === "live" &&
    glance != null &&
    (glance.asking || glance.unfinished === "ask" || glance.unfinished === "question");
  const state: AgentState = asking ? "asking" : cell.outcome;
  // A settled agent says nothing more: its bar is the outcome.
  const status =
    state === "asking"
      ? glance?.unfinished === "question"
        ? glance.questionLine.trim() || "has a question"
        : glance?.askLine.trim() || "awaiting approval"
      : state === "live"
        ? (glance?.status.trim() ?? "")
        : "";
  return {
    name: cell.spec || glance?.specName.trim() || "agent",
    model: glance?.model.trim() ?? "",
    task: glance?.title.trim() || cell.message,
    status,
    state,
  };
}
