/**
 * Authored chat turn on an isolated CompletionExpectation. Role is the
 * provider wire role, not a class-kind. Not session tape (`messages`).
 */
import { Model, model, state } from "@inhuman.tools/model";

import { parseStoredBlob, type StoredText } from "../blob-ref.js";

export type PromptMessageRole = "system" | "user" | "assistant";

@model("harness:expectation:prompt-message")
export class PromptMessage extends Model {
  @state accessor role: PromptMessageRole = "user";
  /**
   * The message text, or only its head once the body went to the blob bucket
   * ({@link contentBlobJson}). A reader that needs the whole body asks {@link body}.
   */
  @state accessor content: string = "";
  /**
   * The body's blob reference (a `StoredBlob` as JSON) when the text was too large to stay
   * inline; {@link content} then holds the head. Null while the body is inline, and in
   * documents from before bodies could leave.
   */
  @state accessor contentBlobJson: string | null = null;

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
