// STRINGLY-COLLECTION hint door — e2e coverage through a real `ManifoldTool` (armed with
// `trace`, mirroring provenance-arming.test.ts's harness) proving `manifold-tool.ts`'s
// `errorEnricher: createStringlyCollectionEnricher(trace)` wiring actually reaches the
// error observation a model sees when a collection op refuses a stringly-typed tool
// response (normalizer/hint-door.ts).

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

const CSV_BODY = "name,age,city\nAlice,30,NYC\nBob,25,LA\nCara,22,SF";
const JSON_BODY = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]);
const PROSE_BODY = "Commit history: initial commit, fix the flaky test, add the export.";

async function fakeToolWorld(responseBody: string, opts: { armTrace?: boolean } = {}) {
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "t",
      tools: [
        {
          name: "fake",
          description: "returns a fixed string response",
          inputSchema: { type: "object", properties: {} },
          invoke: async () => responseBody,
        },
      ],
    },
  ]);
  const armTrace = opts.armTrace ?? true;
  const tool: ManifoldTool = createManifoldTool(manifoldEnv, "CATALOG", armTrace ? { trace: manifoldEnv.trace } : {});
  return { manifoldEnv, tool };
}

describe("stringly-collection hint door", () => {
  it("CSV response, direct collection-op misuse — hint names the tool and 'csv'", async () => {
    const { tool } = await fakeToolWorld(CSV_BODY);
    // define + misuse in ONE call: per-call provenance GC (manifold-tool's finally
    // trace.clear()) means tool ATTRIBUTION is within-call; cross-call misuse still
    // hints, generically (see the dedicated cross-call test below).
    const result = await tool.call({ expr: ["(define r (t/fake))", "(vector-ref r 0)"] });
    // Multi-form program: statement 1 succeeds, so call-level isError stays unset
    // (partial success is the REPL contract) — the hint rides the error OBSERVATION.
    const text = textOf(result);
    expect(text).toContain("Error");
    expect(text).toContain("t/fake");
    expect(text).toContain("csv");
    expect(text).toContain("parse-csv");
    expect(text).toContain("detect-parse");
  });

  it("JSON response, direct collection-op misuse — hint names 'json'", async () => {
    const { tool } = await fakeToolWorld(JSON_BODY);
    const result = await tool.call({ expr: ["(define r (t/fake))", "(take r 2)"] });
    const text = textOf(result);
    expect(text).toContain("Error");
    expect(text).toContain("t/fake");
    expect(text).toContain("json");
    expect(text).toContain("parse-json");
  });

  it("prose response — never phrase a guess as a fact: NO hint fires", async () => {
    const { tool } = await fakeToolWorld(PROSE_BODY);
    await tool.call({ expr: "(define r (t/fake))" });
    const result = await tool.call({ expr: "(car r)" });
    expect(result.isError).toBeTruthy();
    const text = textOf(result);
    expect(text).not.toContain("hint");
    expect(text).not.toContain("parse-json");
    expect(text).not.toContain("parse-csv");
  });

  it("second identical (tool, format) failure renders the terse line, not the verbose block", async () => {
    const { tool } = await fakeToolWorld(CSV_BODY);
    const first = await tool.call({ expr: ["(define r (t/fake))", "(vector-ref r 0)"] });
    const firstText = textOf(first);
    // Verbose form's distinguishing markers: the "Available:" catalog line and the
    // multi-parser rundown — present only on first occurrence.
    expect(firstText).toContain("Available:");
    expect(firstText).toContain("parse-toon");

    const second = await tool.call({ expr: ["(define r2 (t/fake))", "(vector-ref r2 1)"] });
    const secondText = textOf(second);
    expect(secondText).toContain("hint");
    expect(secondText).toContain("again");
    // Terse form drops the full parser catalog.
    expect(secondText).not.toContain("Available:");
  });

  it("no trace armed ⇒ no enricher ⇒ error text unchanged (byte-identical default behavior)", async () => {
    const { tool } = await fakeToolWorld(CSV_BODY, { armTrace: false });
    await tool.call({ expr: "(define r (t/fake))" });
    const result = await tool.call({ expr: "(vector-ref r 0)" });
    expect(result.isError).toBeTruthy();
    const text = textOf(result);
    expect(text).not.toContain("hint");
    expect(text).not.toContain("parse-csv");
  });

  // DERIVED-FRAGMENT CASE — empirically verified against this codebase's actual `substring`
  // (env/r7rs/strings.ts): the primitive itself constructs its result via a bare
  // `new AString(this.runCtx, ...)` with NO provenance argument (unlike e.g. `string-upcase`/
  // `string-append`, which thread `withInputProvenance`). Read in isolation that would mean
  // provenance is lost. But `EvalTrace.exit`'s `computeProvenance` (trace.ts) re-derives and
  // RE-STAMPS provenance for every traced invocation from its symbol-resolution contributions
  // regardless of what the primitive itself attached — `r`'s non-empty provenance is captured
  // via `onSymbolResolved` when `(substring r 0 20)` resolves the symbol `r`, then forwarded
  // onto the call's own result. Empirically (see assertion below): provenance DOES survive
  // `substring` when a trace is armed, so the DERIVES variant fires as designed.
  it("derived fragment via (substring …) — provenance survives (see comment above); DERIVES hint fires", async () => {
    const { tool } = await fakeToolWorld(CSV_BODY);
    const result = await tool.call({
      expr: ["(define r (t/fake))", "(define frag (substring r 0 8))", "(car frag)"],
    });
    const text = textOf(result);
    expect(text).toContain("Error");
    expect(text).toContain("DERIVES");
    expect(text).toContain("t/fake");
    expect(text).toContain("csv");
  });
});
