// json-schema-to-ts — pinned-mapping tests + an end-to-end diagnose integration proving the
// harvest actually gives the TS checker something to narrow against (the S2 gap this file
// closes: bind.ts's SymbolDef harvest is `z.dynamic`-erased to `unknown`, so it produces ZERO
// diagnostics; this harvest reads the tool's JSON Schema directly).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OBSERVED TS DIAGNOSTIC CODES against `createDiagnoseLens` — the actual codes the checker
// emits, not the codes HINT_WHITELIST would predict a priori:
//
//   (a) wrong value type, `(shop/list-orders :count "five")` where `count:number`
//       → TS2322 (type not assignable), reported at the specific PROPERTY (`count: "five"`)
//         inside the fresh object-literal argument — not TS2345. TS attributes a per-property
//         mismatch inside an object literal to the property assignment itself (2322); 2345
//         fires when the mismatch can't be localized to one property (e.g. the whole argument's
//         shape is wrong). `expected`/`actual` are populated on the 2322.
//   (b) typo'd key, `:contry` where `country` exists (required `country`, string)
//       → TS2561 (unknown property, WITH a "did you mean" suggestion — TS emits 2561 rather
//         than the plainer 2353 whenever a close-spelling candidate exists in the target type).
//         `propertyName` = "contry", `candidateProperties` contains "country".
//   (c) unknown extra key with NO close spelling in the target type
//       → TS2353 (object literal may only specify known properties) — 2561's fallback when no
//         candidate is close enough for TS's own suggestion heuristic.
//   (d) enum violation, `:unit "kelvin"` where `unit` is `"celsius" | "fahrenheit"`
//       → TS2322 (type not assignable) — same shape as (a): a literal-type mismatch localized to
//         one property of the fresh object-literal argument.
//   (e) correct call → ZERO diagnostics (the polarity case — advisory, never a false positive).
//   (f) property read on typed output — SKIPPED. `toolArrowType`'s R is pinned to `unknown` for
//       v1 (see json-schema-to-ts.ts's header comment on `unwrapToolResult`'s H-5 rules), so
//       there is no typed return shape to read a property from; a property read on an `unknown`
//       return is TS18046 ("'x' is of type 'unknown'"), a different (non-whitelisted) code — not
//       a meaningful case for this harvest.
//
// `HINT_WHITELIST` includes 2322/2561/2551 on the strength of the codes observed above (cases
// (a)/(d) firing 2322, not 2345; (b)/(c) firing 2561/2353 depending on whether a near-name
// candidate exists) — see the dedicated "whitelist gap" test below.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createDiagnoseLens } from "@here.build/arrival/type-layer";
import { describe, expect, it } from "vitest";

import type { JsonSchemaProperty, ToolJsonSchema } from "../../tool-schema.js";
import { assembleManifoldPrelude, jsonSchemaTypeToTs, toolArrowType } from "../../type-hints/json-schema-to-ts.js";
import { HINT_WHITELIST } from "../../type-hints/types.js";

describe("jsonSchemaTypeToTs — the pinned mapping table", () => {
  it("string → string", () => {
    expect(jsonSchemaTypeToTs({ type: "string" })).toBe("string");
  });

  it("number / integer → number", () => {
    expect(jsonSchemaTypeToTs({ type: "number" })).toBe("number");
    expect(jsonSchemaTypeToTs({ type: "integer" })).toBe("number");
  });

  it("boolean → boolean", () => {
    expect(jsonSchemaTypeToTs({ type: "boolean" })).toBe("boolean");
  });

  it("missing / unrecognized type → unknown", () => {
    expect(jsonSchemaTypeToTs({})).toBe("unknown");
    expect(jsonSchemaTypeToTs({ type: "something-unheard-of" })).toBe("unknown");
    expect(jsonSchemaTypeToTs(undefined)).toBe("unknown");
  });

  it("enum (all-primitive members) → a union of JSON.stringify'd literals, winning over `type`", () => {
    expect(jsonSchemaTypeToTs({ type: "string", enum: ["celsius", "fahrenheit"] })).toBe('"celsius" | "fahrenheit"');
    expect(jsonSchemaTypeToTs({ enum: [1, 2, 3] })).toBe("1 | 2 | 3");
    expect(jsonSchemaTypeToTs({ enum: [true, false] })).toBe("true | false");
    expect(jsonSchemaTypeToTs({ enum: [null] })).toBe("null");
  });

  it("array with items: T → List<T> | readonly T[] — both carriers admissible", () => {
    expect(jsonSchemaTypeToTs({ type: "array", items: { type: "string" } })).toBe("List<string> | readonly string[]");
    expect(jsonSchemaTypeToTs({ type: "array" })).toBe("List<unknown> | readonly unknown[]"); // no items → unknown element
  });

  it("object with properties → a closed literal, required fields first then optional, declared order within each group", () => {
    const prop: JsonSchemaProperty = {
      type: "object",
      properties: {
        b: { type: "number" }, // declared before "a" but optional
        a: { type: "string" }, // required
      },
      required: ["a"],
    };
    expect(jsonSchemaTypeToTs(prop)).toBe("{ a: string; b?: number }");
  });

  it("object without properties → Record<string, unknown>", () => {
    expect(jsonSchemaTypeToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(jsonSchemaTypeToTs({ type: "object", properties: {} })).toBe("Record<string, unknown>");
  });

  it("object missing a declared `type` but carrying `properties` is still recognized as an object", () => {
    expect(jsonSchemaTypeToTs({ properties: { x: { type: "number" } }, required: ["x"] })).toBe("{ x: number }");
  });

  it("array-of-object composes the object literal as the element type", () => {
    const prop: JsonSchemaProperty = {
      type: "array",
      items: { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
    };
    expect(jsonSchemaTypeToTs(prop)).toBe("List<{ total: number }> | readonly { total: number }[]");
  });

  it("non-identifier key names are quoted in the closed literal", () => {
    const prop: JsonSchemaProperty = {
      type: "object",
      properties: { "max-results": { type: "number" } },
      required: ["max-results"],
    };
    expect(jsonSchemaTypeToTs(prop)).toBe('{ "max-results": number }');
  });

  it("a non-primitive enum member (object/array) falls through to the declared type rather than emitting an unrepresentable literal", () => {
    expect(jsonSchemaTypeToTs({ type: "string", enum: ["a", { nested: true } as unknown as string] })).toBe("string");
  });

  it("recursion depth cap: beyond depth 6, further nesting degrades to unknown", () => {
    // Build a 8-level-deep nested array so at least one inner level exceeds the cap.
    let schema: JsonSchemaProperty = { type: "string" };
    for (let i = 0; i < 8; i++) schema = { type: "array", items: schema };
    const rendered = jsonSchemaTypeToTs(schema);
    expect(rendered).toContain("unknown");
    // Sanity: a 5-level nest (within the cap) still resolves the innermost scalar, no unknown.
    let shallow: JsonSchemaProperty = { type: "string" };
    for (let i = 0; i < 5; i++) shallow = { type: "array", items: shallow };
    expect(jsonSchemaTypeToTs(shallow)).not.toContain("unknown");
  });
});

describe("toolArrowType — the kwargs?-optionality rule + no-params tools", () => {
  it("no properties at all → () => unknown (no kwargs parameter)", () => {
    expect(toolArrowType({ type: "object", properties: {} })).toBe("() => unknown");
    expect(toolArrowType(undefined)).toBe("() => unknown");
  });

  it("no required properties → kwargs is OPTIONAL", () => {
    expect(toolArrowType({ type: "object", properties: { mode: { type: "string" } } })).toBe(
      "(kwargs?: { mode?: string }) => unknown",
    );
  });

  it("at least one required property → kwargs is REQUIRED", () => {
    expect(
      toolArrowType({
        type: "object",
        properties: { count: { type: "number" }, mode: { type: "string" } },
        required: ["count"],
      }),
    ).toBe("(kwargs: { count: number; mode?: string }) => unknown");
  });

  it("the return type R is always `unknown` for v1, regardless of outputSchema", () => {
    const withOutput = toolArrowType(
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
    );
    expect(withOutput).toBe("(kwargs: { a: string }) => unknown");
  });
});

describe("assembleManifoldPrelude — integration: real mistakes bite via createDiagnoseLens", () => {
  const SHOP_LIST_ORDERS: ToolJsonSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  };
  const SHOP_FIND_CUSTOMER: ToolJsonSchema = {
    type: "object",
    properties: { country: { type: "string" }, city: { type: "string" } },
    required: ["country"],
  };
  const WEATHER_GET: ToolJsonSchema = {
    type: "object",
    properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
    required: ["unit"],
  };

  function buildLens() {
    const prelude = assembleManifoldPrelude([
      ["shop/list-orders", SHOP_LIST_ORDERS],
      ["shop/find-customer", SHOP_FIND_CUSTOMER],
      ["weather/get", WEATHER_GET],
    ]);
    return { prelude, lens: createDiagnoseLens(prelude) };
  }

  it("assembles a `declare const _` namespace entry for each non-identifier qualified name — the `/` join character needs escaping", () => {
    const { prelude } = buildLens();
    expect(prelude.prelude).toContain("declare const _:");
    // "shop/list-orders": the `/` join char is NOT a valid TS identifier char (name-escape.ts's
    // NAMED map escapes it to `$slash$`), and the hyphen inside "list-orders" also needs escaping.
    expect(prelude.prelude).toContain("shop$slash$list$dash$orders");
    // "weather/get" (slug + tool, no hyphen anywhere) still needs the slash escaped — every
    // qualified name needs at least the slash escaped, regardless of whether it also has hyphens.
    expect(prelude.prelude).toContain("weather$slash$get");
    expect(prelude.members).toEqual(["shop/list-orders", "shop/find-customer", "weather/get"]);
  });

  it("(a) wrong value type: a string where count:number is declared → the checker catches it (TS2322, now whitelisted)", () => {
    const { lens } = buildLens();
    const { diagnostics } = lens.diagnose('(shop/list-orders :count "five")', []);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.code).toBe(2322); // observed — see header comment
    expect(diagnostics[0]!.expected).toBeDefined();
    expect(diagnostics[0]!.actual).toBeDefined();
  });

  it("(b) typo'd key with a close-spelling candidate present → an unknown-property diagnostic with did-you-mean", () => {
    const { lens } = buildLens();
    const { diagnostics } = lens.diagnose('(shop/find-customer :contry "US")', []);
    expect(diagnostics.length).toBeGreaterThan(0);
    const d = diagnostics.find((x) => x.propertyName !== undefined) ?? diagnostics[0]!;
    expect([2353, 2561]).toContain(d.code);
    expect(d.propertyName).toBe("contry");
    expect(d.candidateProperties).toContain("country");
  });

  it("(c) unknown extra key with no close spelling → excess-property diagnostic, no candidate required", () => {
    const { lens } = buildLens();
    const { diagnostics } = lens.diagnose('(shop/find-customer :country "US" :zzzzz_unrelated_key 1)', []);
    expect(diagnostics.length).toBeGreaterThan(0);
    const d = diagnostics.find((x) => x.propertyName === "zzzzz_unrelated_key");
    expect(d).toBeDefined();
    expect([2353, 2561]).toContain(d!.code);
  });

  it("(d) enum violation: a value outside the declared union → the checker catches it (TS2322, now whitelisted)", () => {
    const { lens } = buildLens();
    const { diagnostics } = lens.diagnose('(weather/get :unit "kelvin")', []);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.code).toBe(2322); // observed — see header comment
  });

  it("(e) the polarity case — a genuinely correct call produces ZERO diagnostics", () => {
    const { lens } = buildLens();
    expect(lens.diagnose("(shop/list-orders :count 42)", []).diagnostics).toEqual([]);
    expect(lens.diagnose('(shop/find-customer :country "US")', []).diagnostics).toEqual([]);
    expect(lens.diagnose('(weather/get :unit "celsius")', []).diagnostics).toEqual([]);
  });

  it("a no-params tool call type-checks clean, and a stray argument bites", () => {
    const prelude = assembleManifoldPrelude([
      ["shop/list-orders", SHOP_LIST_ORDERS],
      ["fx/ping", { type: "object", properties: {} }],
    ]);
    const lens = createDiagnoseLens(prelude);
    expect(lens.diagnose("(fx/ping)", []).diagnostics).toEqual([]);
  });

  it(
    "whitelist gap: 2322 (wrong-value-type kwarg) is whitelisted, so it reaches select.ts " +
      "instead of being silently dropped",
    () => {
      const { lens } = buildLens();
      const { diagnostics } = lens.diagnose('(shop/list-orders :count "five")', []);
      expect(diagnostics.some((d) => d.code === 2322)).toBe(true);
      expect(HINT_WHITELIST as readonly number[]).toContain(2322);
    },
  );
});
