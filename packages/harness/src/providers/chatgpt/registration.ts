/**
 * ChatGPT driver-provider registration. Product composition adds this to the
 * roster. Not a plugin manifest and not a neighboring vendor.
 */
import {
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  type RegisteredProvider,
} from "@inhuman.tools/harness-provider-sdk";

import { ChatGptDriverConnection } from "./connection.js";

export const CHATGPT_DRIVER_NAME = "chatgpt";

export const chatgptProvider: RegisteredProvider = parseProviderRegistration({
  id: CHATGPT_DRIVER_NAME,
  name: "ChatGPT",
  description: "ChatGPT subscription",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: CHATGPT_DRIVER_NAME,
      description: "ChatGPT subscription",
      abilityClaim: ["completion"],
      multiplicity: "add-by-default",
      connection: ChatGptDriverConnection,
    },
  ],
});
