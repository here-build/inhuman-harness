/**
 * Squeeze — tool-call observation paint. Not compact. Not settlement.
 *
 * Stored `outcomeJson` stays the source. This module projects it for the wire.
 * Compact.scm does not inspect payload size.
 *
 * A reduced observation points at `context_recall`: the sealed receipt is read
 * back from the graph, paged, instead of from a `/tmp` copy. There is no second
 * world on disk. Regenerateable results (`read` | `net`) get no pointer:
 * re-invoking is the address.
 *
 * Top-level strings stay raw text (a file body stays a file body). Serializer
 * quoting of a top-level string is the wrong observation for read_file.
 * Structured `value` payloads ride `toSExprString` caps — not a second compact
 * pass in the driver.
 *
 * MCP image blocks never ride as base64 text: {@link liftToolImages} takes them
 * out of the painted observation, and the projection decides whether the model
 * sees the picture or a stub.
 */
import { toSExprString, toSExprStringWithElisions } from "@here.build/arrival-serializer";
import { ProgrammaticJob, ToolCallJob, type ToolCallRepresentation } from "@inhuman.tools/harness-model";

import { humanSize, refOfNode } from "./retention/render.js";

export type SqueezeTo = "compact" | "micro";

/** Measured optimal observation size. Chars, not tokens. */
export const SQUEEZE_COMPACT_CHARS = 5000;

/** Below this, micro is a no-op — replacing a short answer with a path is pointless. */
export const SQUEEZE_MICRO_MIN_CHARS = 100;

export type SqueezeInput = {
  readonly to: SqueezeTo;
  readonly payload: unknown;
  readonly persistable: boolean;
  /** `job:<ref>` the model passes to `context_recall`. Without it a reduced result carries no pointer. */
  readonly recallRef?: string;
  readonly name: string;
};

/** Source observation as a string. Top-level strings stay raw; values ride the serializer. */
export function paintObservation(payload: unknown): string {
  if (payload === undefined) return "";
  if (typeof payload === "string") return payload;
  return toSExprString(payload);
}

export function squeezeObservation(input: SqueezeInput): string {
  const { to, payload, persistable, name } = input;
  const pointer = persistable && input.recallRef !== undefined ? recallComment(input.recallRef) : "";

  if (typeof payload === "string") {
    if (to === "micro") {
      if (payload.length < SQUEEZE_MICRO_MIN_CHARS) return payload;
      if (!persistable) return clearedStub(name);
      return pointer === "" ? compactBody(payload).text : pointer;
    }
    const { text, reduced } = compactBody(payload);
    if (reduced && pointer !== "") return `${pointer}\n${text}`;
    return text;
  }

  if (to === "micro") {
    const full = paintObservation(payload);
    if (full.length < SQUEEZE_MICRO_MIN_CHARS) return full;
    if (!persistable) return clearedStub(name);
    return pointer === "" ? squeezeValue(payload) : pointer;
  }

  const { text, reduced } = toSExprStringWithElisions(payload, {
    maxTotalChars: SQUEEZE_COMPACT_CHARS,
    maxStringChars: SQUEEZE_COMPACT_CHARS,
  });
  if (reduced && pointer !== "") return `${pointer}\n${text}`;
  return text;
}

function squeezeValue(payload: unknown): string {
  return toSExprString(payload, {
    maxTotalChars: SQUEEZE_COMPACT_CHARS,
    maxStringChars: SQUEEZE_COMPACT_CHARS,
  });
}

function compactBody(payload: string): { text: string; reduced: boolean } {
  if (payload.length <= SQUEEZE_COMPACT_CHARS) return { text: payload, reduced: false };
  const dropped = payload.length - SQUEEZE_COMPACT_CHARS;
  return {
    text: `${payload.slice(0, SQUEEZE_COMPACT_CHARS)}…(+${dropped} chars)`,
    reduced: true,
  };
}

function recallComment(ref: string): string {
  return `;;full response: context_recall ${JSON.stringify({ ref })}`;
}

function clearedStub(name: string): string {
  return name === "" ? "[Old tool result content cleared]" : `[Old ${name} result content cleared]`;
}

const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;

export type ToolImage = {
  /** 1-based position among this result's images. */
  readonly index: number;
  readonly mime: string;
  readonly size: number;
  /** Null when the block was not valid base64 or exceeds the wire cap. */
  readonly bytes: Uint8Array | null;
};

type ImageBlock = { readonly type: "image"; readonly data?: unknown; readonly mimeType?: unknown; readonly mime_type?: unknown };

function isImageBlock(block: unknown): block is ImageBlock {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image";
}

function decodeBase64(data: unknown): Uint8Array | null {
  if (typeof data !== "string") return null;
  const compact = data.replaceAll(/\s/g, "");
  if (compact === "" || compact.length % 4 !== 0 || !/^[\w+/-]+={0,2}$/.test(compact)) return null;
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0 || decoded.length > MAX_TOOL_IMAGE_BYTES) return null;
  return new Uint8Array(decoded);
}

/** Dimensionless note: `[Image 1: image/png, 31.4 KB]`, or the elided form with a recall pointer. */
export function toolImageLine(image: ToolImage, state: "shown" | "elided", ref?: string): string {
  const head = `Image ${image.index}${state === "elided" ? " elided" : ""}: ${image.mime}, ${humanSize(image.size)}`;
  return state === "elided" && ref !== undefined ? `[${head} — recall ${ref}]` : `[${head}]`;
}

/**
 * Pull image content blocks out of a result so base64 never reaches the model
 * as text. The painted payload keeps a one-line note per image.
 */
export function liftToolImages(
  payload: unknown,
  note: (image: ToolImage) => string = (image) => toolImageLine(image, "shown"),
): { readonly payload: unknown; readonly images: readonly ToolImage[] } {
  if (!Array.isArray(payload) || !payload.some((block) => isImageBlock(block))) return { payload, images: [] };
  const images: ToolImage[] = [];
  const lifted = payload.map((block: unknown) => {
    if (!isImageBlock(block)) return block;
    const mimeRaw = block.mimeType ?? block.mime_type;
    const bytes = decodeBase64(block.data);
    const size =
      bytes === null ? (typeof block.data === "string" ? Math.floor((block.data.length * 3) / 4) : 0) : bytes.length;
    const image: ToolImage = {
      index: images.length + 1,
      mime: typeof mimeRaw === "string" && mimeRaw !== "" ? mimeRaw : "image",
      size,
      bytes,
    };
    images.push(image);
    return { type: "text", text: note(image) };
  });
  return { payload: lifted, images };
}

/** The images a sealed tool result carries, in order. */
export function toolImagesOf(tool: ToolCallJob): readonly ToolImage[] {
  return liftToolImages(tool.observationPayload()).images;
}

function refField(node: { readonly uuid: string }): { readonly recallRef?: string } {
  const ref = refOfNode(node);
  return ref === undefined ? {} : { recallRef: ref };
}

/** Compact line derived from the sealed receipt. */
export function compactToolLine(job: ToolCallJob | ProgrammaticJob): string {
  if (job instanceof ToolCallJob && job.regenerateable) return "";
  if (job instanceof ToolCallJob) return squeezeToolCall(job, "compact");
  const parts = job.resultParts();
  if (parts !== undefined) return parts.map((part) => squeezeProgrammaticText(job, part.text)).join("\n");
  const text = job.resultText();
  return squeezeProgrammaticText(job, text !== "" ? text : (job.receiptJson ?? ""));
}

/** scheme_repl / exam results ride the same cap and pointer as tool results. */
export function squeezeProgrammaticText(job: ProgrammaticJob, text: string): string {
  return squeezeObservation({
    to: "compact",
    payload: text,
    persistable: true,
    ...refField(job),
    name: "",
  });
}

/** Server-side compact wire paint. Not a client-document method. */
export function squeezeToolCall(tool: ToolCallJob, to: SqueezeTo, note?: (image: ToolImage) => string): string {
  return squeezeObservation({
    to,
    payload: liftToolImages(tool.observationPayload(), note).payload,
    persistable: !tool.regenerateable,
    ...refField(tool),
    name: tool.name,
  });
}

export function toolCallRepresentation(tool: ToolCallJob): ToolCallRepresentation {
  return {
    id: tool.toolCallId,
    name: tool.name,
    args: tool.invocation(),
    result: paintObservation(liftToolImages(tool.observationPayload()).payload),
  };
}
