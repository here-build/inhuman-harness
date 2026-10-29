/**
 * What a tool or scheme call says, as plain data: state, identity, receipt. No
 * paint. `work-cells.ts` turns a `WorkCellFace` into layout nodes; the headless
 * eval client prints the same face as text. Nothing here may import quickdraw —
 * a helper that needs it belongs in `work-cells.ts`.
 */
import {
  ApprovableJob,
  type BlobPeek,
  documentRoot,
  FileMutateToolJob,
  type KernelRoot,
  MCPToolJob,
  type PriorText,
  ProgrammaticJob,
  reactChunks,
  SessionRoot,
  SessionTurn,
  shellTailOf,
  ToolCallJob,
} from "@inhuman.tools/harness-model";

import { agentExpandBlock } from "./agent-cover.js";
import { coverAskAnnotation, identityLine, isPathShapedName } from "./identity.js";
import { outcomeSnapOf, schemeCellState, toolCellState, type SchemeCellState, type ToolCellState } from "./liveness.js";
import { prettyResult } from "./pretty-identity.js";
import { schemePaintReceipt, type SchemePaintPart } from "./sugarcoat.js";

export type WorkCellState = ToolCellState | SchemeCellState;

export type ReceiptFace =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "stream"; readonly text: string }
  | { readonly kind: "syntax"; readonly text: string }
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "boolean"; readonly text: string }
  | { readonly kind: "parts"; readonly parts: readonly SchemePaintPart[] }
  | {
      readonly kind: "diff";
      readonly old: string;
      readonly new: string;
      readonly path: string;
      /** 1-based file line of the span. Omitted when the span is the whole file. */
      readonly lineStart?: number;
    };

export function receiptPlainText(receipt: ReceiptFace): string {
  if (receipt.kind === "none" || receipt.kind === "diff") return "";
  if (receipt.kind === "parts") return receipt.parts.map((part) => part.text).join("\n");
  return receipt.text;
}

export type WorkCellFace = {
  readonly key: string;
  readonly state: WorkCellState;
  readonly name: string;
  readonly object: string;
  readonly status: string;
  readonly caption: string;
  readonly pathShaped: boolean;
  /** Quiet server / louder action (MCP). Plain tools stay one voice Text. */
  readonly split: boolean;
  readonly agent: boolean;
  readonly pretty: boolean;
  readonly prettyBlock: string;
  /** What the worker actually answered. Empty until a reply lands. */
  readonly response: string;
  readonly indent: boolean;
  readonly collapsed: boolean;
  readonly receipt: ReceiptFace;
  /** Cover rim already names this work (`coverAskAnnotation`). */
  readonly rimNamed: boolean;
};

function stringArg(args: Readonly<Record<string, unknown>> | null, key: string): string {
  const value = args?.[key];
  return typeof value === "string" ? value : "";
}

/** Whole-file `read_file` of the same path on this turn — already on the tape when host prior did not sync. */
function priorFromTape(work: ToolCallJob, filePath: string, span: string): string | null {
  if (filePath === "") return null;
  const session = documentRoot(work);
  if (!(session instanceof SessionRoot)) return null;
  const turn = session.head;
  if (!(turn instanceof SessionTurn)) return null;
  for (const chunk of reactChunks(turn)) {
    if (!(chunk instanceof ToolCallJob) || chunk.name !== "read_file" || chunk === work) continue;
    const args = chunk.args;
    if (stringArg(args, "path") !== filePath) continue;
    if (args?.offset !== undefined || args?.limit !== undefined) continue;
    const text = resultText(chunk);
    if (text !== "" && (span === "" || containsSpan(text, span))) return text;
  }
  return null;
}

/**
 * The prior stamped on the job: inline, or the reference to its blob. Field reads, not
 * `instanceof` — duplicate class identity must not drop the file.
 */
function stampedPrior(work: ToolCallJob): PriorText | null {
  const host = work as { prior?: PriorText | null; priorContent?: unknown };
  if (host.prior !== undefined) return host.prior;
  return typeof host.priorContent === "string" ? { kind: "inline", text: host.priorContent } : null;
}

/**
 * Host prior text. A blob prior whose text the cache does not hold yet reads as no prior, so the
 * face is the one a replica without the prior paints, and asks the cache for the text.
 */
function priorOf(work: ToolCallJob, filePath: string, span: string, blobs?: BlobPeek): string | null {
  const stamped = stampedPrior(work);
  let text: string | null = null;
  if (stamped?.kind === "inline") text = stamped.text;
  else if (stamped?.kind === "blob") {
    const { sha256 } = stamped.blob;
    text = blobs?.peek(sha256) ?? null;
    if (text === null) blobs?.want(sha256);
  }
  return text ?? priorFromTape(work, filePath, span);
}

function containsSpan(file: string, span: string): boolean {
  if (span === "" || file.includes(span)) return true;
  return file.replaceAll("\r\n", "\n").includes(span.replaceAll("\r\n", "\n"));
}

function spanLineStart(file: string | null | undefined, span: string): number | undefined {
  if (file == null || span === "") return undefined;
  const normalizedFile = file.replaceAll("\r\n", "\n");
  const normalizedSpan = span.replaceAll("\r\n", "\n");
  let idx = normalizedFile.indexOf(normalizedSpan);
  if (idx === -1) {
    const first = normalizedSpan.split("\n")[0] ?? "";
    if (first === "" || first === normalizedSpan) return undefined;
    idx = normalizedFile.indexOf(first);
  }
  if (idx === -1) return undefined;
  let line = 1;
  for (let i = 0; i < idx; i++) if (normalizedFile[i] === "\n") line++;
  return line <= 1 ? undefined : line;
}

/** Literal insert. String.replace treats `$` in new_string as a substitution pattern. */
function replaceSpan(haystack: string, needle: string, replacement: string, all: boolean): string {
  if (all) return haystack.split(needle).join(replacement);
  const at = haystack.indexOf(needle);
  return at === -1 ? haystack : haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

function editFileDiff(work: ToolCallJob, blobs?: BlobPeek): ReceiptFace {
  const args = work.args;
  const old = stringArg(args, "old_string");
  const next = stringArg(args, "new_string");
  if (old === "" && next === "") return { kind: "none" };
  const filePath = stringArg(args, "path");
  const replaceAll = args?.replace_all === true;
  const prior = priorOf(work, filePath, old, blobs);
  if (prior !== null && old !== "" && prior.includes(old)) {
    return {
      kind: "diff",
      old: prior,
      new: replaceSpan(prior, old, next, replaceAll),
      path: filePath,
    };
  }
  const stampedLine = (work as { priorLineStart?: unknown }).priorLineStart;
  const lineStart =
    spanLineStart(prior, old) ??
    (typeof stampedLine === "number" && Number.isFinite(stampedLine) && stampedLine > 1 ? stampedLine : undefined);
  return {
    kind: "diff",
    old,
    new: next,
    path: filePath,
    ...(lineStart === undefined ? {} : { lineStart }),
  };
}

/** Create = empty-old. Overwrite = stored prior text. Binary / unstamped exist is not a create Diff. */
function writeFileDiff(work: ToolCallJob, blobs?: BlobPeek): ReceiptFace {
  const args = work.args;
  const next = stringArg(args, "content");
  const filePath = stringArg(args, "path");
  if (next === "") return { kind: "none" };
  const prior = priorOf(work, filePath, "", blobs);
  if (prior !== null) {
    return { kind: "diff", old: prior, new: next, path: filePath };
  }
  if (work instanceof FileMutateToolJob && work.existed === true) return { kind: "none" };
  return { kind: "diff", old: "", new: next, path: filePath };
}

function fileHintsOf(work: ProgrammaticJob): { readonly path: string; readonly text: string }[] {
  const hints: { path: string; text: string }[] = [];
  for (const inner of work.toolCalls) {
    if (inner.name !== "read_file") continue;
    const text = resultText(inner);
    const path = stringArg(inner.args, "path");
    if (text === "" || path === "") continue;
    hints.push({ path, text });
  }
  return hints;
}

function resultText(work: ToolCallJob | ProgrammaticJob): string {
  const snap = outcomeSnapOf(work);
  if (snap === null) return "";
  if (typeof snap.text === "string" && snap.text !== "") return snap.text;
  if ("value" in snap) {
    try {
      return typeof snap.value === "string" ? snap.value : JSON.stringify(snap.value);
    } catch {
      return String(snap.value);
    }
  }
  return "";
}

function shellReceipt(work: ToolCallJob): string {
  const snap = outcomeSnapOf(work);
  const value = snap?.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as { stdout?: unknown; stderr?: unknown };
    const parts: string[] = [];
    if (typeof rec.stdout === "string" && rec.stdout !== "") parts.push(rec.stdout);
    if (typeof rec.stderr === "string" && rec.stderr !== "") parts.push(rec.stderr);
    if (parts.length > 0) return parts.join("\n");
  }
  return resultText(work);
}

/** `applyDenyReceipt` copies this into `outcomeJson.text`. The tape shows that copy once. */
function denialExplanation(work: ToolCallJob): string | null {
  const snap = outcomeSnapOf(work);
  const vote = work.policyResult;
  const denied =
    snap?.code === "policy_denied" ||
    ((vote === "block" || vote === "deny") && snap?.ok !== true && work.humanApprove !== true);
  if (!denied) return null;
  const policy = (work.policyMessage ?? "").trim();
  const outcome = resultText(work);
  const outcomeTrim = outcome.trim();
  if (policy !== "" && (outcomeTrim === "" || outcomeTrim === policy)) return policy;
  return outcomeTrim === "" ? "" : outcome;
}

function shellDenialLine(text: string): ReceiptFace {
  return { kind: "parts", parts: [{ kind: "text", text }] };
}

/** Suggestion Diff from args. Pin uses this even after `approved`, while tape live does not. */
export function mutateSuggestionReceipt(work: ToolCallJob, blobs?: BlobPeek): ReceiptFace {
  if (work.name === "edit_file") return editFileDiff(work, blobs);
  if (work.name === "write_file") return writeFileDiff(work, blobs);
  return { kind: "none" };
}

function receiptFace(work: ToolCallJob | ProgrammaticJob, state: WorkCellState, blobs?: BlobPeek): ReceiptFace {
  if (state === "live") {
    if (work instanceof ToolCallJob && work.name === "shell") {
      const tail = shellTailOf(work);
      if (tail !== null && tail.text !== "") return { kind: "stream", text: tail.text };
    }
    return { kind: "none" };
  }
  if (state === "ask") {
    if (work instanceof ToolCallJob) {
      const suggestion = mutateSuggestionReceipt(work, blobs);
      if (suggestion.kind !== "none") return suggestion;
    }
    if (work instanceof ToolCallJob && work.name === "shell") {
      const policy = work.policyMessage ?? "";
      return policy === "" ? { kind: "none" } : { kind: "text", text: policy };
    }
    if (work instanceof MCPToolJob) {
      return { kind: "none" };
    }
    return { kind: "none" };
  }
  if (work instanceof ProgrammaticJob) {
    return schemePaintReceipt(outcomeSnapOf(work), fileHintsOf(work));
  }
  const explanation = denialExplanation(work);
  if (explanation !== null) {
    if (explanation === "") return { kind: "none" };
    return work.name === "shell" ? shellDenialLine(explanation) : { kind: "text", text: explanation };
  }
  if (work.name === "edit_file") return editFileDiff(work, blobs);
  if (work.name === "write_file") {
    const diff = writeFileDiff(work, blobs);
    if (diff.kind !== "none") return diff;
    const text = resultText(work);
    return text === "" ? { kind: "none" } : { kind: "text", text };
  }
  if (work.name === "read_file") {
    // The tape row is the path only. File text is not a receipt.
    return { kind: "none" };
  }
  if (work.name === "shell") {
    const sealed = shellReceipt(work);
    return sealed === "" ? { kind: "none" } : { kind: "text", text: sealed };
  }
  const serialized = prettyResult(work, outcomeSnapOf(work));
  if (serialized !== null && serialized !== "") {
    return serialized.includes("**") || serialized.includes("`") || serialized.includes("![")
      ? { kind: "markdown", text: serialized }
      : { kind: "text", text: serialized };
  }
  const text = resultText(work);
  return text === "" ? { kind: "none" } : { kind: "text", text };
}

/** Kernel glance overlay for a named-agent call. `status` is the dim suffix. */
export type CallStatus = {
  readonly status?: string;
  readonly model?: string;
};

function faceText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The worker's reply, not the prompt we sent. Failures stay the gutter. */
function agentResponseText(work: ToolCallJob | ProgrammaticJob): string {
  if (!(work instanceof ToolCallJob)) return "";
  const snap = outcomeSnapOf(work);
  if (snap === null || snap.ok !== true) return "";
  if ("value" in snap && snap.value != null) {
    if (typeof snap.value === "string") return snap.value.trim();
    try {
      return JSON.stringify(snap.value, null, 2);
    } catch {
      return String(snap.value);
    }
  }
  return typeof snap.text === "string" ? snap.text.trim() : "";
}

export function workCellFace(
  work: ToolCallJob | ProgrammaticJob,
  key: string,
  indent: boolean,
  collapsed = true,
  glance: CallStatus | string = "",
  kernel?: KernelRoot | null,
  blobs?: BlobPeek,
): WorkCellFace {
  const jobState = work instanceof ProgrammaticJob ? schemeCellState(work) : toolCellState(work);
  const line = identityLine(work, kernel);
  const comment =
    work instanceof ApprovableJob && work.approvalComment != null && work.approvalComment !== ""
      ? work.approvalComment
      : "";
  const agent = line.agent === true;
  const pretty = line.pretty === true && !agent;
  const tape = typeof glance === "string" ? { status: glance } : glance;
  return {
    key,
    // Live bag with an open inner paints sealed chrome, not a spinner.
    state:
      work instanceof ProgrammaticJob &&
      jobState === "live" &&
      work.toolCalls.some((inner) => {
        const innerState = toolCellState(inner);
        return innerState === "live" || innerState === "ask";
      })
        ? "ok"
        : jobState,
    name: faceText(line.name),
    object: agent ? faceText(tape.status).trim() : faceText(line.object),
    status: [faceText(line.status), comment].filter((part) => part !== "").join("  "),
    caption: faceText(line.caption),
    pathShaped: !pretty && work instanceof ToolCallJob && isPathShapedName(faceText(work.name)),
    split: !pretty && !agent && work instanceof MCPToolJob,
    agent,
    pretty,
    prettyBlock: agent ? agentExpandBlock(faceText(line.block), faceText(tape.model)) : faceText(line.block),
    response: agent ? agentResponseText(work) : "",
    indent,
    collapsed,
    receipt: receiptFace(work, jobState, blobs),
    rimNamed: coverAskAnnotation(work, { kernel }) !== undefined,
  };
}
