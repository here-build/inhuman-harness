/**
 * Nous driver-provider registration. Product composition adds this to the
 * roster. Search fallback order stays out.
 */
import {
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  type RegisteredProvider,
} from "@inhuman.tools/harness-provider-sdk";

import { NousDriverConnection } from "./driver.js";
import { NOUS_DRIVER_NAME } from "./ids.js";

export const nousProvider: RegisteredProvider = parseProviderRegistration({
  id: NOUS_DRIVER_NAME,
  name: "Nous Portal",
  description: "Nous Portal",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: NOUS_DRIVER_NAME,
      description: "Nous Portal",
      abilityClaim: ["completion"],
      multiplicity: "add-by-default",
      connection: NousDriverConnection,
    },
  ],
});
