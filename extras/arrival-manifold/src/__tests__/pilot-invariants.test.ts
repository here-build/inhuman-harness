// PILOT-INVARIANT PINS — the auto-present behaviors that won the pilot must be
// unloseable. auto-present.test.ts (synthetic fixtures) proves the MECHANISM end to end;
// this file proves the mechanism holds against REAL benchmark CSVs, and pins the two other
// load-bearing contracts a pure mechanism test can't see: the catalog advertises
// detect-parse, and defines are wiped (not preserved) across a HARD world rebuild — the
// complement of auto-present.test.ts's "soft refresh preserves defines" pin.
//
// FIXTURE PROVENANCE — heads only (header + first 8 data rows). The full files carry
// benchmark ground truth and must NEVER be committed. Captured from the running
// `mcp-atlas-env` container's `/data` mount:
//
//   docker exec mcp-atlas-env head -9 "/data/fantasy sports.csv" \
//     > src/__tests__/fixtures/fantasy-sports.head.csv
//   docker exec mcp-atlas-env head -9 "/data/Pet Care 2023 Weekly Financials.csv" \
//     > src/__tests__/fixtures/pet-care.head.csv
//
// fantasy-sports.head.csv: a CLEAN real header (`Player _ No,Team_id,Sport,...`) — every
// cell independently clears csv.ts's isPlausibleHeaderCell guard (interior spaces at or
// under the MAX_INTERIOR_SPACES=2 ceiling), so it auto-presents as records (I1).
//
// pet-care.head.csv: a MESSY real header (`Purchase Dates (2023) `, `Total Weekly Revenue
// Week ` — double interior spaces + trailing spaces, quoted money cells like
// `" $ 5,824.00 "`) — several cells exceed MAX_INTERIOR_SPACES, so the strict header
// predicate refuses the whole input (I2, a DELIBERATE documented limitation, not a bug).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { buildCatalog } from "../catalog.js";
import { connectServer } from "../connect.js";
import { ARG_NAME, TOOL_NAME } from "../names.js";
import { parseCsvStrict } from "../normalizer/csv.js";
import { buildManifoldServer } from "../server.js";

const FIXTURES_DIR = fileURLToPath(new URL("fixtures/", import.meta.url));
const readFixture = (name: string): string => readFileSync(path.join(FIXTURES_DIR, name), "utf8");

const FANTASY_SPORTS_CSV = readFixture("fantasy-sports.head.csv");
const PET_CARE_CSV = readFixture("pet-care.head.csv");

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

/** A fake upstream exposing one tool per `toolResponses` entry, each returning its fixed
 *  text verbatim — mirrors auto-present.test.ts's `fakeUpstream`/`manifoldClient` shape,
 *  kept self-contained here (no existing test file is modified). */
async function fakeUpstream(toolResponses: Record<string, string>) {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.keys(toolResponses).map((name) => ({
      name,
      description: `Returns ${name}'s fixed text`,
      inputSchema: { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const text = toolResponses[request.params.name];
    if (text === undefined) throw new Error(`unknown tool ${request.params.name}`);
    return { content: [{ type: "text", text }] };
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient(toolResponses: Record<string, string>): Promise<Client> {
  const upstream = await connectServer("t", await fakeUpstream(toolResponses));
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

const callRepl = (client: Client, expr: string) =>
  client.callTool({ name: TOOL_NAME, arguments: { [ARG_NAME]: expr } });

describe("GOLDEN I1 — real clean CSV (fantasy-sports) auto-presents as records", () => {
  it("parseCsvStrict on the raw fixture yields 8 records with EXACTLY this key list", () => {
    const result = parseCsvStrict(FANTASY_SPORTS_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("csv");
    const records = result.value as Array<Record<string, string>>;
    expect(records).toHaveLength(8);
    // These keys are the auto-present contract for real-world clean CSV — a parser
    // change that renames/drops keys must consciously update this list.
    expect(Object.keys(records[0]!)).toEqual([
      "Player _ No",
      "Team_id",
      "Sport",
      "Position",
      "Points_Scored",
      "Salary(USD)",
      "Age",
      "Injury Status",
      "Contract _end_date",
      "Drafted Year",
    ]);
    expect(records[0]).toEqual({
      "Player _ No": "P621",
      Team_id: "A29185F",
      Sport: "Basketball",
      Position: "Third Base",
      Points_Scored: "107",
      "Salary(USD)": "$4M",
      Age: "26",
      "Injury Status": "Healthy",
      "Contract _end_date": "03-14-2025",
      "Drafted Year": "2016",
    });
  });

  it("through the REPL: a tool returning this fixture arrives as RECORDS, not a raw string", async () => {
    const client = await manifoldClient({ "fantasy-tool": FANTASY_SPORTS_CSV });
    const define = await callRepl(client, "(define r (t/fantasy-tool))");
    expect(define.isError).toBeFalsy();

    const count = await callRepl(client, "(vector-length r)");
    expect(count.isError).toBeFalsy();
    expect(textOf(count as { content: unknown })).toBe("8");

    // "Sport" is the one header cell that is ALSO a bare valid Scheme accessor (no
    // spaces/parens) — the rest of the real header (e.g. "Player _ No") needs the
    // exact-key-list pin above, not a round-tripped accessor, as its contract.
    const sport = await callRepl(client, "(:Sport (vector-ref r 0))");
    expect(sport.isError).toBeFalsy();
    expect(textOf(sport as { content: unknown })).toBe('"Basketball"');
  });
});

describe("PIN I2 — messy real CSV (pet-care) currently REFUSES — documented limitation", () => {
  // DELIBERATE current behavior — the strict header predicate (csv.ts's
  // isPlausibleHeaderCell) refuses double-interior-space/trailing-space headers like
  // "Total Weekly Revenue  Week " and "Purchase Dates (2023) " (MAX_INTERIOR_SPACES=2 is
  // exceeded, and untrimmed cells carry a trailing space besides). Relaxation is planned
  // (trim cells + widen interior-space allowance, keep the digit-start guard); when it
  // lands, FLIP this test to assert records. This pin exists so the flip is a conscious
  // decision, never drift.
  it("parseCsvStrict refuses the raw pet-care header", () => {
    const result = parseCsvStrict(PET_CARE_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/is not identifier-like/);
  });

  it("through the REPL: a tool returning this fixture arrives as a RAW STRING, not records", async () => {
    const client = await manifoldClient({ "pet-tool": PET_CARE_CSV });
    const isString = await callRepl(client, "(string? (t/pet-tool))");
    expect(isString.isError).toBeFalsy();
    expect(textOf(isString as { content: unknown })).toBe("#t");

    const result = await callRepl(client, "(t/pet-tool)");
    expect(result.isError).toBeFalsy();
    // Refusal is passthrough, never a mangle — the raw prose survives untouched,
    // including the messy header the strict predicate rejected.
    expect(textOf(result as { content: unknown })).toContain("Purchase Dates (2023)");
    expect(textOf(result as { content: unknown })).toContain("Total Weekly Revenue  Week");
  });
});

describe("PIN I8 — catalog advertises detect-parse", () => {
  it("buildCatalog([], {}) contains the detect-parse advertisement", () => {
    expect(buildCatalog([], {})).toMatch(/detect-parse/);
  });
});

describe("PIN I4-wipe-side — a HARD listChanged rebuild wipes defines (world change, not soft refresh)", () => {
  // Complements auto-present.test.ts's "(define x 1) survives the soft refresh" pin: that
  // test pins the SURVIVING half of the contract (server.ts: a soft refresh reuses the
  // SAME persistent lexical root, so defines survive it). This test pins the WIPING half
  // — server.ts's module header states the hard-rebuild path "deliberately mints a fresh
  // [scope]" on every tools/listChanged rebuild, so a session's (define ...)s do NOT
  // survive a world change. Harness mirrors list-changed.test.ts's `mutableUpstream`
  // shape, kept self-contained here rather than modifying that file.
  it("(define x 1) does NOT survive a hard rebuild triggered by an upstream tools/listChanged", async () => {
    const upstreamServer = new Server(
      { name: "fake-upstream", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    let tools: Tool[] = [{ name: "alpha", description: "The first tool", inputSchema: { type: "object" } }];
    upstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    upstreamServer.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "ran" }],
    }));
    const [upServerTransport, upClientTransport] = InMemoryTransport.createLinkedPair();
    await upstreamServer.connect(upServerTransport);

    const connected = await connectServer("up", upClientTransport);
    const manifoldServer = await buildManifoldServer([connected]);
    const [msServerTransport, msClientTransport] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(msServerTransport);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(msClientTransport);

    const define = await callRepl(client, "(define x 1)");
    expect(define.isError).toBeFalsy();
    const before = await callRepl(client, "x");
    expect(before.isError).toBeFalsy();
    expect(textOf(before as { content: unknown })).toBe("1");

    // Trigger a HARD rebuild: swap the upstream's tool list and notify.
    tools = [{ name: "beta", description: "The replacement tool", inputSchema: { type: "object" } }];
    await upstreamServer.sendToolListChanged();

    const catalogOf = async (): Promise<string> => {
      const { tools: listed } = await client.listTools();
      return listed[0]?.description ?? "";
    };
    await vi.waitFor(async () => expect(await catalogOf()).toContain("up/beta"));

    const after = await callRepl(client, "x");
    expect(after.isError).toBe(true);
    expect(textOf(after as { content: unknown })).toContain("Unbound variable");
  });
});
