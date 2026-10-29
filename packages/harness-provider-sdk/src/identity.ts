import { PROVIDER_SDK_CONTRACT } from "./schemas/provider.js";

/** Process-local brands. Not plugin-sdk InhumanPlugin and not a PEW kind. */
export const providerBrand = {
  descriptor: Symbol.for("@inhuman.tools/harness-provider-sdk:descriptor"),
  registration: Symbol.for("@inhuman.tools/harness-provider-sdk:registration"),
  driver: Symbol.for("@inhuman.tools/harness-provider-sdk:driver"),
} as const;

export type ProviderSdkContract = typeof PROVIDER_SDK_CONTRACT;

export function isCompatibleContract(contract: unknown): contract is ProviderSdkContract {
  return contract === PROVIDER_SDK_CONTRACT;
}
