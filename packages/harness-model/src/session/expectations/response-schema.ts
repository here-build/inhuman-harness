/**
 * JSON Schema subset for CompletionExpectation.responseSchema.
 * Object + required + additionalProperties:false, string/integer/number/boolean/array,
 * enum, integer min/max. No ajv. Null schema is unstructured (no check).
 */

export const JSON_SCHEMA_UNSUPPORTED = "json_schema unsupported";

export function isJsonSchemaUnsupported(message: string): boolean {
  return message.includes(JSON_SCHEMA_UNSUPPORTED);
}

export function assertResponseMatchesSchema(text: string, schemaJson: string | null): void {
  if (schemaJson == null) return;
  let schema: unknown;
  try {
    schema = JSON.parse(schemaJson) as unknown;
  } catch {
    throw new Error("response schema: invalid schema json");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`response schema: completion is not JSON (${completionExcerpt(text)})`);
  }
  matchNode(value, schema, "");
}

/** One-line quote for failReason / CLI. Empty stays `empty`; whitespace is visible. */
const EXCERPT_CHARS = 240;

function completionExcerpt(text: string): string {
  if (text === "") return "empty";
  const oneLine = text.replaceAll(/\s+/g, " ");
  const clipped = oneLine.length > EXCERPT_CHARS ? `${oneLine.slice(0, EXCERPT_CHARS)}…` : oneLine;
  return JSON.stringify(clipped);
}

function matchNode(value: unknown, schema: unknown, path: string): void {
  if (!isPlain(schema)) throw new Error(`response schema${at(path)}: schema must be an object`);
  const type = schema.type;
  if (type === "object") {
    if (!isPlain(value)) throw new Error(`response schema${at(path)}: expected object`);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!Object.hasOwn(value, key)) throw new Error(`response schema${at(path)}: missing ${key}`);
    }
    const properties = isPlain(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) throw new Error(`response schema${at(path)}: extra field ${key}`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      matchNode(value[key], child, path === "" ? key : `${path}.${key}`);
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`response schema${at(path)}: expected array`);
    if (schema.items !== undefined) {
      for (const [i, item] of value.entries()) matchNode(item, schema.items, `${path}[${i}]`);
    }
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`response schema${at(path)}: expected string`);
    enumCheck(value, schema.enum, path);
    return;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      throw new Error(`response schema${at(path)}: expected ${type}`);
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`response schema${at(path)}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`response schema${at(path)}: above maximum ${schema.maximum}`);
    }
    enumCheck(value, schema.enum, path);
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`response schema${at(path)}: expected boolean`);
    return;
  }
  throw new Error(`response schema${at(path)}: unsupported type ${String(type)}`);
}

function enumCheck(value: unknown, allowed: unknown, path: string): void {
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  if (!allowed.includes(value)) throw new Error(`response schema${at(path)}: not in enum`);
}

function at(path: string): string {
  return path === "" ? "" : ` ${path}`;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
