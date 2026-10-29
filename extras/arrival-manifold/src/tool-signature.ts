// tool-signature — turns a remote tool's JSON Schema into an ordered kwarg param list
// (required first, optional second, each in declared order) plus a one-line catalog
// signature. `(server/tool :prop1 value1 :prop2 value2)` — arrival's kwargs runtime
// (bakeRosetta) folds `:key value` pairs into an object before decode (bind.ts).
//
// The JSON-Schema shapes and `orderedFields` reuse substrate's `tool-schema.ts`.
// The kwargs-catalog RENDERER stays here, binder-side: a positional consumer would
// render signatures differently.

import {
  orderedFields,
  type JsonSchemaProperty,
  type ToolJsonSchema,
  type KwargParam,
  type ToolSignature,
} from "@inhuman.tools/substrate";

/** Recursion ceiling for nested shape rendering. Deep enough for every real MCP schema
 *  seen in the wild; a pathological deeper schema degrades to "value"/"[value]" rather
 *  than exploding the catalog line. */
const MAX_SHAPE_DEPTH = 6;

/** A nested field's description rides as an inline scheme block comment — but only when
 *  it says something the field NAME doesn't already say (case-insensitive; a trailing
 *  period doesn't count as saying more). `#|…|#` is the reader's own comment syntax, so
 *  a signature shape pasted into a program stays parseable. */
function fieldComment(name: string, prop: JsonSchemaProperty): string {
  const desc = prop.description?.trim();
  if (!desc) return "";
  if (desc.replace(/\.$/, "").toLowerCase() === name.toLowerCase()) return "";
  return ` #|${desc.replaceAll("|#", "|\u0023")}|#`;
}

/** Render an object schema's fields as `{field:type #|desc|#, ...}`, recursively. */
function objectToken(prop: JsonSchemaProperty, depth: number): string {
  if (depth >= MAX_SHAPE_DEPTH) return "value";
  const fields = orderedFields(prop).map(
    ({ name, optional, prop: field }) =>
      `${name}:${typeToken(field, depth + 1)}${optional ? "?" : ""}${fieldComment(name, field)}`,
  );
  return fields.length > 0 ? `{${fields.join(", ")}}` : "object";
}

/** Render array `items` as `[<elem>]` — `[string]`, `[{field:type, ...}]`, `[value]`
 *  when the element type is undeclared. */
function arrayToken(items: JsonSchemaProperty | undefined, depth: number): string {
  if (depth >= MAX_SHAPE_DEPTH) return "[value]";
  if (!items) return "[value]";
  return `[${typeToken(items, depth)}]`;
}

/** One property's catalog type token — enum wins regardless of declared `type`;
 *  scalars map to their Scheme-ish reading; arrays and objects render their SHAPE
 *  recursively (the nested keys are exactly what a caller must author — hiding them
 *  behind "value" cost 1.9pp on MCP-Atlas, the clinicaltrials 34-blind-guesses task);
 *  everything else is "value". */
function typeToken(prop: JsonSchemaProperty, depth = 0): string {
  if (prop.enum && prop.enum.length > 0) return prop.enum.map((v) => JSON.stringify(v)).join("|");
  // Unions: anyOf/oneOf members render as pipe alternatives (the same convention enum
  // already established); a type ARRAY (["string","null"]) is the scalar-union spelling.
  const members = prop.anyOf ?? prop.oneOf;
  if (members && members.length > 0) {
    const tokens = [...new Set(members.map((m) => typeToken(m, depth)))];
    return tokens.join("|");
  }
  if (Array.isArray(prop.type)) {
    const tokens = [...new Set(prop.type.map((t) => typeToken({ ...prop, type: t }, depth)))];
    return tokens.join("|");
  }
  if (prop.type === "object" || (prop.type === undefined && prop.properties)) {
    return objectToken(prop, depth);
  }
  switch (prop.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "nil";
    case "array":
      return arrayToken(prop.items, depth);
    default:
      return "value";
  }
}

/** Lossily normalize an upstream MCP tool's JSON Schema into the `ToolJsonSchema` this
 *  binder consumes.
 *
 *  WHY NOT an `as` (what this replaces): the SDK types `Tool["inputSchema"]` with
 *  `properties` as `Record<string, object>` — too loose to read — while an upstream
 *  server may emit richer JSON Schema this renderer does not model (`$ref`, `allOf` at
 *  the top level, `if/then/else`, `prefixItems`, …). The cast claimed the whole wire
 *  object was exactly the understood subset; it is not.
 *
 *  WHY NOT a guard: a tool whose schema carries a richer construct still BINDS and still
 *  renders with the subset read here — silently lossy, never failing. A strict guard
 *  would NEWLY REJECT that tool at bind time, on every hard AND soft refresh. Losing the
 *  unknown keys is the same degradation the cast already produced; rejecting the tool is
 *  a behavior change. So: keep exactly the fields `JsonSchemaProperty` declares, recurse
 *  into the nested shapes the renderer walks, drop everything else. */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function normalizeProperty(input: unknown): JsonSchemaProperty {
  if (!isRecord(input)) return {};
  const src = input;
  const out: JsonSchemaProperty = {};
  if (typeof src.type === "string" || (Array.isArray(src.type) && src.type.every((t) => typeof t === "string"))) {
    out.type = src.type;
  }
  if (typeof src.description === "string") out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum;
  if (Array.isArray(src.anyOf)) out.anyOf = src.anyOf.map(normalizeProperty);
  if (Array.isArray(src.oneOf)) out.oneOf = src.oneOf.map(normalizeProperty);
  if (typeof src.items === "object" && src.items !== null) out.items = normalizeProperty(src.items);
  if (typeof src.minItems === "number") out.minItems = src.minItems;
  if (typeof src.maxItems === "number") out.maxItems = src.maxItems;
  if (isRecord(src.properties)) out.properties = normalizeProperties(src.properties);
  if (Array.isArray(src.required) && src.required.every((r) => typeof r === "string")) {
    out.required = src.required;
  }
  if (typeof src.additionalProperties === "boolean") {
    out.additionalProperties = src.additionalProperties;
  } else if (typeof src.additionalProperties === "object" && src.additionalProperties !== null) {
    out.additionalProperties = normalizeProperty(src.additionalProperties);
  }
  if (typeof src.minimum === "number") out.minimum = src.minimum;
  if (typeof src.maximum === "number") out.maximum = src.maximum;
  if (Array.isArray(src.examples)) out.examples = src.examples;
  if ("default" in src) out.default = src.default;
  if ("const" in src) out.const = src.const;
  return out;
}

function normalizeProperties(src: Record<string, unknown>): Record<string, JsonSchemaProperty> {
  const out: Record<string, JsonSchemaProperty> = {};
  for (const [name, prop] of Object.entries(src)) out[name] = normalizeProperty(prop);
  return out;
}

/** Top-level lossy normalization of a tool's input/output schema. Returns `undefined`
 *  only when the wire value carries no usable schema, so `outputSchema` stays honest. */
export function normalizeToolJsonSchema(input: unknown): ToolJsonSchema | undefined {
  if (!isRecord(input)) return undefined;
  const src = input;
  const out: ToolJsonSchema = {};
  if (src.type === "object") out.type = "object";
  if (isRecord(src.properties)) out.properties = normalizeProperties(src.properties);
  if (Array.isArray(src.required) && src.required.every((r) => typeof r === "string")) {
    out.required = src.required;
  }
  // Everything else ($schema, $ref, allOf/oneOf at the top level, title, …) is dropped.
  return out;
}

/** Required first, optional second, each group in declaration order (the same
 *  ordering governs both input kwargs and the descriptive return shape). */
function orderedParams(schema: ToolJsonSchema | undefined): KwargParam[] {
  return orderedFields(schema).map(({ name, optional, prop }) => ({
    name,
    optional,
    typeToken: typeToken(prop),
    schema: prop,
  }));
}

/** The `-> {field:type, ...}` suffix for a tool's declared return shape (no `:` prefix
 *  — these are descriptive, never typed). `undefined` when the shape is empty or
 *  absent; the preamble explains the default once per crate. */
function renderOutputShape(outputSchema: ToolJsonSchema | undefined): string | undefined {
  const params = orderedParams(outputSchema);
  if (params.length === 0) return undefined;
  const fields = params.map((p) => {
    const optionalMark = p.optional ? "?" : "";
    const descSuffix = p.schema.description ? ` (${p.schema.description})` : "";
    return `${p.name}:${p.typeToken}${optionalMark}${descSuffix}`;
  });
  return `{${fields.join(", ")}}`;
}

export function toolSignature(
  qualifiedName: string,
  description: string | undefined,
  schema: ToolJsonSchema | undefined,
  outputSchema?: ToolJsonSchema,
): ToolSignature {
  const params = orderedParams(schema);

  const paramTokens = params.map((p) => {
    const optionalMark = p.optional ? "?" : "";
    const descSuffix = p.schema.description ? ` (${p.schema.description})` : "";
    return `:${p.name} ${p.typeToken}${optionalMark}${descSuffix}`;
  });
  const head = paramTokens.length > 0 ? `${qualifiedName} ${paramTokens.join(" ")}` : qualifiedName;
  const outputShape = renderOutputShape(outputSchema);
  const outputSuffix = outputShape ? ` -> ${outputShape}` : "";
  const signatureText = description ? `(${head})${outputSuffix} - ${description}` : `(${head})${outputSuffix}`;

  return { params, signatureText };
}
