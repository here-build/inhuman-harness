/**
 * Schema-local validate-then-repair for tool arguments.
 *
 * WHY NOT always JSON.parse strings that look like JSON:
 *
 * An MCP tool that creates a remote JSON file takes a string body:
 *   create_remote_json_file({ path: "users.json", body: '["a","b"]' })
 *
 * That body is intentional file contents — not an array argument.
 * Always-parsing every string that looks like JSON would turn `body` into
 * a real array, re-encode it differently (or type-break the executor), and
 * false-break the tool. Same trap for write_file content, HTTP JSON bodies,
 * prompt templates that embed JSON, etc.
 *
 * Law: only coerce when the schema already rejected the string AND the
 * parse result would be accepted. Else keep the original string.
 *
 * Order (must not invert):
 *  1. drop null/undefined on optional properties
 *  2. maybeUnstringify at failure sites only
 *  3. wrap bare non-JSON string as single-element array (string items)
 *  4. wrap root bare string as single-field object when schema requires
 *  5. re-stringify: schema type string + value object/array → JSON.stringify
 */

import type { JsonSchema, ToolDef } from "./types.js";

function toolSchema(tools: ToolDef[] | undefined, toolName: string): JsonSchema | undefined {
  return tools?.find((t) => t.name === toolName)?.parameters;
}

function typesOf(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function propMap(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (v && typeof v === "object") out[k] = v as JsonSchema;
  }
  return out;
}

function requiredSet(schema: JsonSchema | undefined): Set<string> {
  const r = schema?.required;
  if (!Array.isArray(r)) return new Set();
  return new Set(r.filter((x): x is string => typeof x === "string"));
}

/** Lightweight shape check for unstringify / re-stringify decisions. */
export function conforms(value: unknown, schema: JsonSchema | undefined): boolean {
  if (!schema) return true;
  const types = typesOf(schema);
  if (types.length === 0) {
    // anyOf / oneOf: accept if any branch matches
    const anyOf = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(anyOf)) {
      return anyOf.some((b) => b && typeof b === "object" && conforms(value, b as JsonSchema));
    }
    return true;
  }
  for (const t of types) {
    if (t === "string" && typeof value === "string") return true;
    if (t === "number" && typeof value === "number" && Number.isFinite(value)) return true;
    if (t === "integer" && typeof value === "number" && Number.isInteger(value)) return true;
    if (t === "boolean" && typeof value === "boolean") return true;
    if (t === "null" && value === null) return true;
    if (t === "array" && Array.isArray(value)) {
      const items = schema.items;
      if (items && typeof items === "object" && !Array.isArray(items)) {
        const itemSch = items as JsonSchema;
        if (typesOf(itemSch).includes("string")) {
          return value.every((el) => typeof el === "string");
        }
      }
      return true;
    }
    if (t === "object" && isPlainObject(value)) return true;
  }
  return false;
}

/**
 * Parse JSON string only when current value fails schema AND parse would pass.
 * Never invent on parse failure — return original.
 */
export function maybeUnstringifyJson(value: unknown, expected: JsonSchema | undefined): unknown {
  if (typeof value !== "string" || !expected) return value;
  const types = typesOf(expected);
  const wantsStructure =
    types.includes("array") ||
    types.includes("object") ||
    (Array.isArray(expected.anyOf) &&
      expected.anyOf.some((b) => {
        if (!b || typeof b !== "object") return false;
        const bt = typesOf(b as JsonSchema);
        return bt.includes("array") || bt.includes("object");
      }));
  if (!wantsStructure) return value;
  // Only at failure sites: string is not already conforming
  if (conforms(value, expected)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!conforms(parsed, expected)) return value;
  return parsed;
}

function dropOptionalNulls(obj: Record<string, unknown>, schema: JsonSchema | undefined): Record<string, unknown> {
  const req = requiredSet(schema);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((v === null || v === undefined) && !req.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function wrapBareStringArray(value: unknown, schema: JsonSchema | undefined): unknown {
  if (typeof value !== "string" || !schema) return value;
  if (!typesOf(schema).includes("array")) return value;
  if (conforms(value, schema)) return value;
  // after unstringify still a non-JSON plain string
  const items = schema.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    const itemTypes = typesOf(items as JsonSchema);
    if (itemTypes.includes("string") || itemTypes.length === 0) {
      return [value];
    }
  } else if (!items) {
    return [value];
  }
  return value;
}

function restringifyStringFields(
  obj: Record<string, unknown>,
  schema: JsonSchema | undefined,
): Record<string, unknown> {
  const props = propMap(schema);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const ps = props[k];
    out[k] = ps && typesOf(ps).includes("string") && (isPlainObject(v) || Array.isArray(v)) ? JSON.stringify(v) : v;
  }
  return out;
}

function repairObject(obj: Record<string, unknown>, schema: JsonSchema | undefined): Record<string, unknown> {
  let cur = dropOptionalNulls(obj, schema);
  const props = propMap(schema);

  // per-property unstringify + wrap
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cur)) {
    const ps = props[k];
    let val = maybeUnstringifyJson(v, ps);
    val = wrapBareStringArray(val, ps);
    next[k] = val;
  }
  cur = next;
  cur = restringifyStringFields(cur, schema);
  return cur;
}

/**
 * Apply schema-local repair to a tool's arguments object.
 * No-op when tool has no parameters schema (untyped path).
 */
export function schemaRepairArgs(
  toolName: string,
  args: Record<string, unknown>,
  tools?: ToolDef[],
): Record<string, unknown> {
  const schema = toolSchema(tools, toolName);
  if (!schema) return args;

  let cur: unknown = args;

  // root wrap: bare string → single required string field object
  if (typeof cur === "string") {
    const props = propMap(schema);
    const keys = Object.keys(props);
    const req = [...requiredSet(schema)];
    const targetKey = req.length === 1 ? req[0] : keys.length === 1 ? keys[0] : undefined;
    if (targetKey && typesOf(props[targetKey!]).includes("string")) {
      cur = { [targetKey]: cur };
    }
  }

  if (!isPlainObject(cur)) return args;
  return repairObject(cur, schema);
}

/**
 * True when `args` is missing a key the tool's schema lists in `required`
 * (S1). Dialect-agnostic, presence-only check — evaluate AFTER the repair
 * ladder above has had its chance (repair first, then judge), so a value
 * the ladder could still coerce into shape isn't flagged prematurely.
 *
 * No catalog / no parameters schema / no required array => inert (false).
 * Never guess required-ness from anything but the schema's own `required`.
 */
export function isMissingRequired(toolName: string, args: Record<string, unknown>, tools?: ToolDef[]): boolean {
  const schema = toolSchema(tools, toolName);
  const req = requiredSet(schema);
  if (req.size === 0) return false;
  for (const key of req) {
    if (!(key in args) || args[key] === undefined) return true;
  }
  return false;
}

/** Parse arguments JSON string, repair, re-emit JSON string. */
export function schemaRepairArgsJson(toolName: string, argsJson: string, tools?: ToolDef[]): string {
  let obj: unknown;
  try {
    obj = JSON.parse(argsJson);
  } catch {
    return argsJson;
  }
  if (!isPlainObject(obj)) return argsJson;
  const repaired = schemaRepairArgs(toolName, obj, tools);
  return JSON.stringify(repaired);
}
