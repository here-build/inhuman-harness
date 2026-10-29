// attachments — non-text MCP content-block stubbing (image/audio/embedded-blob). When an
// upstream tool answers `content: [{type:"text"}, {type:"image", data:<base64>}]`, the raw
// base64 fragment was bleeding into serialized REPL text (~12k chars per hit, unreadable
// waste). The fix has two halves:
//
//   1. IN-VALUE: `unwrapToolResult` (server.ts) replaces every BINARY content block
//      (image/audio/resource-with-blob) with a compact stub via `formatAttachmentStub`, so
//      the value the model sees reads `#<attachment 1: image/jpeg, 48213 bytes>` instead of
//      the base64 payload.
//   2. PASS-THROUGH: the originals are not dropped — `AttachmentCollector` captures them in
//      encounter order, so the manifold tool's own MCP response can append them AFTER the
//      text block. A multimodal client renders them natively; a text-only client sees the
//      stub (the same info a native tool-result-collapse note would give).
//
// Two stub grades, decided at record time (the per-call quota is set by `beginCall()`
// before any statement runs):
//   • within quota  → `formatAttachmentStub` — `#<attachment N: mime/type, NNN bytes>`.
//   • over quota    → `formatHiddenStub`    — `#<image N: mime/type, 2.1MB>` (kind word;
//     the per-block teaching lives ONLY in the trailing note from `drainNote()`).
// "attachment" is reserved for blocks actually present in the response's content array; the
// hidden grade uses "image"/"audio"/"blob".
//
// LIFECYCLE (same shape as futility.ts's FutilityTracker / doors.ts's DoorSession): ONE
// instance per manifold-server process, threaded into BOTH `toBoundServer` (server.ts — the
// record site) and `createManifoldTool` (manifold-tool.ts — the drain site). Numbering
// restarts per CALL via `beginCall(quota)`, not per process: `drainBlocks()`/`drainNote()`
// capture the result. Today the server processes one call at a time in practice; per-call
// isolation (AsyncLocalStorage / threaded call-id) can be added if that ever changes.

import { RESPONSE_ATTACHMENTS_ARG_NAME } from "./names.js";

/** A duck-typed view over an MCP content-block shape. Never the SDK's own
 *  `ContentBlock` union: this module inspects fields duck-typed (`data`, `resource.blob`)
 *  rather than discriminating on the union, so an unknown future kind degrades to the
 *  generic non-binary treatment rather than a type error. */
export interface ContentBlockish {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: unknown;
}

interface ResourceShape {
  mimeType?: unknown;
  blob?: unknown;
}

function resourceOf(block: ContentBlockish): ResourceShape | undefined {
  return typeof block.resource === "object" && block.resource !== null ? (block.resource as ResourceShape) : undefined;
}

/** The pinned criterion: image/audio, plus an embedded-resource carrying a `blob`. An
 *  embedded resource with `text` (not `blob`) and a `resource_link` (no payload) are
 *  unaffected and pass through untouched. */
export function isBinaryContentBlock(block: ContentBlockish): boolean {
  if (block.type === "image" || block.type === "audio") return true;
  if (block.type === "resource") return typeof resourceOf(block)?.blob === "string";
  return false;
}

const BASE64_TRAILING_PADDING = /=+$/;

/** Decoded byte length from a base64 string's own length — O(1) arithmetic, no
 *  `Buffer`/`atob` allocation. */
function base64DecodedByteLength(base64: string): number {
  const padding = BASE64_TRAILING_PADDING.exec(base64)?.[0].length ?? 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function base64OfBlock(block: ContentBlockish): string | undefined {
  if (typeof block.data === "string") return block.data;
  const blob = resourceOf(block)?.blob;
  return typeof blob === "string" ? blob : undefined;
}

function mimeTypeOfBlock(block: ContentBlockish): string {
  if (typeof block.mimeType === "string") return block.mimeType;
  const resourceMimeType = resourceOf(block)?.mimeType;
  if (typeof resourceMimeType === "string") return resourceMimeType;
  return typeof block.type === "string" ? block.type : "application/octet-stream";
}

/** Block kind word for the HIDDEN grade and the trailing note's pluralization. */
type AttachmentKind = "image" | "audio" | "blob";

function kindOfBlock(block: ContentBlockish): AttachmentKind {
  if (block.type === "image") return "image";
  if (block.type === "audio") return "audio";
  return "blob"; // the only other admitted shape: a resource with `blob`
}

/** Human-scaled byte size for the HIDDEN grade — an over-quota block is never
 *  rendered, so exact bytes buys the model nothing; an order of magnitude is
 *  enough to judge whether raising the quota is worth the token cost. */
function formatByteSizeHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** `#<attachment N: mime/type, NNN bytes>` — frozen stub shape, reserved for a block
 *  actually present in this response's content array (INJECTED grade). `index` is
 *  1-based and supplied by the caller (the `AttachmentCollector`). */
export function formatAttachmentStub(index: number, block: ContentBlockish): string {
  const mimeType = mimeTypeOfBlock(block);
  const base64 = base64OfBlock(block);
  if (base64 !== undefined) {
    return `#<attachment ${index}: ${mimeType}, ${base64DecodedByteLength(base64)} bytes>`;
  }
  // Defensive fallback only — every block `isBinaryContentBlock` admits (image/audio
  // `data`; resource `blob` per the check itself) always has a base64 field. Labeled
  // as approximate rather than silently guessing bytes.
  const approxChars = (() => {
    try {
      return JSON.stringify(block)?.length ?? 0;
    } catch {
      return 0;
    }
  })();
  return `#<attachment ${index}: ${mimeType}, ~${approxChars} chars (undecoded)>`;
}

/** `#<image N: mime/type, 2.1MB>` — HIDDEN/over-quota grade. No inline teaching. */
export function formatHiddenStub(index: number, block: ContentBlockish): string {
  const mimeType = mimeTypeOfBlock(block);
  const kind = kindOfBlock(block);
  const base64 = base64OfBlock(block);
  const size = base64 === undefined ? "size unknown" : formatByteSizeHuman(base64DecodedByteLength(base64));
  return `#<${kind} ${index}: ${mimeType}, ${size}>`;
}

/** Hard transport cap — no `response-attachments` request can rise above this. */
export const MAX_PASSTHROUGH_ATTACHMENTS = 8;

/** Default pass-through quota — first 3 binary blocks in encounter order. */
export const DEFAULT_PASSTHROUGH_ATTACHMENTS = 3;

/** Per-manifold-server-process collector. See the file header for lifecycle. */
export class AttachmentCollector {
  private captured: ContentBlockish[] = [];
  private counter = 0;
  private quota = DEFAULT_PASSTHROUGH_ATTACHMENTS;

  /** Bound stub function — passed directly as `unwrapToolResult`'s second argument.
   *  Captures one binary block and returns its numbered stub (IN-while-within-quota,
   *  HIDDEN once over); grading is decided here because `beginCall()` has already
   *  fixed the quota. */
  readonly stub = (block: ContentBlockish): string => {
    this.counter += 1;
    this.captured.push(block);
    return this.counter <= this.quota
      ? formatAttachmentStub(this.counter, block)
      : formatHiddenStub(this.counter, block);
  };

  /** Reset numbering, captured blocks, and pass-through quota. Called at the START of
   *  every manifold-tool `call()` UNCONDITIONALLY (even before arg validation) so an
   *  early-returning call never leaks stale state into the next `drain*`. */
  beginCall(quota: number = DEFAULT_PASSTHROUGH_ATTACHMENTS): void {
    this.captured = [];
    this.counter = 0;
    this.quota = quota;
  }

  /** Raw MCP content blocks for this call's within-quota tail, in encounter order —
   *  never the hidden tail (that's `drainNote`'s job). Does NOT reset state. */
  drainBlocks(): ContentBlockish[] {
    return this.captured.slice(0, this.quota);
  }

  /** ONE trailing note naming how many blocks this call hid past quota, or
   *  `undefined` when nothing was hidden. "attachments" when kinds mix; else the
   *  specific plural (image/images/audio/blobs) — matching each hidden block's own stub
   *  word. Does NOT reset state. */
  drainNote(): string | undefined {
    const hidden = this.captured.slice(this.quota);
    if (hidden.length === 0) return undefined;
    const kinds = new Set(hidden.map(kindOfBlock));
    const word = kinds.size === 1 ? pluralOfKind([...kinds][0]!) : "attachments";
    return `#| ${hidden.length} ${word} hidden (quota ${this.quota}) — raise the '${RESPONSE_ATTACHMENTS_ARG_NAME}' tool argument |#`;
  }
}

function pluralOfKind(kind: AttachmentKind): string {
  if (kind === "image") return "images";
  if (kind === "audio") return "audio"; // mass noun
  return "blobs";
}
