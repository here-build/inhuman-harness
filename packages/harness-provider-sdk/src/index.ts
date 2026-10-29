/**
 * @inhuman.tools/harness-provider-sdk — driver-provider descriptors,
 * registration identity, and capability request/result contracts on PEW.
 *
 * Not a vendor completion class, not InhumanPlugin, not a plugin loader.
 */

export type * from "./auth.js";
export { AUTH_INTERACTION_KINDS as AUTH_INTERACTION_KINDS } from "./schemas/index.js";
export * from "./blobs.js";
export * from "./capabilities.js";
export { CAPABILITY_KINDS as CAPABILITY_KINDS } from "./schemas/index.js";
export * from "./descriptor.js";
export * from "./driver.js";
export * from "./identity.js";
export { PROVIDER_SDK_CONTRACT as PROVIDER_SDK_CONTRACT } from "./schemas/index.js";
export * from "./registration.js";
export * from "./visuals.js";
export {
  authInteractionSchema as authInteractionSchema,
  capabilityKindSchema as capabilityKindSchema,
  capabilityRequestSchema as capabilityRequestSchema,
  completeRequestSchema as completeRequestSchema,
  driverConnectionClassSchema as driverConnectionClassSchema,
  driverDefinitionSchema as driverDefinitionSchema,
  mcpCallRequestSchema as mcpCallRequestSchema,
  multiplicitySchema as multiplicitySchema,
  providerDescriptorSchema as providerDescriptorSchema,
  providerRegistrationSchema as providerRegistrationSchema,
  registeredDriverInputSchema as registeredDriverInputSchema,
  webExtractRequestSchema as webExtractRequestSchema,
  webSearchRequestSchema as webSearchRequestSchema,
} from "./schemas/index.js";
