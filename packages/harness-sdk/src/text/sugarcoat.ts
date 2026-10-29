/**
 * Scheme result projection for the tape and for plain-text clients: sugarcoat the
 * stored source, and classify printed values into typed parts. No colour and no
 * widget types. `sugarcoat-paint.ts` adds those, so a headless client can read this
 * file without loading the paint substrate.
 */
import { toSExprString } from "@here.build/arrival-serializer";
import { schemeToSugarcoat } from "@here.build/arrival-sugarcoat";
import type { ToolOutcomeSnap } from "@inhuman.tools/harness-model/schemas";

import { unwrapTopLevelSource } from "./unwrap-program.js";

export function sugarcoatSource(src: string): string {
  if (src.trim() === "") return src;
  try {
    const sweet = schemeToSugarcoat(src);
    return sweet === "" ? src : sweet;
  } catch {
    return src;
  }
}

/** Tape/object paint for a scheme_repl program. Splices wrapping begin/list/`[]` first. */
export function sugarcoatProgram(src: string): string {
  return sugarcoatSource(unwrapTopLevelSource(src));
}

/** JSON-quoted payloads (`"a\\nb"`) become the string with real newlines. Bare `C:\\new` stays. */
export function decodeDisplayString(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

export type SchemePaintKind = "text" | "markdown" | "number" | "boolean" | "syntax";

export type SchemePaintPart = {
  readonly kind: SchemePaintKind;
  readonly text: string;
};

export type SchemePaintReceipt =
  | { readonly kind: "none" }
  | SchemePaintPart
  | {
      readonly kind: "parts";
      readonly parts: readonly SchemePaintPart[];
    };

/** Scheme boolean spellings. The highlighter colours the same atoms. */
export const BOOLEAN_ATOMS: ReadonlySet<string> = new Set(["#t", "#f", "#true", "#false"]);

/** Prefixes `toSExprString` emits. A cut marker is recognized anywhere so a
 *  leading display note does not hide it. */
function serializerForm(text: string): boolean {
  if (text.includes("\n#| … output hard-truncated at ") || text.includes("…(+")) return true;
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

export function formatSchemeResult(snap: ToolOutcomeSnap | null | undefined): string {
  const painted = schemePaintReceipt(snap);
  if (painted.kind === "none") return "";
  if (painted.kind === "parts") return painted.parts.map((part) => part.text).join("\n");
  return painted.text;
}

export type FilePaintHint = { readonly path: string; readonly text: string };

/** One receipt per printed value. A display string stays plain. Serializer text is syntax. */
export function schemePaintReceipt(
  snap: ToolOutcomeSnap | null | undefined,
  hints: readonly FilePaintHint[] = [],
): SchemePaintReceipt {
  if (snap == null) return { kind: "none" };
  if (snap.ok === false) {
    const text = decodeDisplayString(snap.text ?? "");
    return text === "" ? { kind: "none" } : { kind: "text", text };
  }
  if (!("value" in snap) || snap.value === undefined) {
    const text = decodeDisplayString(typeof snap.text === "string" ? snap.text : "");
    return text === "" ? { kind: "none" } : { kind: "text", text };
  }
  const items = Array.isArray(snap.value) ? snap.value : [snap.value];
  const parts = items
    .map((item) => schemePart(item, hints))
    .filter((part): part is SchemePaintPart => part !== undefined);
  if (parts.length === 0) return { kind: "none" };
  if (parts.length === 1) {
    const only = parts[0];
    return only === undefined ? { kind: "none" } : only;
  }
  return { kind: "parts", parts };
}

export function isMarkdownPath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

export function fileSchemePart(path: string, text: string): SchemePaintPart | undefined {
  const body = decodeDisplayString(text);
  if (body === "") return undefined;
  return isMarkdownPath(path) ? { kind: "markdown", text: body } : { kind: "text", text: body };
}

function isFilePrint(value: unknown): value is { text: string; face: { kind: "file"; path: string } } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as { text?: unknown; face?: { kind?: unknown; path?: unknown } };
  return typeof rec.text === "string" && rec.face?.kind === "file" && typeof rec.face.path === "string";
}

function hintedFilePart(text: string, hints: readonly FilePaintHint[]): SchemePaintPart | undefined {
  const matched = new Set(hints.filter((hint) => hint.text === text).map((hint) => hint.path));
  if (matched.size !== 1) return undefined;
  const [path] = matched;
  return path === undefined ? undefined : fileSchemePart(path, text);
}

function schemePart(value: unknown, hints: readonly FilePaintHint[] = []): SchemePaintPart | undefined {
  if (typeof value === "boolean") return { kind: "boolean", text: value ? "#t" : "#f" };
  if (typeof value === "number" && Number.isFinite(value)) return { kind: "number", text: String(value) };
  if (typeof value === "bigint") return { kind: "number", text: String(value) };
  if (isFilePrint(value)) return fileSchemePart(value.face.path, value.text);
  if (typeof value === "string") {
    const text = decodeDisplayString(value);
    const hinted = hintedFilePart(text, hints);
    if (hinted !== undefined) return hinted;
    if (BOOLEAN_ATOMS.has(text)) return { kind: "boolean", text };
    // Whole-value number, not a tokenizer prefix. `#t` is a boolean, not `#`+digit.
    if (
      text !== "" &&
      !/\s/.test(text) &&
      !BOOLEAN_ATOMS.has(text) &&
      (Number.isFinite(Number(text)) || /^[+-]?#[xbodei]/i.test(text))
    ) {
      return { kind: "number", text };
    }
    if (text === "") return undefined;
    // Eval already stored `toSExprString` as a string. Those forms highlight;
    // a display sentence and a file body do not start this way.
    return serializerForm(text) ? { kind: "syntax", text } : { kind: "text", text };
  }
  try {
    const text = toSExprString(value);
    return text === "" ? undefined : { kind: "syntax", text };
  } catch {
    const text = decodeDisplayString(String(value));
    return text === "" ? undefined : { kind: "text", text };
  }
}
