import type { PromptMessage, PromptMessageRole } from "@inhuman.tools/harness-model/session";
import { promptMessageOf as runtimePromptMessageOf } from "@inhuman.tools/turn/runtime";
import { externalizeText } from "@inhuman.tools/turn/tool-runtime";

export function promptMessageOf(role: PromptMessageRole, text: string): PromptMessage {
  return runtimePromptMessageOf(role, text, externalizeText);
}
