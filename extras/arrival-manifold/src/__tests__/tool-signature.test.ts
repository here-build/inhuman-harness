import { describe, expect, it } from "vitest";

import { normalizeToolJsonSchema, toolSignature } from "../tool-signature.js";

describe("normalizeToolJsonSchema", () => {
  it("keeps the understood fields and renders them identically to a hand-written schema", () => {
    const normalized = normalizeToolJsonSchema({
      type: "object",
      properties: { q: { type: "string", description: "query" } },
      required: ["q"],
    });
    expect(normalized).toEqual({
      type: "object",
      properties: { q: { type: "string", description: "query" } },
      required: ["q"],
    });
    const sig = toolSignature("search", "Search", normalized);
    expect(sig.params.map((p) => p.name)).toEqual(["q"]);
  });

  it("drops unknown TOP-LEVEL keys lossily, never rejects the tool", () => {
    // An upstream server emitting $schema/$ref/title still binds and still renders with
    // the subset read here. A strict guard would refuse this tool at bind time.
    const normalized = normalizeToolJsonSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/Query",
      title: "A query the renderer never displays",
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(normalized).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(toolSignature("search", "Search", normalized).params.map((p) => p.name)).toEqual(["q"]);
  });

  it("drops unknown NESTED property keys but keeps the understood ones on the same property", () => {
    const normalized = normalizeToolJsonSchema({
      type: "object",
      properties: {
        filter: {
          $ref: "#/$defs/Filter",
          prefixItems: [{ type: "string" }],
          type: "object",
          properties: { field: { type: "string" } },
          required: ["field"],
        },
      },
    });
    expect(normalized).toEqual({
      type: "object",
      properties: {
        filter: { type: "object", properties: { field: { type: "string" } }, required: ["field"] },
      },
    });
  });

  it("recurses through anyOf/oneOf and items", () => {
    const normalized = normalizeToolJsonSchema({
      type: "object",
      properties: {
        x: { anyOf: [{ type: "string", $ref: "dropped" }, { type: "number" }] },
        ys: { type: "array", items: { type: "string", deprecated: true } },
      },
    });
    expect(normalized).toEqual({
      type: "object",
      properties: {
        x: { anyOf: [{ type: "string" }, { type: "number" }] },
        ys: { type: "array", items: { type: "string" } },
      },
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["string", "nope"],
  ])("returns undefined for a non-object %s (so outputSchema stays honest)", (_label, input) => {
    expect(normalizeToolJsonSchema(input)).toBeUndefined();
  });

  it("preserves enum/const/default/examples — the fields the renderer reads", () => {
    const normalized = normalizeToolJsonSchema({
      type: "object",
      properties: {
        unit: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" },
        limit: { type: "integer", minimum: 1, maximum: 100, examples: [10] },
        mode: { const: "fast" },
      },
    });
    expect(normalized).toMatchObject({
      properties: {
        unit: { enum: ["celsius", "fahrenheit"], default: "celsius" },
        limit: { minimum: 1, maximum: 100, examples: [10] },
        mode: { const: "fast" },
      },
    });
  });

  it("preserves the closed-world additionalProperties marker in both spellings", () => {
    const normalized = normalizeToolJsonSchema({
      type: "object",
      properties: {
        closed: { type: "object", additionalProperties: false, properties: {} },
        open: { type: "object", additionalProperties: { type: "string" } },
      },
    });
    expect(normalized).toMatchObject({
      properties: {
        closed: { additionalProperties: false },
        open: { additionalProperties: { type: "string" } },
      },
    });
  });
});

describe("toolSignature", () => {
  it("orders required properties before optional ones, each group in declared order", () => {
    // "b" is declared before "a" in properties, but only "a" is required — required must still come first.
    const sig = toolSignature("github_search-issues", "Search issues", {
      type: "object",
      properties: {
        b: { type: "number", description: "max results" },
        a: { type: "string", description: "query" },
      },
      required: ["a"],
    });
    expect(sig.params.map((p) => p.name)).toEqual(["a", "b"]);
    expect(sig.params[0]).toMatchObject({ name: "a", optional: false, typeToken: "string" });
    expect(sig.params[1]).toMatchObject({ name: "b", optional: true, typeToken: "number" });
  });

  it("renders enum properties as quoted-pipe alternatives regardless of declared type", () => {
    const sig = toolSignature("weather_get-forecast", "Get forecast", {
      type: "object",
      properties: { unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
      required: ["unit"],
    });
    expect(sig.params[0]?.typeToken).toBe('"celsius"|"fahrenheit"');
  });

  it("renders array-typed properties with no declared items as [value]", () => {
    const sig = toolSignature("slack_send", "Send a message", {
      type: "object",
      properties: { channels: { type: "array" } },
      required: ["channels"],
    });
    expect(sig.params[0]?.typeToken).toBe("[value]");
  });

  it("renders array-of-scalar as [<scalar>]", () => {
    const sig = toolSignature("slack_send", "Send a message", {
      type: "object",
      properties: { channels: { type: "array", items: { type: "string" } } },
      required: ["channels"],
    });
    expect(sig.params[0]?.typeToken).toBe("[string]");
  });

  it("renders array-of-object as [{field:type, ...}], required first, descriptions as comments", () => {
    const sig = toolSignature("airline_book-reservation", "Book a reservation", {
      type: "object",
      properties: {
        flights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              destination: { type: "string", description: "airport code" },
              origin: { type: "string" },
              date: { type: "string" },
            },
            required: ["origin", "destination"],
          },
        },
      },
      required: ["flights"],
    });
    expect(sig.params[0]?.typeToken).toBe("[{destination:string #|airport code|#, origin:string, date:string?}]");
  });

  it("recurses through nested array-of-objects — shapes render all the way down", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: {
        route: {
          type: "array",
          items: {
            type: "object",
            properties: {
              origin: { type: "string" },
              legs: { type: "array", items: { type: "object", properties: { to: { type: "string" } } } },
            },
            required: ["origin"],
          },
        },
      },
      required: ["route"],
    });
    expect(sig.params[0]?.typeToken).toBe("[{origin:string, legs:[{to:string?}]?}]");
  });

  it("renders top-level object params as {field:type, ...} with descriptions as inline #|…|# comments", () => {
    // A bare `:query value?` hides the nested keys, forcing the model to guess blindly at
    // the shape underneath. The shape must show its keys, and a field's description rides
    // as a reader-parseable block comment — but only when it says more than the field
    // name itself (case-insensitive).
    const sig = toolSignature("ct_search", undefined, {
      type: "object",
      properties: {
        query: {
          type: "object",
          description: "A set of search terms.",
          properties: {
            cond: { type: "string", description: "Search for conditions or diseases." },
            spons: { type: "string", description: "Search for sponsors or collaborators." },
            titles: { type: "string", description: "Titles." }, // == field name → no comment
          },
        },
      },
      required: ["query"],
    });
    expect(sig.params[0]?.typeToken).toBe(
      "{cond:string? #|Search for conditions or diseases.|#, spons:string? #|Search for sponsors or collaborators.|#, titles:string?}",
    );
  });

  it("renders anyOf unions as pipe alternatives, recursing into member shapes", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: {
        target: {
          anyOf: [
            { type: "string", description: "a plain id" },
            { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          ],
        },
      },
      required: ["target"],
    });
    expect(sig.params[0]?.typeToken).toBe("string|{id:string}");
  });

  it("renders oneOf identically to anyOf — a caller picks ONE shape either way", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: { when: { oneOf: [{ type: "string" }, { type: "number" }] } },
      required: ["when"],
    });
    expect(sig.params[0]?.typeToken).toBe("string|number");
  });

  it("renders a type ARRAY (nullable scalar) as a union with nil, deduplicating members", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: {
        limit: { type: ["number", "integer", "null"] },
      },
      required: ["limit"],
    });
    // number and integer collapse to one token; null is scheme's nil.
    expect(sig.params[0]?.typeToken).toBe("number|nil");
  });

  it("union members that are arrays or objects keep their full shape inside the union", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: {
        ids: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      },
      required: ["ids"],
    });
    expect(sig.params[0]?.typeToken).toBe("[string]|string");
  });

  it("renders an object with no declared properties as bare `object`", () => {
    const sig = toolSignature("t", undefined, {
      type: "object",
      properties: { blob: { type: "object" } },
      required: ["blob"],
    });
    expect(sig.params[0]?.typeToken).toBe("object");
  });

  it("falls back to value for an unknown or missing type with no enum", () => {
    const sig = toolSignature("misc_tool", "Does a thing", {
      type: "object",
      properties: { payload: {} },
      required: ["payload"],
    });
    expect(sig.params[0]?.typeToken).toBe("value");
  });

  it("handles a schema with no properties as a zero-arg tool", () => {
    const sig = toolSignature("ping_check", "Health check", { type: "object" });
    expect(sig.params).toEqual([]);
    expect(sig.signatureText).toBe("(ping_check) - Health check");
  });

  it("handles a fully absent schema the same as a zero-arg tool", () => {
    const sig = toolSignature("ping_check", "Health check", undefined);
    expect(sig.params).toEqual([]);
    expect(sig.signatureText).toBe("(ping_check) - Health check");
  });

  it("renders the full catalog line as :keyword pairs, with ? on optional, description in parens", () => {
    const sig = toolSignature("github_search-issues", "Search issues", {
      type: "object",
      properties: {
        query: { type: "string", description: "search text" },
        limit: { type: "number" },
      },
      required: ["query"],
    });
    expect(sig.signatureText).toBe("(github_search-issues :query string (search text) :limit number?) - Search issues");
  });

  it("omits the trailing description separator when the tool has no description", () => {
    const sig = toolSignature("ping_check", undefined, { type: "object" });
    expect(sig.signatureText).toBe("(ping_check)");
  });

  it("renders no -> suffix at all when no outputSchema is given (the common case)", () => {
    const sig = toolSignature("ping_check", "Health check", { type: "object" });
    expect(sig.signatureText).toBe("(ping_check) - Health check");
    expect(sig.signatureText).not.toContain("->");
  });

  it("renders the -> {field:type, ...} suffix when an outputSchema IS given, reusing the same required-then-optional ordering", () => {
    const sig = toolSignature(
      "weather_get-forecast",
      "Get the weather forecast",
      { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      {
        type: "object",
        properties: {
          conditions: { type: "string" },
          temp: { type: "number", description: "degrees celsius" },
        },
        required: ["temp"],
      },
    );
    expect(sig.signatureText).toBe(
      "(weather_get-forecast :city string) -> {temp:number (degrees celsius), conditions:string?} - Get the weather forecast",
    );
  });

  it("output fields carry no : prefix — descriptive, not a call-site keyword", () => {
    const sig = toolSignature(
      "ping_check",
      "Health check",
      { type: "object" },
      { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    );
    expect(sig.signatureText).toContain("-> {ok:boolean}");
    expect(sig.signatureText).not.toContain(":ok");
  });

  it("renders no -> suffix when outputSchema has no properties (present but empty)", () => {
    const sig = toolSignature("ping_check", "Health check", { type: "object" }, { type: "object" });
    expect(sig.signatureText).toBe("(ping_check) - Health check");
  });
});
