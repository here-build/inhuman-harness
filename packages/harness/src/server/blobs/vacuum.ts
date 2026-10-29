/**
 * The vacuum of a stored session. A session written before large bodies left the document keeps a file's prior
 * text and an isolated completion's prompt inline, and the stored image carries them forever: the daemon never
 * rewrites an image to convert it. The vacuum moves those bodies into the blob bucket and leaves what a new
 * session would hold, a head beside a reference, so paint, the wire projection and `blob/get` read both alike.
 *
 * Three seats, as the stamping paths write them:
 *
 *   - a `FileMutateToolJob`'s `priorContent` moves to `priorBlobJson`;
 *   - a done isolated `CompletionExpectation`'s `promptText` (the twin older builds stored beside the messages)
 *     moves to `promptTextBlobJson`, the head staying in `promptText`. A session round's stored line stays:
 *     `context_recall`, the compaction transcript and the environment capture read it by value, and only the
 *     wire projection reads references;
 *   - a `PromptMessage`'s `content` moves to `contentBlobJson`, the head staying in `content`. These are the
 *     messages of a done completion, and the ones no completion owns any more: `settleAmbientJob` replaces a
 *     summarizer's messages, and a replaced child stays in the document with its text.
 *
 * A completion that is still running is skipped, with its messages. A message owned by anything else (an
 * agent call reads its prompt whole) is left alone. Each entity is its own Plexus transaction, so each is one
 * update and a stop part-way leaves every entity either moved or untouched.
 *
 * The caller flushes the session with a forced snapshot afterwards: the update log still holds the text it was
 * first written with, and only a snapshot drops it.
 */
import { docPlexus } from "@here.build/plexus/internals";
import { asUserPrompt } from "@inhuman.tools/harness-commons";
import {
  blobHeadOf,
  CompletionExpectation,
  exceedsInlineMax,
  FileMutateToolJob,
  parseStoredBlob,
  PromptMessage,
  storedBlobJson,
  type BlobRef,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";

/** Stores bytes under their hash and returns the reference. Throws when the bucket refuses. */
export type BlobPut = (bytes: Uint8Array, mime: string) => BlobRef;

export type VacuumOptions = {
  /** Count what would move; write no blob and change no entity. */
  readonly dryRun: boolean;
  /**
   * Reads a blob back by hash. When given, a text leaves the document only after its blob reads back with the
   * length that was put: the vacuum removes the only copy, so it checks the other one first.
   */
  readonly read?: (sha256: string) => Uint8Array | null;
};

export type VacuumCounts = {
  /** File-mutate jobs whose prior text moved. */
  readonly fileMutates: number;
  /** Prompt messages whose content moved. */
  readonly promptMessages: number;
  /** Completions whose stored line moved. */
  readonly promptTexts: number;
  /** UTF-8 bytes taken out of the document. */
  readonly bytesMoved: number;
};

const TEXT_MIME = "text/plain";

/** What a text leaves behind in the document: the head, and the reference as the `*BlobJson` field holds it. */
type Stub = { readonly head: string; readonly blobJson: string };

export function vacuumSession(root: SessionRoot, put: BlobPut, options: VacuumOptions): VacuumCounts {
  const doc = root.__doc__;
  const plexus = doc == null ? undefined : docPlexus.get(doc);
  if (plexus === undefined) return { fileMutates: 0, promptMessages: 0, promptTexts: 0, bytesMoved: 0 };

  let fileMutates = 0;
  let promptMessages = 0;
  let promptTexts = 0;
  let bytesMoved = 0;

  /** Puts the text, checks it reads back, and applies the stub in one transaction. Dry: only counts. */
  const move = (text: string, apply: (stub: Stub) => void): void => {
    if (!options.dryRun) {
      const bytes = Buffer.from(text, "utf8");
      const ref = put(bytes, TEXT_MIME);
      const back = options.read?.(ref.sha256);
      if (options.read !== undefined && back?.byteLength !== bytes.byteLength) {
        throw new Error(`blob ${ref.sha256} did not read back whole; the text stays in the document`);
      }
      const head = blobHeadOf(text);
      const stub = { head, blobJson: storedBlobJson({ ...ref, head }) };
      runInAction(() => plexus.transact(() => apply(stub)));
    }
    bytesMoved += Buffer.byteLength(text, "utf8");
  };

  const moveMessage = (message: PromptMessage): void => {
    if (parseStoredBlob(message.contentBlobJson) !== null || !exceedsInlineMax(message.content)) return;
    move(message.content, ({ head, blobJson }) => {
      message.content = head;
      message.contentBlobJson = blobJson;
    });
    promptMessages += 1;
  };

  for (const job of plexus.getAllOfType(FileMutateToolJob)) {
    const text = job.priorContent;
    if (typeof text !== "string" || !exceedsInlineMax(text) || parseStoredBlob(job.priorBlobJson) !== null) continue;
    move(text, ({ blobJson }) => {
      job.priorContent = null;
      job.priorBlobJson = blobJson;
    });
    fileMutates += 1;
  }

  for (const completion of plexus.getAllOfType(CompletionExpectation)) {
    if (!completion.isDone) continue;
    const line: string = completion.promptText;
    // Only an isolated round's line leaves: nothing reads it (the messages win in `userPrompt`). A session
    // round's line is read by value by `context_recall` and the compaction transcript, so it stays whole.
    const lineLeaves =
      completion.completionMode === "isolated" &&
      exceedsInlineMax(line) &&
      parseStoredBlob(completion.promptTextBlobJson) === null;
    if (lineLeaves) {
      move(line, ({ head, blobJson }) => {
        completion.promptText = asUserPrompt(head);
        completion.promptTextBlobJson = blobJson;
      });
      promptTexts += 1;
    }
    for (const message of completion.promptMessages) moveMessage(message);
  }

  // A message no completion owns is a replaced child: nothing reads it, and it still holds its text.
  for (const message of plexus.getAllOfType(PromptMessage)) {
    if (message.parent === null) moveMessage(message);
  }

  return { fileMutates, promptMessages, promptTexts, bytesMoved };
}
