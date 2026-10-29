/**
 * Grok driver-provider registration. Product composition adds this to the
 * roster. Not a plugin manifest and not a neighboring vendor.
 */
import {
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  type RegisteredProvider,
} from "@inhuman.tools/harness-provider-sdk";

import { GrokDriverConnection } from "./connection.js";

export const GROK_DRIVER_NAME = "grok";

export const grokProvider: RegisteredProvider = parseProviderRegistration({
  id: GROK_DRIVER_NAME,
  name: "Grok",
  description: "Grok subscription",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: GROK_DRIVER_NAME,
      description: "Grok subscription",
      abilityClaim: ["completion", "web-search"],
      multiplicity: "add-by-default",
      connection: GrokDriverConnection,
    },
  ],
});
