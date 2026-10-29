/**
 * What an expired item leaves behind. Every remainder is deterministic: the
 * same sealed receipt always renders to the same bytes (no timestamps, no
 * ordering-dependent JSON), so a stub never moves the cached prefix.
 */
import type { Leave } from "./schema.js";

export const REF_CHARS = 8;

export function jobRef(uuid: string): string {
  return `job:${uuid.slice(0, REF_CHARS)}`;
}

/** A node that is not yet materialized in a document has no uuid; it simply has no ref. */
export function refOfNode(node: { readonly uuid: string }): string | undefined {
  try {
    return jobRef(node.uuid);
  } catch {
    return undefined;
  }
}

export function visualRef(id: string): string {
  return `visual:${id}`;
}

export function humanSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export type StubFacts = {
  /** Wire or program name. */
  readonly tool: string;
  readonly kind: string;
  readonly ref: string;
  readonly args: Readonly<Record<string, unknown>> | null;
  /** The full painted observation the elision replaces. */
  readonly full: string;
  readonly ok: boolean;
  readonly value: unknown;
  readonly code: string | undefined;
};

function argString(args: StubFacts["args"], ...keys: string[]): string {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

function identityOf(f: StubFacts): string {
  const size = humanSize(f.full.length);
  switch (f.kind) {
    case "tool.read": {
      const target = argString(f.args, "path", "file_path", "pattern") || "?";
      return `${oneLine(target, 120)}, ${lineCount(f.full)} lines, ${size}`;
    }
    case "tool.search": {
      const needle = argString(f.args, "pattern", "query");
      const where = argString(f.args, "path", "cwd");
      return `"${oneLine(needle, 80)}"${where === "" ? "" : ` in ${oneLine(where, 80)}`}, ${lineCount(f.full)} lines`;
    }
    case "tool.web.search": {
      const urls = [...f.full.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
      const unique = [...new Set(urls)];
      const shown = unique.slice(0, 3).join(", ");
      return `"${oneLine(argString(f.args, "query"), 80)}", ${unique.length} urls${shown === "" ? "" : `: ${shown}${unique.length > 3 ? "…" : ""}`}`;
    }
    case "tool.web.fetch":
      return `${oneLine(argString(f.args, "url"), 160)}, ${size}`;
    case "tool.program":
      return `${oneLine(argString(f.args, "expr", "code", "program"), 80)} → ${size}`;
    default: {
      const target = argString(f.args, "path", "file_path", "pattern", "query", "command", "url", "name");
      return target === "" ? size : `${oneLine(target, 80)}, ${size}`;
    }
  }
}

function recallHint(f: StubFacts): string {
  return f.kind === "tool.read" ? `re-read or recall ${f.ref}` : `recall ${f.ref}`;
}

export function stubLine(f: StubFacts): string {
  return `[${f.tool} elided: ${identityOf(f)} — ${recallHint(f)}]`;
}

function exitCodeOf(value: unknown): number | null {
  if (value == null || typeof value !== "object") return null;
  const code = (value as Record<string, unknown>).exitCode;
  return typeof code === "number" ? code : null;
}

function tailLines(f: StubFacts, count: number): string {
  const rec = f.value != null && typeof f.value === "object" ? (f.value as Record<string, unknown>) : null;
  const stdout = typeof rec?.stdout === "string" ? rec.stdout : "";
  const stderr = typeof rec?.stderr === "string" ? rec.stderr : "";
  const text = rec === null || (stdout === "" && stderr === "") ? f.full : `${stdout}\n${stderr}`;
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return lines
    .slice(-count)
    .map((line) => oneLine(line, 160))
    .join(" | ");
}

function shellSummary(f: StubFacts): string {
  const command = oneLine(argString(f.args, "command"), 80);
  const exit = exitCodeOf(f.value);
  const status = exit === null ? (f.ok ? "ok" : "failed") : `exit ${exit}`;
  const tail = tailLines(f, 5);
  return `[shell \`${command}\` ${status}, ${humanSize(f.full.length)} elided${tail === "" ? "" : `; tail: ${tail}`} — recall ${f.ref}]`;
}

function errorSummary(f: StubFacts): string {
  const first = oneLine(f.full.split("\n").find((line) => line.trim() !== "") ?? "", 200);
  const code = f.code === undefined || f.code === "" ? "" : ` (${f.code})`;
  return `[${f.tool} failed${code}: ${first} — recall ${f.ref}]`;
}

function genericSummary(f: StubFacts): string {
  return `${oneLine(f.full, 200)} [${f.tool} elided, ${humanSize(f.full.length)} — recall ${f.ref}]`;
}

/** The remainder of a tool result whose horizon has passed. */
export function toolRemainder(leave: Leave, f: StubFacts, failed: boolean): string {
  if (leave === "none" || leave === "stub") return stubLine(f);
  if (leave === "summary") {
    if (f.kind === "tool.shell") return shellSummary(f);
    if (failed) return errorSummary(f);
    return genericSummary(f);
  }
  return `${f.full.slice(0, leave.head)}\n${stubLine(f)}`;
}

/** The remainder of a prelude cell (steer, note, notification, system note). `null` leaves nothing. */
export function textRemainder(leave: Leave, kind: string, text: string): string | null {
  if (leave === "none") return null;
  if (leave === "stub") return `[${kind} elided: ${text.length} chars]`;
  if (leave === "summary") return `${oneLine(text, 200)} [${kind} elided, ${text.length} chars]`;
  return `${text.slice(0, leave.head)} [${kind} elided, ${text.length} chars]`;
}

/** Large string fields of a call's arguments become a stub; the JSON stays valid. */
export function elideArgs(
  args: Readonly<Record<string, unknown>>,
  ref: string,
  minChars: number,
): { readonly json: string; readonly elided: boolean } {
  const out: Record<string, unknown> = {};
  let elided = false;
  const total = JSON.stringify(args).length;
  for (const [key, value] of Object.entries(args)) {
    if (total >= minChars && typeof value === "string" && value.length > 200) {
      out[key] = `[elided: ${lineCount(value)} lines, ${humanSize(value.length)} — recall ${ref}]`;
      elided = true;
    } else {
      out[key] = value;
    }
  }
  return { json: JSON.stringify(out), elided };
}
