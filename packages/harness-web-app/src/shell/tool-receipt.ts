import { type BlobPeek, FileMutateToolJob, ProgrammaticJob, ToolCallJob } from "@inhuman.tools/harness-model";
import { workspacePath } from "@inhuman.tools/harness-model/session";

import { blobs as seatedBlobs } from "./blob-cache.js";
import { guessLang, langFromPath } from "./lang.js";
import { displayPath } from "./read-line.js";
import type { FileFact } from "./session-reducer.js";

export type ToolPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly lang: string };

export type ToolBody =
  | { readonly kind: "empty" }
  | ToolPart
  | {
      readonly kind: "diff";
      readonly oldText: string;
      readonly newText: string;
      readonly path: string;
      readonly lineStart?: number;
    }
  | { readonly kind: "parts"; readonly parts: readonly ToolPart[] }
  | {
      readonly kind: "shell";
      readonly command: string;
      /** Relative inside the project, absolute outside it. Absent when the call is the project directory. */
      readonly directory?: string;
      /** Stdout and stderr, VT sequences included. */
      readonly output: string;
      readonly exitCode?: number;
    }
  | {
      readonly kind: "fail-line";
      readonly verb: "overwrite" | "write" | "edit";
      readonly path: string;
      readonly label: string;
      readonly detail: string;
    };

/** `blobs` defaults to the cache the dial seated; a prior held in a blob reads as null until its text lands. */
export function fileFact(job: ToolCallJob, blobs: BlobPeek | undefined = seatedBlobs()): FileFact | undefined {
  const path = job.argString("path");
  if (path === "") return undefined;
  if (job.name === "read_file") {
    if (
      !job.completed ||
      job.outcomeSnap?.ok !== true ||
      job.args?.offset !== undefined ||
      job.args?.limit !== undefined
    )
      return undefined;
    const snap = job.outcomeSnap;
    const content =
      typeof snap.text === "string" ? snap.text : "value" in snap && typeof snap.value === "string" ? snap.value : null;
    return content == null || isClippedRead(content) ? undefined : { kind: "read", path, content };
  }
  if (!(job instanceof FileMutateToolJob)) return undefined;
  if (job.name !== "edit_file" && job.name !== "write_file") return undefined;
  const args = job.args;
  if (args == null) return undefined;
  const operation =
    job.name === "write_file"
      ? typeof args.content === "string"
        ? { kind: "write" as const, content: args.content }
        : null
      : typeof args.old_string === "string" && typeof args.new_string === "string"
        ? {
            kind: "edit" as const,
            oldText: args.old_string,
            newText: args.new_string,
            replaceAll: args.replace_all === true,
          }
        : null;
  if (operation == null) return undefined;
  const status =
    job.outcomeSnap?.ok === false ? "failed" : job.completed && job.outcomeSnap?.ok === true ? "applied" : "pending";
  return {
    kind: "mutation",
    path,
    operation,
    status,
    // Only an applied mutation replays from its prior; a pending or failed one has no use for the bytes.
    prior: stampedPrior(job, blobs, status === "applied"),
    existed: job.existed,
    receipt: resultText(job),
    lineStart: stampedLine(job),
  };
}

/**
 * `blobs` defaults to the cache the dial seated. A diff whose prior text is still in a blob paints without it,
 * as for a replica that never had the prior, until the text lands.
 */
export function toolReceipt(
  job: ToolCallJob,
  reads: readonly ToolCallJob[],
  projectPath = "",
  blobs: BlobPeek | undefined = seatedBlobs(),
): ToolBody {
  if (job.name === "shell") return shellBody(job, projectPath);
  const denial = denialText(job);
  if (denial !== null) return denial === "" ? { kind: "empty" } : { kind: "text", text: denial };
  if ((job.name === "edit_file" || job.name === "write_file") && job.outcomeSnap?.ok === false) {
    return failLine(job, projectPath);
  }
  if ((job.name === "edit_file" || job.name === "write_file") && !(job instanceof FileMutateToolJob))
    return generic(job);
  if (job.name === "edit_file") return editDiff(job, reads, blobs) ?? generic(job);
  if (job.name === "write_file") return writeDiff(job, reads, blobs) ?? generic(job);
  if (job.name === "read_file") return readBody(job);
  return generic(job);
}

/** What the program says it does: its description, else its first line. */
export function schemeHead(job: ProgrammaticJob): string {
  const args = job.args;
  const description = args != null && typeof args.description === "string" ? args.description.trim() : "";
  return description !== "" ? description : firstLine(job.expr);
}

export function schemeSummary(job: ProgrammaticJob): string {
  const head = schemeHead(job);
  const name = job.toolName.trim() === "" ? "scheme_repl" : job.toolName;
  return head === "" ? name : `${name} ${head}`;
}

export function schemeReceipt(job: ProgrammaticJob): ToolBody {
  const parts: ToolPart[] = [];
  if (job.expr.trim() !== "") parts.push({ kind: "code", text: job.expr, lang: "scm" });
  parts.push(...schemeResult(job));
  return pack(parts);
}

function editDiff(job: ToolCallJob, reads: readonly ToolCallJob[], blobs: BlobPeek | undefined): ToolBody | null {
  const oldText = job.argString("old_string");
  const newText = job.argString("new_string");
  if (oldText === "" && newText === "") return null;
  const path = job.argString("path");
  const prior = priorOf(job, path, oldText, reads, blobs);
  if (prior !== null && oldText !== "" && containsSpan(prior, oldText)) {
    return {
      kind: "diff",
      oldText: prior,
      newText: replaceSpan(prior, oldText, newText, job.args?.replace_all === true),
      path,
    };
  }
  const lineStart = lineOf(prior, oldText) ?? stampedLine(job);
  return lineStart === undefined
    ? { kind: "diff", oldText, newText, path }
    : { kind: "diff", oldText, newText, path, lineStart };
}

function failLine(job: ToolCallJob, projectPath: string): ToolBody {
  const path = job.argString("path");
  const raw = resultText(job).trim();
  const denial = (denialText(job) ?? "").trim();
  const detail = raw !== "" ? raw : denial;
  const verb =
    job.name === "edit_file"
      ? "edit"
      : detail.includes("exists —") && detail.includes("overwriteExisting")
        ? "overwrite"
        : "write";
  return {
    kind: "fail-line",
    verb,
    path,
    label: path === "" ? "" : displayPath(projectPath, path),
    detail: detail === "" ? "The file could not be updated." : detail,
  };
}

function writeDiff(job: ToolCallJob, reads: readonly ToolCallJob[], blobs: BlobPeek | undefined): ToolBody | null {
  const content = job.argString("content");
  if (content === "") return null;
  const path = job.argString("path");
  const prior = priorOf(job, path, "", reads, blobs);
  if (prior !== null) return { kind: "diff", oldText: prior, newText: content, path };
  if (job instanceof FileMutateToolJob && job.existed === true) return null;
  return { kind: "diff", oldText: "", newText: content, path };
}

function readBody(job: ToolCallJob): ToolBody {
  const text = resultText(job);
  if (text === "") return { kind: "empty" };
  const path = job.argString("path");
  const lang = langFromPath(path);
  if (lang === "markdown") return { kind: "markdown", text };
  const codeLang = lang ?? guessLang(text);
  if (codeLang === undefined || codeLang === "text") return { kind: "text", text };
  return { kind: "code", text, lang: codeLang };
}

function shellBody(job: ToolCallJob, projectPath: string): ToolBody {
  const command = job.argString("command");
  const directory = shellDirectory(projectPath, job.argString("cwd"));
  const denied = denialText(job);
  const output = denied ?? shellOutput(job);
  const exitCode = denied === null ? shellExit(job) : undefined;
  return {
    kind: "shell",
    command,
    ...(directory === undefined ? {} : { directory }),
    output,
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

/** `.` and the project directory are the call's cwd, so the terminal has no path line. */
function shellDirectory(projectPath: string, cwd: string): string | undefined {
  const written = cwd.trim();
  if (written === "" || written === "." || written === "./") return undefined;
  const shown = workspacePath(projectPath, written);
  if (shown === "" || shown === "." || shown === "./") return undefined;
  return shown;
}

function shellExit(job: ToolCallJob): number | undefined {
  const value = job.outcomeSnap?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("exitCode" in value)) return undefined;
  const code = value.exitCode;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

function generic(job: ToolCallJob): ToolBody {
  const text = resultText(job);
  if (text === "") return { kind: "empty" };
  if (text.includes("**") || text.includes("`") || text.includes("![")) return { kind: "markdown", text };
  return { kind: "text", text };
}

function schemeResult(job: ProgrammaticJob): ToolPart[] {
  const snap = job.outcomeSnap;
  if (snap == null) return [];
  if (snap.ok === false) {
    const text = typeof snap.text === "string" ? snap.text : "";
    return text === "" ? [] : [{ kind: "text", text }];
  }
  if (!("value" in snap) || snap.value === undefined) {
    const text = typeof snap.text === "string" ? snap.text : "";
    return text === "" ? [] : [{ kind: "text", text }];
  }
  const items = Array.isArray(snap.value) ? snap.value : [snap.value];
  const parts: ToolPart[] = [];
  for (const item of items) {
    const part = schemeItem(item);
    if (part !== null) parts.push(part);
  }
  return parts;
}

function schemeItem(value: unknown): ToolPart | null {
  if (typeof value === "boolean") return { kind: "code", text: value ? "#t" : "#f", lang: "scm" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "text", text: String(value) };
  if (typeof value === "bigint") return { kind: "text", text: String(value) };
  if (isFilePrint(value)) return filePart(value.face.path, value.text);
  if (typeof value === "string") {
    const text = decodeDisplayString(value);
    if (text === "") return null;
    return looksLikeScheme(text) ? { kind: "code", text, lang: "scm" } : { kind: "text", text };
  }
  if (value !== null && typeof value === "object") {
    try {
      return { kind: "text", text: JSON.stringify(value, null, 2) };
    } catch {
      return null;
    }
  }
  return null;
}

function filePart(path: string, text: string): ToolPart | null {
  const body = decodeDisplayString(text);
  if (body === "") return null;
  if (langFromPath(path) === "markdown") return { kind: "markdown", text: body };
  const lang = langFromPath(path) ?? guessLang(body);
  if (lang === undefined || lang === "text" || lang === "markdown") return { kind: "text", text: body };
  return { kind: "code", text: body, lang };
}

function isFilePrint(value: unknown): value is { text: string; face: { kind: "file"; path: string } } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("text" in value) || !("face" in value)) return false;
  const { text, face } = value;
  if (typeof text !== "string" || face === null || typeof face !== "object" || Array.isArray(face)) return false;
  if (!("kind" in face) || !("path" in face)) return false;
  return face.kind === "file" && typeof face.path === "string";
}

function looksLikeScheme(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(";;") ||
    trimmed.startsWith("#|") ||
    trimmed.startsWith("(") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'") ||
    trimmed.startsWith("#\\") ||
    trimmed.startsWith(":")
  );
}

function decodeDisplayString(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

function pack(parts: readonly ToolPart[]): ToolBody {
  if (parts.length === 0) return { kind: "empty" };
  if (parts.length === 1) return parts[0];
  return { kind: "parts", parts };
}

function denialText(job: ToolCallJob): string | null {
  if (!isDenied(job)) return null;
  const snap = job.outcomeSnap;
  const text = typeof snap?.text === "string" ? snap.text.trim() : "";
  const policy = (job.policyMessage ?? "").trim();
  if (policy !== "" && (text === "" || text === policy)) return policy;
  return text;
}

function isDenied(job: ToolCallJob): boolean {
  const snap = job.outcomeSnap;
  if (snap == null) return false;
  if (snap.code === "policy_denied") return true;
  const vote = job.policyResult;
  return (vote === "block" || vote === "deny") && snap.ok !== true && job.humanApprove !== true;
}

function isClippedRead(text: string): boolean {
  return /\n…\[file is \d+ bytes; read the first \d+\]$/.test(text);
}

/**
 * The prior text the host stamped on a mutation: inline, or the blob's text once the cache holds it. A blob
 * whose text is not there yet is no prior; `fetch` asks the cache for it.
 */
function stampedPrior(job: ToolCallJob, blobs: BlobPeek | undefined, fetch: boolean): string | null {
  if (!(job instanceof FileMutateToolJob)) return null;
  const prior = job.prior;
  if (prior === null) return null;
  if (prior.kind === "inline") return prior.text;
  const { sha256 } = prior.blob;
  const text = blobs?.peek(sha256) ?? null;
  if (text === null && fetch) blobs?.want(sha256);
  return text;
}

function priorOf(
  job: ToolCallJob,
  path: string,
  span: string,
  reads: readonly ToolCallJob[],
  blobs: BlobPeek | undefined,
): string | null {
  const stamped = stampedPrior(job, blobs, true);
  if (stamped !== null) return stamped;
  if (path === "") return null;
  for (const read of reads.toReversed()) {
    if (read === job || read.name !== "read_file") continue;
    const args = read.args;
    if (read.argString("path") !== path) continue;
    if (args?.offset !== undefined || args?.limit !== undefined) continue;
    const text = resultText(read);
    if (text !== "" && !isClippedRead(text) && (span === "" || containsSpan(text, span))) return text;
  }
  return null;
}

function stampedLine(job: ToolCallJob): number | undefined {
  if (!(job instanceof FileMutateToolJob)) return undefined;
  const line = job.priorLineStart;
  return typeof line === "number" && Number.isFinite(line) && line > 1 ? line : undefined;
}

function containsSpan(file: string, span: string): boolean {
  if (span === "" || file.includes(span)) return true;
  return file.replaceAll("\r\n", "\n").includes(span.replaceAll("\r\n", "\n"));
}

function lineOf(file: string | null, span: string): number | undefined {
  if (file == null || span === "") return undefined;
  const normalizedFile = file.replaceAll("\r\n", "\n");
  const normalizedSpan = span.replaceAll("\r\n", "\n");
  let index = normalizedFile.indexOf(normalizedSpan);
  if (index === -1) {
    const first = normalizedSpan.split("\n")[0] ?? "";
    if (first === "" || first === normalizedSpan) return undefined;
    index = normalizedFile.indexOf(first);
  }
  if (index === -1) return undefined;
  let line = 1;
  for (let i = 0; i < index; i++) if (normalizedFile[i] === "\n") line += 1;
  return line > 1 ? line : undefined;
}

function replaceSpan(haystack: string, needle: string, replacement: string, all: boolean): string {
  if (all) return haystack.split(needle).join(replacement);
  const at = haystack.indexOf(needle);
  return at === -1 ? haystack : haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

function resultText(job: ToolCallJob): string {
  const snap = job.outcomeSnap;
  if (snap == null) return "";
  if (typeof snap.text === "string" && snap.text !== "") return snap.text;
  if (!("value" in snap) || snap.value === undefined) return "";
  if (typeof snap.value === "string") return snap.value;
  try {
    return JSON.stringify(snap.value, null, 2);
  } catch {
    return "";
  }
}

function shellOutput(job: ToolCallJob): string {
  const value = job.outcomeSnap?.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const stdout = "stdout" in value && typeof value.stdout === "string" ? value.stdout : "";
    const stderr = "stderr" in value && typeof value.stderr === "string" ? value.stderr : "";
    const parts = [stdout, stderr].filter((part) => part !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  return resultText(job);
}

/** Not yet settled, settled ok, or settled with `ok: false`. */
export type ToolOutcome = "live" | "ok" | "failed";

export function outcomeOf(completed: boolean, snap: { readonly ok: boolean } | undefined): ToolOutcome {
  if (!completed && snap == null) return "live";
  if (snap?.ok === false) return "failed";
  return "ok";
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== "");
  return line?.trim() ?? "";
}
