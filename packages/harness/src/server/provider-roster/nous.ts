import { parseProviderRegistration, PROVIDER_SDK_CONTRACT } from "@inhuman.tools/harness-provider-sdk";

import { NOUS_GATEWAY_DRIVER_NAME } from "@/providers/nous";

import { NousGatewayWebSearchConnection } from "../drivers/web-search/nous-gateway.js";

/** Product intern. Not adopted; projected when a nous row exists. */
export const nousGatewayIntern = parseProviderRegistration({
  id: NOUS_GATEWAY_DRIVER_NAME,
  name: "Nous Tool Gateway",
  description: "Projected intern when a nous connection exists",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: NOUS_GATEWAY_DRIVER_NAME,
      description: "Nous Portal Tool Gateway search and extract",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-by-default",
      connection: NousGatewayWebSearchConnection,
    },
  ],
});
