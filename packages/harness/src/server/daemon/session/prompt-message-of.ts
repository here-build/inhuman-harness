/**
 * The authored message of an isolated completion. A body within the inline limit stays on the message. A larger
 * one (the summarizer's whole transcript prefix runs 0.8 to 1 MB) goes to the kernel's blob bucket, and the
 * message keeps its head in `content` and the reference in `contentBlobJson`: the document never holds the text.
 * The projection reads the whole body back through the blob reader when the round is sent.
 */
import { PromptMessage, type PromptMessageRole } from "@inhuman.tools/harness-model";
import { externalizeText } from "@inhuman.tools/turn/tool-runtime";

/** With no bucket seated, or a bucket that refuses the put, the message keeps its text inline as it always did. */
export function promptMessageOf(role: PromptMessageRole, text: string): PromptMessage {
  const stamp = externalizeText(text);
  return stamp.kind === "inline"
    ? new PromptMessage({ role, content: stamp.text })
    : new PromptMessage({ role, content: stamp.head, contentBlobJson: stamp.blobJson });
}
