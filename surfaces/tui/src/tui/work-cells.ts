/**
 * Tool / scheme / loop face projection. Agent knowledge stays here — not in Quickdraw.
 * Cover chrome is Tea; this file projects the ask pin and work cell faces.
 * `approvalComment` rides identity status. Policy and judge votes do not —
 * waiting is the `?` gutter, not an `ask` / `allow` word. The pin follows
 * `askPaintHead` — a mutate Diff stays the pin until its result is a tape row,
 * not merely until `approved`.
 */
import { type BlobPeek, type KernelRoot, ProgrammaticJob, ToolCallJob } from "@inhuman.tools/harness-model";
import {
  compactOmitsTool,
  mutateSuggestionReceipt,
  workCellFace,
  type ReceiptFace,
  type WorkCellFace,
} from "@inhuman.tools/harness-sdk/text";

import type { WorkReceiptKind } from "./paint-types.js";

// The face layer lives in `work-text.ts` of `@inhuman.tools/harness-sdk/text` (no quickdraw).
// One door for paint importers and tests.
export {
  receiptPlainText,
  workCellFace,
  type CallStatus,
  type ReceiptFace,
  type WorkCellFace,
  type WorkCellState,
} from "@inhuman.tools/harness-sdk/text";

export const SIGIL_TOOL = "·";
export const SIGIL_SHELL = "$";
export const SIGIL_SCHEME_REPL = "⒪";
export const SIGIL_SCHEME_WATCH = "⒲";
export const SIGIL_ASK = "?";
/** Same seat as `SIGIL_TOOL`, but the classifier is evaluating, not executing. */
export const SIGIL_JUDGE = "?";

type ReceiptPart = Extract<ReceiptFace, { kind: "parts" }>["parts"][number];

export function receiptFromReplica(
  kind: WorkReceiptKind,
  text: string,
  diff: { readonly old: string; readonly new: string; readonly path: string; readonly lineStart?: number },
): ReceiptFace {
  if (kind === "diff") {
    return {
      kind: "diff",
      old: diff.old,
      new: diff.new,
      path: diff.path,
      ...(diff.lineStart === undefined || diff.lineStart <= 1 ? {} : { lineStart: diff.lineStart }),
    };
  }
  if (kind === "none") return { kind: "none" };
  if (kind === "parts") {
    let parts: ReceiptPart[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parts = parsed.filter((value): value is ReceiptPart => {
          if (value === null || typeof value !== "object") return false;
          const rec = value as { kind?: unknown; text?: unknown };
          return (
            (rec.kind === "text" ||
              rec.kind === "markdown" ||
              rec.kind === "number" ||
              rec.kind === "boolean" ||
              rec.kind === "syntax") &&
            typeof rec.text === "string"
          );
        });
      }
    } catch {
      parts = [];
    }
    return { kind: "parts", parts };
  }
  return { kind, text };
}

/**
 * Compact omits floor-allow leaves only when `hideFloorTools` is on.
 * Default off: the call stays, including the question identity while it
 * is still open. Comm-first (agent) stays omitted. The scheme bag never
 * fuses. Inners of a bag never fuse — the bag row is their host parent.
 */
export function workCellFuse(work: ToolCallJob | ProgrammaticJob, nested = false, hideFloorTools = false): boolean {
  if (work instanceof ProgrammaticJob) return false;
  return compactOmitsTool(work, hideFloorTools, nested);
}

function pinOmitsIdentity(face: WorkCellFace): boolean {
  return face.rimNamed;
}

/** Pin exists to hold a Diff, or an identity the rim cannot say. MCP options and shell commands ride the composer stack. */
export function askPinWorthPainting(face: WorkCellFace): boolean {
  if (face.split) return false;
  if (face.receipt.kind !== "none") return true;
  return !pinOmitsIdentity(face);
}

export function askPinFace(
  work: ToolCallJob | ProgrammaticJob,
  kernel?: KernelRoot | null,
  blobs?: BlobPeek,
): WorkCellFace {
  const face = workCellFace(work, `ask:${work.toolCallId}`, false, false, "", kernel, blobs);
  if (!(work instanceof ToolCallJob)) return face;
  const suggestion = mutateSuggestionReceipt(work, blobs);
  if (suggestion.kind === "none") return face;
  return { ...face, receipt: suggestion };
}
