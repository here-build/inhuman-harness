import type { JsonSchema, ToolArg } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function propertySchema(arg: ToolArg): JsonSchema {
  const spec: JsonSchema = {};
  if (arg.type === "enum") spec.type = "string";
  else if (arg.type !== "unknown") spec.type = arg.type;
  if (arg.description !== "") spec.description = arg.description;
  return spec;
}

/** Reconstruct a JSON Schema from slimmed args when the wire schema was dropped. */
export function optsSchemaFromArgs(args: readonly ToolArg[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = propertySchema(arg);
    if (arg.required) required.push(arg.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

export function optsSchemaForTool(inputSchema: JsonSchema | undefined, args: readonly ToolArg[]): JsonSchema {
  if (inputSchema !== undefined) return inputSchema;
  return optsSchemaFromArgs(args);
}

export function validateOpts(schema: JsonSchema, args: unknown): string[] {
  if (!isRecord(args)) return ["opts must be an object"];
  const errors: string[] = [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === "") errors.push(`missing ${key}`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in args)) continue;
    const value = args[key];
    if (value === undefined || value === null) continue;
    const rec = isRecord(spec) ? spec : {};
    const expected = typeof rec.type === "string" ? rec.type : undefined;
    if (expected === undefined) continue;
    if (expected === "string" && typeof value !== "string") errors.push(`${key} should be string`);
    if (expected === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
      errors.push(`${key} should be integer`);
    }
    if (expected === "number" && typeof value !== "number") errors.push(`${key} should be number`);
    if (expected === "boolean" && typeof value !== "boolean") errors.push(`${key} should be boolean`);
  }
  return errors;
}

export function isCovered(question: string | null, effect: string | null): boolean {
  return question !== null && question.trim() !== "" && effect !== null && effect.trim() !== "";
}

export function isSerializerCovered(serializer: string | null): boolean {
  return serializer !== null && serializer.trim() !== "";
}
