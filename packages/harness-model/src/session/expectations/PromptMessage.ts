/**
 * Authored chat turn on an isolated CompletionExpectation. Role is the
 * provider wire role, not a class-kind. Not session tape (`messages`).
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import { parseStoredBlob, type StoredText } from "../blob-ref.js";

export type PromptMessageRole = "system" | "user" | "assistant";

@syncing("harness:expectation:prompt-message")
export class PromptMessage extends PlexusModel {
  @syncing accessor role: PromptMessageRole = "user";
  /**
   * The message text, or only its head once the body went to the blob bucket
   * ({@link contentBlobJson}). A reader that needs the whole body asks {@link body}.
   */
  @syncing accessor content: string = "";
  /**
   * The body's blob reference (a `StoredBlob` as JSON) when the text was too large to stay
   * inline; {@link content} then holds the head. Null while the body is inline, and in
   * documents from before bodies could leave.
   */
  @syncing accessor contentBlobJson: string | null = null;

  /** The body, inline or by reference. A reference that does not parse is no reference. */
  get body(): StoredText {
    const blob = parseStoredBlob(this.contentBlobJson);
    return blob === null ? { kind: "inline", text: this.content } : { kind: "blob", blob };
  }

  constructor(
    props?:
      | {
          readonly role?: PromptMessageRole;
          readonly content?: string;
          readonly contentBlobJson?: string | null;
        }
      | symbol,
  ) {
    super(props);
  }
}
