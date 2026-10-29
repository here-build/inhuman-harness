/**
 * Write seam for blobs that leave the session document. The kernel's bucket
 * belongs to the daemon; the places that stamp a large text (a file's prior,
 * an isolated completion's prompt, the vacuum of a stored session) put through
 * here and never import the store. Reads go the other way, through
 * `readBlob` in harness-provider-sdk.
 */
import { blobHeadOf, exceedsInlineMax, storedBlobJson, type BlobRef } from "@inhuman.tools/harness-model";

/** Synchronous because the stamping paths are: admit mints a job in one tick. */
export type BlobWriter = (bytes: Uint8Array, mime: string) => BlobRef;

/** What a `FileMutateToolJob` takes for its prior text: the text itself, or the reference to it. */
export type PriorProps = { readonly priorContent: string } | { readonly priorBlobJson: string };

/**
 * What {@link externalizeText} decided for a text. `inline` is the text itself. `blob` carries what the
 * document keeps instead: the head for the text field, and the reference (a `StoredBlob` as JSON) for the
 * `*BlobJson` field beside it.
 */
export type TextStamp =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "blob"; readonly head: string; readonly blobJson: string };

const TEXT_MIME = "text/plain";

let writer: BlobWriter | null = null;

/** The host that owns the bucket binds it once at boot. `null` unbinds. */
export function bindBlobWriter(write: BlobWriter | null): void {
  writer = write;
}

/**
 * Puts bytes through the bound writer and returns the reference. Throws while no writer is bound and when the
 * bucket refuses. For a path that has no inline fallback (the vacuum moves text that is already in the
 * document; a refused put must stop it, not pass silently). The stamping paths use {@link externalizeText}.
 */
export function writeBlob(bytes: Uint8Array, mime: string): BlobRef {
  if (writer === null) throw new Error("no blob writer is bound");
  return writer(bytes, mime);
}

/**
 * Text within the inline limit stays inline. Larger text goes to the bucket as UTF-8 and the document keeps the
 * reference with the head that paint and stubs read. With no writer bound, or a bucket that refuses the write,
 * the text stays inline as it always did: a text is never lost to a full disk.
 */
export function externalizeText(text: string, mime: string = TEXT_MIME): TextStamp {
  if (writer === null || !exceedsInlineMax(text)) return { kind: "inline", text };
  try {
    const ref = writer(Buffer.from(text, "utf8"), mime);
    const head = blobHeadOf(text);
    return { kind: "blob", head, blobJson: storedBlobJson({ ...ref, head }) };
  } catch {
    return { kind: "inline", text };
  }
}

/** {@link externalizeText} in the shape a `FileMutateToolJob` takes. */
export function externalizePrior(text: string): PriorProps {
  const stamp = externalizeText(text);
  return stamp.kind === "inline" ? { priorContent: stamp.text } : { priorBlobJson: stamp.blobJson };
}
