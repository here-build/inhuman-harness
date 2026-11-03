import { PromptMessage, type PromptMessageRole } from "@inhuman.tools/harness-model/session";

import type { PromptTextExternalizer } from "./ports.js";

export function promptMessageOf(
  role: PromptMessageRole,
  text: string,
  externalize?: PromptTextExternalizer,
): PromptMessage {
  const stamp = externalize?.(text) ?? { kind: "inline", text };
  return stamp.kind === "inline"
    ? new PromptMessage({ role, content: stamp.text })
    : new PromptMessage({ role, content: stamp.head, contentBlobJson: stamp.blobJson });
}
