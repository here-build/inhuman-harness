// The FUTILITY DOOR's MCP-WIRING half (futility.ts + doors.ts futile/duplicate generators +
// manifold-tool drain + DoorSession.renderNote), driven through a REAL manifold server + a fake
// upstream. Measured problem: a model retries a degraded upstream tool many times (a search tool
// returning the identical "no results / bot detection" body under varied queries), burning the
// turn budget with no answer. Shape-based, semantics-free detection tells it to stop: the door is
// an advisory line ("Note: ...") appended to the SUCCESSFUL call's output — the tool result
// itself flows through untouched. Two triggers: futile-retry (last 3 results identical despite
// ≥2 distinct arg sets) and duplicate-call (same tool + same args + same result twice in a row).
//
// The PURE shape-logic half (`FutilityTracker`/`normalizeResultText` exercised directly, no MCP
// transport) lives in `@inhuman.tools/substrate`'s own `futility.test.ts` — this file keeps
// only the wiring-through-a-real-server coverage.
//
// The futility Note is not its own standalone content block: every note-shaped producer
// (introduced-bindings, elision, futility, attachment) rides the consolidated
// `#| ── environment notes ── … |#` trailing block. The door text itself asserts degradation as a
// conditional fact ("the same result despite different arguments"), not a settled one, and
// prescribes no specific next action — see the `notes()` helper and the two TRIGGER-1 assertions
// below.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { buildManifoldServer } from "../server.js";

const TOOL = "scheme-repl-with-all-mcp-tools";

/** A fake upstream with four tools, each a controlled result shape:
 *   • degraded  — returns the SAME body no matter the args (the bot-wall / no-results case).
 *   • distinct  — echoes its `q` arg, so different args ⇒ different result.
 *   • clocked   — the same body except for an incrementing counter (differs ONLY in digits).
 * Every tool takes one required string `q`. */
async function fakeUpstream() {
  let clock = 0;
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["degraded", "distinct", "clocked"].map((name) => ({
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as { q?: string };
    let text: string;
    switch (request.params.name) {
      case "distinct":
        text = `results for ${args.q}`;
        break;
      case "clocked":
        clock += 137;
        text = `rate limited, retry after ${clock} seconds`;
        break;
      default: // degraded
        text = "no results found - bot detection triggered";
    }
    return { content: [{ type: "text", text }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("up", await fakeUpstream());
  // attestation "off": tools still bind; no unattested-arg warnings on bare `:q "x"` literals.
  const manifoldServer = await buildManifoldServer([upstream], { attestation: "off" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

type Block = { type: string; text: string };
const blocksOf = (r: { content: unknown }): Block[] => r.content as Block[];
const textOf = (r: { content: unknown }): string =>
  blocksOf(r)
    .map((b) => b.text)
    .join("\n");
// A futility advisory is not its own standalone `Note:`-prefixed content block. Every
// note-shaped producer (introduced-bindings, elision, futility, attachment) accumulates and
// renders as ONE trailing block labelled `#| ── environment notes ── … |#`; the individual
// door's `Note: …` text (doors.ts DoorSession.renderNote) is just a LINE inside it. None of
// these fixtures ever trigger a second note-shaped producer in the same call, so "does the
// consolidated block exist" is exactly the invariant "did a futility note fire".
const notes = (r: { content: unknown }): Block[] =>
  blocksOf(r).filter((b) => b.text.includes("── environment notes ──"));
const call = async (client: Client, expr: string): Promise<{ content: unknown; isError?: boolean }> =>
  (await client.callTool({ name: TOOL, arguments: { "repl-input-scheme-program": expr } })) as {
    content: unknown;
    isError?: boolean;
  };

describe("futility door — TRIGGER 1: degraded tool (futile-retry)", () => {
  it("3 distinct-arg calls across SEVERAL manifold calls → the 3rd carries the note; results untouched", async () => {
    const client = await manifoldClient();

    const r1 = await call(client, '(up/degraded :q "alpha")');
    const r2 = await call(client, '(up/degraded :q "beta")');
    const r3 = await call(client, '(up/degraded :q "gamma")');

    // First two calls: no note yet (need the third identical result to confirm degradation).
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);

    // Third call: the futile-retry Note appears, and the tool's OWN result block is untouched.
    expect(r3.isError).toBeFalsy();
    expect(blocksOf(r3)).toHaveLength(2);
    expect(blocksOf(r3)[0]!.text).toContain("bot detection triggered"); // the real result, verbatim
    const note = notes(r3);
    expect(note).toHaveLength(1);
    // The door frames degradation as a conditional fact, not a settled one, and prescribes no
    // specific next action — "stop retrying X" is an outcome-fine-tuning imperative that pushes a
    // model to abandon a recoverable search; "change the arguments materially, or take a
    // different route" leaves whether to keep using the tool up to the model.
    expect(note[0]!.text).toContain(
      "the last 3 calls to up/degraded returned the same result despite different arguments",
    );
    expect(note[0]!.text).toContain("change the arguments to up/degraded materially, or take a different route");
    // The door's own text still leads with "Note: " (doors.ts DoorSession.renderNote) — it just
    // isn't the block's OWN prefix; it's a line inside the consolidated
    // `#| ── environment notes ── … |#` block.
    expect(note[0]!.text.startsWith("#| ── environment notes ──")).toBe(true);
    expect(note[0]!.text).toContain("Note:");
    expect(note[0]!.text).not.toContain("Error:");
  });

  // Statements written in ONE program are authored by the model WITHOUT having seen any sibling
  // statement's result yet — three identical results among THEM is not an "informed retry" (the
  // door's whole premise), so both triggers require `distinctCalls >= 2` (each `run()` bumps
  // `callId` once via `tracker.beginCall()`). Unit-covered directly in substrate's own
  // `futility.test.ts`: "three identical results from ONE program's statements (no beginCall
  // between them) fire NOTHING". This e2e case asserts the SAME invariant through the real wire:
  // same-call batching is silent, never a false "you're retrying" note.
  it("3 distinct-arg statements in ONE manifold call → NO note (C1b: same-call statements are not an informed retry)", async () => {
    const client = await manifoldClient();
    const r = await call(client, '(up/degraded :q "a") (up/degraded :q "b") (up/degraded :q "c")');

    expect(r.isError).toBeFalsy();
    // three result blocks only — no consolidated environment-notes block at all.
    expect(blocksOf(r)).toHaveLength(3);
    expect(notes(r)).toHaveLength(0);
  });
});

describe("futility door — TRIGGER 2: pure repeat (duplicate-call)", () => {
  it("same tool + same args + same result twice → a duplicate-call note", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/degraded :q "same")');
    const r2 = await call(client, '(up/degraded :q "same")');

    expect(notes(r1)).toHaveLength(0);
    const note = notes(r2);
    expect(note).toHaveLength(1);
    expect(note[0]!.text).toContain("you already have this exact up/degraded result above");
    // Same header/line split as the futile-retry case above — the duplicate-call door text still
    // leads with "Note: " as a LINE inside the consolidated block.
    expect(note[0]!.text.startsWith("#| ── environment notes ──")).toBe(true);
    expect(note[0]!.text).toContain("Note:");
    expect(note[0]!.text).not.toContain("Error:");
    // the result block is still present and untouched
    expect(blocksOf(r2)[0]!.text).toContain("bot detection triggered");
  });
});

describe("futility door — negative / discrimination cases", () => {
  it("a tool returning DIFFERENT results is silent — no note ever", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/distinct :q "a")');
    const r2 = await call(client, '(up/distinct :q "b")');
    const r3 = await call(client, '(up/distinct :q "c")');
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);
    expect(notes(r3)).toHaveLength(0);
    expect(textOf(r3)).toContain("results for c");
  });

  it("a constant tool called with the SAME args 3× → duplicate-call fires, futile-retry does NOT (needs ≥2 distinct args)", async () => {
    const client = await manifoldClient();
    const r1 = await call(client, '(up/degraded :q "x")');
    const r2 = await call(client, '(up/degraded :q "x")'); // duplicate fires here
    const r3 = await call(client, '(up/degraded :q "x")'); // suppressed — no re-fire, and never futile

    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(1);
    expect(notes(r2)[0]!.text).toContain("you already have this exact up/degraded result");
    // r3 must NOT carry a futile-retry note (only one distinct argsHash), nor re-fire duplicate.
    expect(notes(r3)).toHaveLength(0);
  });

  // No digit-normalization: digits are frequently the PAYLOAD (file sizes, counts, ids, prices),
  // not a volatile token, so a shape-key that strips them collapses genuinely distinct results
  // (e.g. three different file sizes) into a false-positive "identical" match. Results that
  // differ only in digits must NOT be treated as identical.
  it("NO NORMALIZATION on digits (C1: DIGIT_RUN deleted) — results differing only in a counter are genuinely distinct, futile-retry does NOT fire", async () => {
    const client = await manifoldClient();
    // clocked returns "rate limited, retry after <n> seconds" with n incrementing each call —
    // three byte-DISTINCT bodies, and three distinct shape-hashes too.
    const r1 = await call(client, '(up/clocked :q "a")');
    const r2 = await call(client, '(up/clocked :q "b")');
    const r3 = await call(client, '(up/clocked :q "c")');
    expect(notes(r1)).toHaveLength(0);
    expect(notes(r2)).toHaveLength(0);
    // The digits ARE the payload distinguishing three separate answers, so nothing fires.
    expect(notes(r3)).toHaveLength(0);
  });

  it("no re-fire spam on the 4th/5th identical call", async () => {
    const client = await manifoldClient();
    await call(client, '(up/degraded :q "a")');
    await call(client, '(up/degraded :q "b")');
    const r3 = await call(client, '(up/degraded :q "c")'); // futile fires
    const r4 = await call(client, '(up/degraded :q "d")');
    const r5 = await call(client, '(up/degraded :q "e")');

    expect(notes(r3)).toHaveLength(1);
    expect(notes(r4)).toHaveLength(0);
    expect(notes(r5)).toHaveLength(0);
  });
});
