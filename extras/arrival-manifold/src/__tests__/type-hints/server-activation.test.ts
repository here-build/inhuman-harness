// PRODUCTION ACTIVATION of the type-hint spine at the SERVER surface (server.ts): a mode
// without an injected lens now instantiates the REAL `createSpineLens(env)` per rebuilt
// world. This suite drives a full MCP round-trip — client → manifold server → upstream tool
// (in-memory transports throughout, same rig as server.test.ts) — and proves:
//   • "on-error": a bad kwarg (runtime-errored statement + whitelisted diagnostic) produces
//     a RENDERED trailing hint block, naming the form and the recovery;
//   • "telemetry" (the contract default): the SAME call renders NOTHING extra, but logs
//     exactly one envelope/type-hint telemetry line (rendered:false, skip:"mode-off" — the
//     would-be hit, doc §1's precision-calibration corpus).
// The injected DoorSession (options.session, honored by buildManifoldServer) is the
// telemetry capture point — the same seam production uses for its stderr sink.

import { createSpineLens, DoorSession, type TypeHintsMode } from "@inhuman.tools/substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../../bind.js";
import { connectServer } from "../../connect.js";
import { TOOL_NAME } from "../../names.js";
import { buildManifoldServer } from "../../server.js";

// Warm the worker's first TS compile OUTSIDE deliver.ts's 300ms race budget: the very first
// `ts.createProgram` in a fresh process pays lib-load costs that a later compile doesn't.
// Without this, the "on-error" assertion could flake as skip:"race" under parallel-suite load.
beforeAll(async () => {
  const manifoldEnv = await buildManifoldEnv([], { attestation: "off" });
  await createSpineLens(toBoundTools(manifoldEnv)).diagnose("(warm_up 1)", []);
});

/** A fake upstream exposing one number-typed tool that SELF-VALIDATES (a wrongly-typed
 *  argument is an isError result — the runtime error the on-error mode's "high-evidence
 *  coincidence" requires before a hint renders). */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "set_count",
        description: "Set the counter",
        inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const count: unknown = (request.params.arguments as Record<string, unknown>).count;
    if (typeof count !== "number") {
      return { content: [{ type: "text", text: `set_count: expected :count to be a number` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

type ContentBlock = { type: string; text: string };

/** Build a manifold server in the given type-hints mode (NO lens injected — the point:
 *  server.ts must build the real spine adapter itself), connect a client, run the bad-kwarg
 *  program, and return the resulting blocks + captured telemetry lines. */
async function runBadKwargCall(mode: TypeHintsMode) {
  const telemetryLines: string[] = [];
  const session = new DoorSession((line) => telemetryLines.push(line));
  const upstream = await connectServer("fx", await fakeUpstream());
  const manifoldServer = await buildManifoldServer([upstream], { typeHints: { mode }, session });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  const result = await client.callTool({ name: TOOL_NAME, arguments: { expr: '(fx/set_count :count "five")' } });
  const blocks = (result.content ?? []) as ContentBlock[];
  const typeHintEvents = telemetryLines
    .map((line): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(
      (e): e is { door: string; rendered: boolean; skip?: string; code?: number } =>
        typeof e === "object" && e !== null && (e as { door?: unknown }).door === "envelope/type-hint",
    );
  return { blocks, typeHintEvents };
}

describe("type-hints server activation (createSpineLens per world, mode from options)", () => {
  it('"on-error": a bad kwarg through the FULL server surface renders a trailing type hint', async () => {
    const { blocks, typeHintEvents } = await runBadKwargCall("on-error");

    // The statement's own error block is untouched (frozen contract)…
    expect(blocks.some((b) => b.text.startsWith("Error:"))).toBe(true);
    // …and a TRAILING hint block names the form and the recovery (2322: string where number).
    const hint = blocks.find((b) => b.text.startsWith("Type (fx/set_count):"));
    expect(hint).toBeDefined();
    expect(hint!.text).toContain("(string->number");
    // Exactly one telemetry event, a rendered hit.
    expect(typeHintEvents).toHaveLength(1);
    expect(typeHintEvents[0]!.rendered).toBe(true);
    expect(typeHintEvents[0]!.code).toBe(2322);
  });

  it('"telemetry" (the contract default): the same call renders NO hint but logs the would-be hit', async () => {
    const { blocks, typeHintEvents } = await runBadKwargCall("telemetry");

    expect(blocks.some((b) => b.text.startsWith("Error:"))).toBe(true);
    expect(blocks.some((b) => b.text.startsWith("Type ("))).toBe(false);
    // Exactly one telemetry event: rendered:false, skip:"mode-off", carrying the would-be code.
    expect(typeHintEvents).toHaveLength(1);
    expect(typeHintEvents[0]!.rendered).toBe(false);
    expect(typeHintEvents[0]!.skip).toBe("mode-off");
    expect(typeHintEvents[0]!.code).toBe(2322);
  });
});
