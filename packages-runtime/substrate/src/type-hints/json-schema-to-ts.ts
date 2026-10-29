// json-schema-to-ts — the S2 HARVEST: a tool's JSON Schema → a TypeScript type-string, and a
// tool's declared shape → its full arrow signature. This SUPERSEDES the zod harvest
// (`@here.build/arrival/type-layer`'s `assembleHarvestedPrelude(SymbolDef entries)`) for
// manifold's own type-hint prelude: bind.ts's kwargs contract decodes every property through
// the scheme-identity codec (`z.dynamic`) — every `SymbolDef.in`/`.out` is `unknown`-typed by
// design (bind.ts: "Every property decodes through the scheme-identity codec — we call
// `toJS` ourselves"), so harvesting from the SymbolDef gives the checker nothing to
// narrow against (zero diagnostics — the S2 gap this file exists to close). The tool's JSON
// Schema — carried untouched on `RemoteTool.inputSchema`/`.outputSchema`, and already read by
// `tool-signature.ts` for the catalog text — is the one place the ACTUAL declared shape lives.
//
// Pinned mapping (mirrors `tool-signature.ts`'s `typeToken`/`orderedFields` ordering rule so
// the catalog text and the type-hint prelude never diverge on what's required vs optional):
//   • enum (all-primitive members)   → a union of JSON.stringify'd literals (wins over `type`)
//   • string                         → string
//   • number / integer               → number
//   • boolean                        → boolean
//   • array (items: T)               → `List<T> | readonly T[]` — BOTH carriers admissible:
//     the model may write `'(...)`/`(list ...)` (lowers to `list(...)` → `List<T>`) or `#(...)`
//     (lowers to `[...]` → `readonly T[]`) for the same JSON-Schema array param. Advisory
//     polarity (doc: "never over-narrow; a false diagnostic is poison") — narrowing to only one
//     carrier would falsely flag the other as a type error.
//   • object (with properties)       → a CLOSED literal `{ a: X; b?: Y }`, required fields
//     first then optional, each group in declared order (`orderedEntries`, mirroring
//     `tool-signature.ts`'s `orderedFields`). Closed is deliberate: TS's excess-property check
//     on a FRESH object literal is exactly the typo detector (`lower.ts`'s `emitCallArgs` lowers
//     a tool call's `:key value` run to one inline object literal, so the freshness check fires).
//   • object (no properties)         → `Record<string, unknown>`
//   • missing / unrecognized `type`   → `unknown`
//   • recursion depth > 6            → `unknown` (JSON Schemas are finite data, but a total
//     harvest never throws or infinitely recurses on a pathological/cyclic-looking schema).
//
// R (the tool call's RETURN type) — see `toolArrowType`'s header comment for the bind.ts /
// server.ts finding that pins it to `unknown` for v1.

import { assemblePreludeFromSignatures, type HarvestedPrelude } from "@here.build/arrival/type-layer";

import type { JsonSchemaProperty, ToolJsonSchema } from "../tool-schema.js";

/** Recursion depth cap (array items / object fields) — a total harvest never throws or
 *  infinitely recurses; anything nested this deep degrades to `unknown` rather than blocking
 *  the whole prelude assembly on one pathological schema. */
const MAX_DEPTH = 6;

/** An object-property / dict key prints bare when identifier-safe, else JSON-quoted — matches
 *  `lower.ts`'s `propKey` so a harvested field name and the emitted object-literal key agree. */
const IDENT = /^[A-Z_$][\w$]*$/i;
function objectKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Required fields first, then optional, each group in declared order — the SAME ordering rule
 *  as `tool-signature.ts`'s `orderedFields` (kept as a local twin: that helper isn't exported,
 *  and the two harvests read a plain `{properties, required}` shape rather than sharing state). */
function orderedEntries(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: readonly string[] } | undefined,
): Array<{ name: string; optional: boolean; prop: JsonSchemaProperty }> {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required);
  const entries = Object.entries(properties);
  const requiredFields = entries.filter(([name]) => required.has(name));
  const optionalFields = entries.filter(([name]) => !required.has(name));
  return [...requiredFields, ...optionalFields].map(([name, prop]) => ({
    name,
    optional: !required.has(name),
    prop,
  }));
}

/** A closed object-literal type from a `{properties, required}` shape (a tool's whole input
 *  schema, or one nested object-typed property/array-item). `undefined`/empty `properties` →
 *  `Record<string, unknown>` (an open shape — nothing to narrow against, never `{}` which would
 *  itself reject every property read). */
function objectLiteralType(
  schema: { properties?: Record<string, JsonSchemaProperty>; required?: readonly string[] },
  depth: number,
): string {
  if (schema.properties === undefined || Object.keys(schema.properties).length === 0) {
    return "Record<string, unknown>";
  }
  const fields = orderedEntries(schema).map(
    ({ name, optional, prop }) => `${objectKey(name)}${optional ? "?" : ""}: ${jsonSchemaTypeToTs(prop, depth + 1)}`,
  );
  return `{ ${fields.join("; ")} }`;
}

/**
 * One JSON-Schema property → its TypeScript type-string (see the pinned mapping above). `depth`
 * bounds array/object recursion; callers outside this file never pass it.
 */
export function jsonSchemaTypeToTs(prop: JsonSchemaProperty | undefined, depth = 0): string {
  if (prop === undefined) return "unknown";
  if (depth > MAX_DEPTH) return "unknown";

  // enum wins over the declared `type` regardless — the more precise constraint (mirrors
  // tool-signature.ts's typeToken). A non-primitive enum member (object/array) has no clean TS
  // literal image — fall through to the declared `type` instead of emitting an unrepresentable one.
  if (prop.enum !== undefined && prop.enum.length > 0 && prop.enum.every(isPrimitive)) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  switch (prop.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const elem = jsonSchemaTypeToTs(prop.items, depth + 1);
      return `List<${elem}> | readonly ${elem}[]`;
    }
    case "object":
      return objectLiteralType(prop, depth);
    default:
      // Some real-world tool schemas omit `type: "object"` on a nested shape and rely on
      // `properties` alone — still recognizable as an object.
      return prop.properties === undefined ? "unknown" : objectLiteralType(prop, depth);
  }
}

/**
 * The full arrow signature for one tool call. `lower.ts`'s `emitCallArgs` folds a call's
 * `:key value` run into ONE trailing object literal (`(t :a 1)` → `t({ a: 1 })`), so the arrow
 * is `(kwargs: {…}) => R` — never a positional parameter list. `kwargs` itself is optional
 * (`kwargs?: {…}`) iff the schema has no required properties (the model may legally call
 * `(tool)`, which lowers to `tool()`); a schema with no properties at all drops the parameter
 * entirely (`() => R`).
 *
 * R — THE RETURN TYPE — is `unknown` for v1, by design, not oversight. Tracing what a tool call
 * actually hands back to the model (bind.ts's `rosettaDef` → `tool.invoke()` → `unwrapToolResult`
 * in `server.ts`, the H-5 rules exercised by `unwrap.test.ts`):
 *   - `structuredContent` wins ONLY when the upstream server actually returns it (rule 2) — an
 *     opt-in MCP capability. bind.ts's own comment: "Most MCP servers today declare none [an
 *     outputSchema]" — and even when a server DOES declare one, arrival-manifold performs no
 *     runtime validation that the returned `structuredContent` actually conforms to it.
 *   - Absent `structuredContent`, a single text block JSON-parses (rule 3) or the raw content
 *     array passes through untouched (rule 4) — NEITHER is shaped like the declared
 *     `outputSchema`.
 *   So "the structured content reaches the model unchanged" is true only conditionally
 *   (server-dependent, unverified), never as a property of the harvest itself. Typing R from
 *   `outputSchema` unconditionally would produce false property-access diagnostics on the
 *   (today: near-universal) tools that return plain text/parsed JSON in a different shape —
 *   exactly the "wrong return typing = false positives = poison" failure this harvest is built
 *   to avoid. `outputSchema` is accepted (for forward-compatibility with a future runtime that
 *   validates `structuredContent` against it) but currently unused.
 */
export function toolArrowType(schema: ToolJsonSchema | undefined, _outputSchema?: ToolJsonSchema): string {
  const RETURN_TYPE = "unknown";
  const properties = schema?.properties ?? {};
  if (Object.keys(properties).length === 0) return `() => ${RETURN_TYPE}`;
  const required = new Set(schema?.required);
  const kwargsType = objectLiteralType({ properties, required: schema?.required }, 0);
  return `(kwargs${required.size > 0 ? "" : "?"}: ${kwargsType}) => ${RETURN_TYPE}`;
}

/**
 * Assemble the manifold's own type-hint prelude directly from tool JSON Schemas — no
 * `SymbolDef`/zod in the path. `qualifiedName` is the same `${server-slug}/${tool-name}` bind.ts
 * binds (a non-TS-identifier like `server/tool` lands in the `_` namespace automatically, via the
 * prelude assembler's own escape — see `name-escape.ts`; the lowering emits the matching
 * `_.server$slash$tool(...)` access, so no special-casing is needed here).
 */
export function assembleManifoldPrelude(
  tools: Iterable<readonly [qualifiedName: string, input: ToolJsonSchema | undefined, output?: ToolJsonSchema]>,
): HarvestedPrelude {
  const entries = Array.from(tools, ([name, input, output]): readonly [string, string] => [
    name,
    toolArrowType(input, output),
  ]);
  return assemblePreludeFromSignatures(entries);
}
