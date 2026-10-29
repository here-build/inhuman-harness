/**
 * Named Zod shapes for provider descriptors, driver rows, and capability
 * request envelopes. Sole definition home for this package.
 */
import { CompletionExpectation } from "@inhuman.tools/harness-model";
import { isDriverConnectionClass, type DriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { z } from "zod";

export const PROVIDER_SDK_CONTRACT = 1 as const;

export const CAPABILITY_KINDS = ["completion", "mcp", "web-search", "web-extract"] as const;

export const capabilityKindSchema = z.enum(CAPABILITY_KINDS);

export const multiplicitySchema = z.enum(["add-by-default", "add-as-secondary"]);

const nonempty = z.string().trim().min(1, "non-empty string required");

const driverDefinitionObject = z.object({
  name: nonempty,
  description: nonempty,
  abilityClaim: z.array(capabilityKindSchema).min(1, "driver abilityClaim must name at least one kind"),
  multiplicity: multiplicitySchema,
  importPath: nonempty.optional(),
});

function liftAbilityClaim(value: unknown): unknown {
  if (value != null && typeof value === "object" && "can" in value && !("abilityClaim" in value)) {
    const { can, ...rest } = value as { can: unknown };
    return { ...rest, abilityClaim: can };
  }
  return value;
}

export const driverDefinitionSchema = z.preprocess(liftAbilityClaim, driverDefinitionObject);

export const providerDescriptorSchema = z.object({
  id: nonempty,
  name: nonempty,
  description: z.string().optional(),
  contract: z.literal(PROVIDER_SDK_CONTRACT, {
    error: `contract is incompatible (supported: ${PROVIDER_SDK_CONTRACT})`,
  }),
  drivers: z.array(driverDefinitionSchema).min(1, "provider must declare at least one driver"),
});

export const driverConnectionClassSchema = z.custom<DriverConnectionClass>((value) => isDriverConnectionClass(value), {
  message: "PEW driver connection class required",
});

export const registeredDriverInputSchema = driverDefinitionObject.extend({
  connection: driverConnectionClassSchema,
});

export const providerRegistrationSchema = providerDescriptorSchema.extend({
  drivers: z.array(registeredDriverInputSchema).min(1, "provider must declare at least one driver"),
});

const abortSignal = z.custom<AbortSignal>((value) => value instanceof AbortSignal, {
  message: "AbortSignal required",
});

const completionRound = z.custom<CompletionExpectation>((value) => value instanceof CompletionExpectation, {
  message: "completion round required",
});

export const completeRequestSchema = z.object({
  connectionId: nonempty,
  model: z.string(),
  promptText: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
  responseSchemaJson: z.string().optional(),
  systemNote: z.string().optional(),
  signal: abortSignal.optional(),
  round: completionRound,
});

export const mcpCallRequestSchema = z.object({
  connectionId: nonempty,
  serverToolName: nonempty,
  args: z.record(z.string(), z.unknown()).default({}),
  signal: abortSignal.optional(),
  onDispatch: z
    .custom<() => void>((value) => typeof value === "function", {
      message: "JS function required",
    })
    .optional(),
});

export const webSearchRequestSchema = z.object({
  connectionId: nonempty,
  query: nonempty,
  limit: z.number().optional(),
  signal: abortSignal.optional(),
});

export const webExtractRequestSchema = z.object({
  connectionId: nonempty,
  url: nonempty,
  charLimit: z.number().optional(),
  signal: abortSignal.optional(),
});

export const capabilityRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completion"), request: completeRequestSchema }),
  z.object({ kind: z.literal("mcp"), request: mcpCallRequestSchema }),
  z.object({ kind: z.literal("web-search"), request: webSearchRequestSchema }),
  z.object({
    kind: z.literal("web-extract"),
    request: webExtractRequestSchema,
  }),
]);

export const AUTH_INTERACTION_KINDS = ["none", "login", "refresh", "logout"] as const;

export const authInteractionKindSchema = z.enum(AUTH_INTERACTION_KINDS);

export const authInteractionSchema = z.object({
  kind: authInteractionKindSchema,
  connectionId: nonempty,
});
