// End-to-end: the normalizer-parser prelude symbols (response-normalizer §3.5, inferred
// zone) are bound by `buildManifoldEnv` and callable from model-authored scheme through
// the manifold REPL tool. The pure-function layer is covered by normalizer-prelude.test.ts;
// THIS file covers the binding seam (bind.ts `normalizerSymbols`) — scheme string in,
// lifted value out, refusal as a recoverable in-REPL condition (never a crash).
import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

async function repl() {
  const manifoldEnv = await buildManifoldEnv([]);
  return createManifoldTool(manifoldEnv, "CATALOG");
}

describe("normalizer prelude symbols through the manifold REPL", () => {
  it("(parse-json s) parses an object and composes with accessors", async () => {
    const tool = await repl();
    const result = await tool.call({ expr: String.raw`(:a (parse-json "{\"a\": 41}"))` });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("41");
  });

  it("(parse-json s) on a scalar string is a recoverable in-REPL error naming the reason", async () => {
    const tool = await repl();
    const result = await tool.call({ expr: '(parse-json "123")' });
    // Refusal surfaces as an error OBSERVATION (errors-as-doors), not a transport failure.
    expect(textOf(result)).toMatch(/json.*(scalar|object|array)/i);
  });

  it("(parse-py-literal s) recovers a str(dict) payload", async () => {
    const tool = await repl();
    const result = await tool.call({
      expr: "(:is_paused (parse-py-literal \"{'dag_id': 'x', 'is_paused': False}\"))",
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/#f|false/i);
  });

  it("(detect-parse s) auto-detects CSV into records", async () => {
    const tool = await repl();
    const result = await tool.call({
      expr: String.raw`(:city (vector-ref (detect-parse "name,age,city\nAda,36,London\nAlan,41,Manchester") 0))`,
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("London");
  });

  it("(detect-parse s) on prose refuses with the teaching hint", async () => {
    const tool = await repl();
    const result = await tool.call({ expr: String.raw`(detect-parse "Commit history:\nCommit abc")` });
    expect(textOf(result)).toContain("no recognized format");
  });

  it("(parse-json v) on a non-string is a type refusal, not a crash", async () => {
    const tool = await repl();
    const result = await tool.call({ expr: "(parse-json 42)" });
    expect(textOf(result)).toMatch(/expected a string/i);
  });

  it("does not collide with the s/* validator family (both bound)", async () => {
    const tool = await repl();
    const result = await tool.call({ expr: '(s/string "ok")' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("ok");
  });
});
