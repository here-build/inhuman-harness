/**
 * A blob is a large text or byte body that lives in the kernel's blob bucket
 * instead of the session document. The document keeps the reference: content
 * hash, size, media type, and a short head. The reference is the fact; the
 * bytes are immutable and content-addressed, so two equal bodies share one blob.
 */
import { z } from "zod";

/** A body at or below this many UTF-16 code units stays inline in the document. */
export const BLOB_INLINE_MAX_CHARS = 8 * 1024;
/** How much of an externalized body stays beside the reference for paint and stubs. */
export const BLOB_HEAD_CHARS = 512;

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export const blobRef = z.object({
  sha256: z.string().regex(SHA256_HEX),
  bytes: z.number().int().min(0),
  mime: z.string().min(1),
});

export const storedBlob = blobRef.extend({
  head: z.string(),
});

export type BlobRef = z.infer<typeof blobRef>;
export type StoredBlob = z.infer<typeof storedBlob>;

/**
 * What a text-bearing field holds: the text itself, or the reference to its
 * blob with the head that stayed behind.
 */
export type PriorText =
  { readonly kind: "inline"; readonly text: string } | { readonly kind: "blob"; readonly blob: StoredBlob };

/**
 * The same shape serves every text field that can leave the document: a file's prior text
 * ({@link PriorText}, the name the file-mutate job keeps), an authored prompt message, a
 * completion's stored prompt.
 */
export type StoredText = PriorText;

/** Blank, legacy, and corrupt text are no reference. */
export function parseStoredBlob(text: string | null | undefined): StoredBlob | null {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const result = storedBlob.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function storedBlobJson(blob: StoredBlob): string {
  return JSON.stringify(blob);
}

/** The first {@link BLOB_HEAD_CHARS} code units, never splitting a surrogate pair. */
export function blobHeadOf(text: string, chars: number = BLOB_HEAD_CHARS): string {
  if (text.length <= chars) return text;
  let end = chars;
  // A code point above the BMP at the cut means a surrogate pair straddles it.
  if ((text.codePointAt(end - 1) ?? 0) > 0xff_ff) end -= 1;
  return text.slice(0, end);
}

/** True when a body is too large to stay inline. */
export function exceedsInlineMax(text: string, max: number = BLOB_INLINE_MAX_CHARS): boolean {
  return text.length > max;
}

/**
 * A shell-side view of fetched blobs. `peek` is synchronous so paint stays
 * synchronous; `want` asks for a blob that is not cached yet and returns at
 * once. Whoever implements it decides how arrival triggers a repaint.
 */
export type BlobPeek = {
  readonly peek: (sha256: string) => string | null;
  readonly want: (sha256: string) => void;
};
