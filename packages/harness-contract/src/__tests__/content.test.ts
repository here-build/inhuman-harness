import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { packContent, unpackContent } from "../schema/content.js";

describe("content references", () => {
  it("shares equal bodies and preserves literal objects and hostile-looking keys", () => {
    const text = "same body".repeat(100);
    const input = JSON.stringify({ revision: 1, first: text, list: [text, { $text: text }], __proto__: null });
    const encoded = packContent(input, (body) => createHash("sha256").update(body).digest("hex"));
    expect(encoded.texts.size).toBe(1);
    expect(encoded.packed.texts).toHaveLength(3);
    expect(
      unpackContent(encoded.packed, (hash) => {
        const body = encoded.texts.get(hash);
        if (body === undefined) throw new Error("missing content");
        return body;
      }),
    ).toBe(input);
  });

  it("preserves own prototype keys and distinct unpaired Unicode surrogates", () => {
    const first = "x".repeat(64) + "\ud800";
    const second = "x".repeat(64) + "\ud801";
    const input = JSON.stringify(
      Object.fromEntries([
        ["__proto__", first],
        ["other", second],
      ]),
    );
    const encoded = packContent(input, (body) => createHash("sha256").update(JSON.stringify(body)).digest("hex"));
    expect(encoded.texts.size).toBe(2);
    const result = unpackContent(encoded.packed, (hash) => encoded.texts.get(hash) ?? "missing");
    expect(result).toBe(input);
  });
});
