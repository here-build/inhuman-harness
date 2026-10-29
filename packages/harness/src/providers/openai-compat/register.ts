/**
 * Generic OpenAI-compatible endpoint registration.
 *
 * Product composition wires this row. Importing this module does not load
 * grok/chatgpt/nous/openrouter packages.
 */
import { parseProviderRegistration, PROVIDER_SDK_CONTRACT } from "@inhuman.tools/harness-provider-sdk";

import { OpenAiCompatDriverConnection } from "./connection.js";

export const OPENAI_COMPAT_DRIVER_NAME = "openai-compat";

export const openaiCompatProvider = parseProviderRegistration({
  id: OPENAI_COMPAT_DRIVER_NAME,
  name: "OpenAI-compatible",
  description: "Any OpenAI-compatible Chat Completions or Responses endpoint",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: OPENAI_COMPAT_DRIVER_NAME,
      description: "OpenAI-compatible chat completions",
      abilityClaim: ["completion"],
      multiplicity: "add-as-secondary",
      connection: OpenAiCompatDriverConnection,
    },
  ],
});
