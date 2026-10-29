/**
 * @inhuman.tools/tool-call-normalize
 * Model-native tool dialects → OpenAI tool_calls + clean prose.
 */

export * from "./types.js";

export * from "./normalize-message.js";
export * from "./normalize-stream.js";
export * from "./ir.js";
export { getDialect as getDialect, ensureBuiltins as ensureBuiltins } from "./dialects/registry.js";
export * from "./aliases.js";
export * from "./resolve-dialect.js";
export * from "./names.js";
export * from "./fence.js";
export * from "./think.js";
export * from "./schema-repair.js";
export * from "./args-xml.js";
