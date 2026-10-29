/**
 * OpenRouter driver registration. Product composition adds this to the
 * shipped roster. Importing this module does not load chatgpt/grok/nous/mcp/web.
 */
import { parseProviderRegistration, PROVIDER_SDK_CONTRACT } from "@inhuman.tools/harness-provider-sdk";

import { OpenRouterDriverConnection } from "./connection.js";

export const OPENROUTER_DRIVER_NAME = "openrouter";

export const openrouterProvider = parseProviderRegistration({
  id: OPENROUTER_DRIVER_NAME,
  name: "OpenRouter",
  description: "OpenRouter",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: OPENROUTER_DRIVER_NAME,
      description: "OpenRouter",
      abilityClaim: ["completion"],
      multiplicity: "add-by-default",
      connection: OpenRouterDriverConnection,
    },
  ],
});
