// args-misuse-door — e2e suite for the localized args-misuse door.
// Each row exercises the e2e surface (buildManifoldEnv + createManifoldTool with a fake
// upstream that rejects with the design doc's jsonschema-family error text); M4 pins the
// unlocalizable Signature + Example fallback (design doc §2.1: "where localization fails … today's
// Signature + Example echo remains the fallback, byte-identical").
//
// Fixture: a trimmed 2-key subset of a clinicaltrials-shaped `query` param (design doc §1,
// §2.3) — `{cond, term}` instead of the full 8-key shape; `additionalProperties: false` so
// the L2 closed-world clause (design doc §2.3) is a fact for this fixture. The doc itself
// notes only the TEMPLATE (line heads + structure) is frozen (§3) — schema-derived content
// stays free to follow whatever schema a real caller declares — so every assertion below
// pins a line HEAD, never the full interpolated key-list prose.

import { exec } from "@here.build/arrival";
import type { JsonSchemaProperty } from "@inhuman.tools/substrate";
import { describe, expect, it } from "vitest";

import { ARGS_REJECTION, buildManifoldEnv, findArgsRejection, toBoundTools } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const QUALIFIED = "clinicaltrialsgov-mcp-server/clinicaltrials_list_studies";
const WIRE_NAME = "clinicaltrialsgov-mcp-server_clinicaltrials_list_studies";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/** A python-jsonschema-family value-mismatch rejection — the 45edee trajectory's attempt 1
 *  (design doc §1, §2.3 Case A), trimmed to this fixture's 2-key `query` shape. */
const valueMismatchText = (sent: string) =>
  `{"detail":"Failed to call tool '${WIRE_NAME}': Input validation error: '${sent}' is not of type 'object'"}`;

/** A python-jsonschema-family unexpected-keys rejection (design doc §1, §2.3 Cases B/C). */
const unexpectedKeyText = (badKey: string) =>
  `{"detail":"Failed to call tool '${WIRE_NAME}': Input validation error: Additional properties are not allowed ('${badKey}' was unexpected)"}`;

/** Fake upstream: `query` must be an object with ONLY {cond, term} keys — a value-mismatch
 *  rejection when the model sends a bare scalar, an unexpected-keys rejection when it sends
 *  an object with any other key. Mirrors doors.test.ts / signature-echo.test.ts's fake-
 *  upstream harness pattern (a hand-validating CallToolRequestSchema handler, in-memory
 *  transport is NOT needed here — buildManifoldEnv's `invoke` is the direct seam). */
// `additionalProperties` isn't (yet) a field of `JsonSchemaProperty` — the design doc's L2
// closed-world detection (§2.3, T10) is future work that will read it off the tool's OWN
// declared schema, not the signature renderer's narrower slice. Intersected locally here
// rather than widening the shared type ahead of that landing.
type ClosedWorldObject = JsonSchemaProperty & { additionalProperties?: boolean };

async function misuseFixtureTool() {
  const querySchema: ClosedWorldObject = {
    type: "object",
    properties: {
      cond: { type: "string", description: "Conditions or disease query." },
      term: { type: "string", description: "Other terms query." },
    },
    additionalProperties: false,
  };
  return buildManifoldEnv([
    {
      slug: "clinicaltrialsgov-mcp-server",
      tools: [
        {
          name: "clinicaltrials_list_studies",
          description: "List clinical trials studies",
          inputSchema: {
            type: "object",
            properties: { query: querySchema },
          },
          invoke: async (args) => {
            const query = (args as { query?: unknown }).query;
            if (typeof query === "string") throw new Error(valueMismatchText(query));
            if (query && typeof query === "object") {
              const bad = Object.keys(query as Record<string, unknown>).find((k) => k !== "cond" && k !== "term");
              if (bad !== undefined) throw new Error(unexpectedKeyText(bad));
            }
            return { ok: true };
          },
        },
      ],
    },
  ]);
}

async function misuseFixtureCall(expr: string) {
  const manifoldEnv = await misuseFixtureTool();
  const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
  const result = await tool.call({ expr });
  return { result, text: textOf(result as { content: unknown }) };
}

describe("args-misuse-door — L1/L2/L3 localized teach", () => {
  // M1: L1, the FIRST misuse failure for (tool, param) — the design doc's "lean: localize +
  // retry shape" rung (§2.3 Level 1). The upstream's verbatim first line survives (H-4);
  // below it, a `Failing argument:` fact line names the param, and a `Retry shape:` script
  // line carries a type-placeholder hole (never the model's sent scalar re-fabricated as
  // real data, §2.3's construction rules); `Signature:` still rides below both (never
  // replaced, only preceded).
  it(
    "M1 — L1 value-mismatch: verbatim upstream first line, then 'Failing argument: :query — ', " +
      "'Retry shape: ' (with a #|string|# hole, never the sent scalar), then 'Signature: ' " +
      "(design doc §2.3 Level 1, Case A)",
    async () => {
      const sent = "King Saud University";
      const { result, text } = await misuseFixtureCall(`(${QUALIFIED} :query "${sent}")`);
      expect(result.isError).toBe(true);
      // H-4: the upstream text reaches the model VERBATIM as the first line.
      expect(text.split("\n")[0]).toBe(`Error: ${valueMismatchText(sent)}`);
      expect(text).toContain("\n  Failing argument: :query — ");
      expect(text).toContain("\n  Retry shape: ");
      const retryLine = text.split("\n").find((l) => l.trimStart().startsWith("Retry shape: "));
      expect(retryLine).toBeDefined();
      // The hole is an UNFILLABLE type-placeholder comment, never the sent scalar relocated
      // as though it were a real fix (design doc §2.3's construction rules).
      expect(retryLine).toContain("#|");
      expect(retryLine).not.toContain(sent);
      expect(text).toContain("\nSignature: ");
      expect(text.indexOf("Retry shape:")).toBeLessThan(text.indexOf("Signature:"));
    },
  );

  // M2: L2, the SECOND consecutive misuse failure for the SAME (tool, param) — the "full
  // sub-schema dump + closed-world warning" rung (§2.3 Level 2). The closed-world clause
  // renders because THIS fixture's `query` declares `additionalProperties: false` (T10's
  // truthfulness law) — never on an open schema.
  it(
    "M2 — L2 second consecutive failure on :query: 'Parameter :query in full — ' + the closed-world " +
      "clause 'only these keys exist (any other key is rejected):' (fixture declares additionalProperties: " +
      "false, design doc §2.3 Level 2, T10)",
    async () => {
      const manifoldEnv = await misuseFixtureTool();
      const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
      const expr = `(${QUALIFIED} :query "King Saud University")`;
      await tool.call({ expr }); // first failure — L1 only
      const second = await tool.call({ expr }); // second consecutive failure — L2 appends
      const text = textOf(second as { content: unknown });
      expect(text).toContain("\n  Parameter :query in full — ");
      expect(text).toContain("only these keys exist (any other key is rejected):");
    },
  );

  // M3: L3, the THIRD-AND-LATER consecutive misuse failure for the SAME (tool, param) — the
  // anti-guess futility voice (§2.3 Level 3), carrying the tracker's own consecutive-failure
  // count as a fact (`#<n>`, never an estimate).
  it(
    "M3 — L3 third consecutive failure on :query: 'This is rejected shape #3 for :query on this tool.' " +
      "(design doc §2.3 Level 3 — the tracker's consecutive-failure count is a fact, not an estimate)",
    async () => {
      const manifoldEnv = await misuseFixtureTool();
      const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
      const expr = `(${QUALIFIED} :query "King Saud University")`;
      await tool.call({ expr });
      await tool.call({ expr });
      const third = await tool.call({ expr });
      const text = textOf(third as { content: unknown });
      expect(text).toContain("This is rejected shape #3 for :query on this tool.");
    },
  );

  // M4: the do-no-harm guard — an UNLOCALIZABLE misuse (the clue names a key that appears
  // NOWHERE in the sent-args tree, so localizeFailingParam's "never guess" rule yields zero
  // candidates) keeps the Signature + Example fallback byte-identical (design doc §2.1, §7.2
  // M4); a regression here breaks the "never guess as fact" discipline. The text pinned below is
  // what a live run against this fixture actually produces — pin only what's observed, never an
  // assumed shape.
  it(
    "M4 — unlocalizable misuse (clue names a key absent from sent-args) keeps the byte-identical " +
      "Signature + Example fallback — the do-no-harm guard that must never break during landing",
    async () => {
      // "Input validation error" makes this a recognized misuse SHAPE (isToolMisuseError), but
      // its prose names no quotable clue at all — zero candidate paths, so localization must
      // decline rather than guess (design doc §2.2's resolution walk: 0 or several candidates
      // ⇒ undefined, never a fallback to a guessed param name).
      const manifoldEnv = await buildManifoldEnv([
        {
          slug: "u",
          tools: [
            {
              name: "opaque",
              description: "opaque rejection",
              inputSchema: { type: "object", properties: { a: { type: "string" } } },
              invoke: async () => {
                throw new Error("Input validation error: the request could not be validated");
              },
            },
          ],
        },
      ]);
      const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
      const r = await tool.call({ expr: '(u/opaque :a "x")' });
      expect(r.isError).toBe(true);
      const t = textOf(r as { content: unknown });
      expect(t.split("\n")[0]).toBe("Error: Input validation error: the request could not be validated");
      expect(t).toContain("\nSignature: ");
      // Never the localized L1 lines — no clue matched, so no guess was rendered as fact.
      expect(t).not.toContain("Failing argument:");
      expect(t).not.toContain("Retry shape:");
    },
  );

  // M5: membrane metadata (design doc §2.2 "where sentArgs come from") — the
  // rejection error object carries {qualifiedName, sentArgs} under a SYMBOL-keyed property
  // (never inline in the message: H-4's verbatim-pass-through is about the MESSAGE, not the
  // object), so error.message stays byte-unchanged through `attachArgsRejection`. Exercised
  // BELOW manifold-tool.ts's text-rendering catch — directly against the thrown JS Error via
  // `exec()` over the raw ambient (bind.test.ts's `runExpr` pattern) — metadata riding the
  // error object never crosses the MCP wire by design, so it can't be observed through a
  // tool.call() round trip.
  //
  // The read goes through `findArgsRejection` (bind.ts) — the ONE supported read path.
  // `exec()` propagates every thrown error through arrival's evaluator, which wraps it in a
  // fresh `ArrivalError` (errors.ts): `message` copied verbatim (H-4 unaffected), own
  // symbol-keyed properties necessarily empty, the original — carrying the metadata — riding
  // `.cause`. Reading the symbol off the caught top-level error alone therefore ALWAYS misses
  // through the real exec path; this row pins that the exported cause-walking helper is what
  // reaches it.
  it(
    "M5 — membrane metadata: findArgsRejection(err) recovers {qualifiedName, sentArgs} through " +
      "arrival's ArrivalError wrap (metadata rides .cause, never the top-level error); error.message " +
      "stays byte-identical to the upstream text (design doc §2.2, bind.ts's tool.invoke catch)",
    async () => {
      const manifoldEnv = await misuseFixtureTool();
      const sent = "King Saud University";
      let caught: unknown;
      try {
        await exec(`(${QUALIFIED} :query "${sent}")`, {
          capabilities: manifoldEnv.capabilities,
          config: manifoldEnv.config,
          runCtx: manifoldEnv.runCtx,
          scope: manifoldEnv.scope,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { cause?: unknown };
      expect(err.message).toBe(valueMismatchText(sent));
      expect(findArgsRejection(err)).toEqual({ qualifiedName: QUALIFIED, sentArgs: { query: sent } });
    },
  );

  // findArgsRejection's own walk contract: cause-chain traversal is BOUNDED, and absence is
  // `undefined` at every depth — never a throw on a weird error shape.
  it("findArgsRejection — walks a nested cause chain within its bound; unrelated/absent metadata and non-object errors yield undefined", async () => {
    const metadata = { qualifiedName: "t/x", sentArgs: { a: 1 } };
    const inner = Object.assign(new Error("inner"), { [ARGS_REJECTION]: metadata });
    const wrapped = new Error("outer", { cause: new Error("mid", { cause: inner }) });
    expect(findArgsRejection(wrapped)).toEqual(metadata);
    expect(findArgsRejection(new Error("bare"))).toBeUndefined();
    expect(findArgsRejection("not an error")).toBeUndefined();
    expect(findArgsRejection(undefined)).toBeUndefined();
    // Beyond the depth bound: never found (a pathological chain is cut, not chased).
    let deep: Error = inner;
    for (let i = 0; i < 6; i++) deep = new Error(`wrap-${i}`, { cause: deep });
    expect(findArgsRejection(deep)).toBeUndefined();
  });
});
