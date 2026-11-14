import { toolOutcomeSnapSchema } from "@inhuman.tools/harness-model/schemas";

/**
 * Canonical tool output schema. There is exactly one representation of a tool
 * outcome — `toolOutcomeSnapSchema`, owned by harness-model. Builtin tools
 * declare it as their `output:` under the historical name `toolResultSchema`.
 */
export const toolResultSchema = toolOutcomeSnapSchema;
