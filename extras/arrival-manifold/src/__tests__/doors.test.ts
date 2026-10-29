// Envelope doors through the manifold REPL (server.ts CallTool boundary + manifold-tool).
// Door-sentence constructors live in substrate; this file does not call them.
// An UNMODIFIED MCP client pointed at the manifold gets doors as ordinary isError tool
// results, never transport throws.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../bind.js";
import { connectServer } from "../connect.js";
import { createManifoldTool } from "../manifold-tool.js";
import { buildManifoldServer } from "../server.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/** A fake upstream with two filesystem-ish tools, in-memory transport. */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_files",
        description: "Search files",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, pattern: { type: "string" } },
          required: ["path"],
        },
      },
      { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("filesystem", await fakeUpstream());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

/** A SECOND fake upstream exposing a tool with the SAME bare name ("search_files") as
 *  `fakeUpstream`'s, under a different slug — the genuine cross-server tie the bypass-
 *  resolution map (bind.ts) must refuse to auto-translate (envelope/bare-tool-call's
 *  "alternates" teaching, never a guess). */
async function fakeBackupUpstream() {
  const server = new Server({ name: "fake-backup", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "search_files", description: "Search backup files", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "backup-ok" }] }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function twoServerAmbiguousClient() {
  const filesystem = await connectServer("filesystem", await fakeUpstream());
  const backup = await connectServer("backup", await fakeBackupUpstream());
  const manifoldServer = await buildManifoldServer([filesystem, backup]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

// The default DoorSession logs via console.error — captured here for the telemetry pins.
let stderrLines: string[];
beforeEach(() => {
  stderrLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const doorEvents = () =>
  stderrLines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("bypass auto-exec — an UNAMBIGUOUS direct call is translated and EXECUTED (V's design, 2026-07-05)", () => {
  it("executes through the normal manifold path — no transport throw, no teaching — and prepends the auto-exec note", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "filesystem_search_files",
      arguments: { path: "/data", pattern: "log" },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content: unknown });
    // The recovery script IS their call, translated and RUN — parseable by construction.
    // fakeUpstream's "ok" crosses as a plain scheme string, hence the rendered quotes. The
    // attempted name is wire-underscored ("filesystem_search_files"); it resolves to the real
    // `/`-joined qualified symbol via bypassFormsOf's wire-form translation (bind.ts).
    // The auto-exec advisory rides the CONSOLIDATED notes channel, AFTER the answer:
    //   "ok"
    //   #| ── environment notes ──
    //   auto-executed as (…) — call through … next time.
    //   |#
    // It never PREPENDS to the answer: that would make it a SECOND, unlabelled notification
    // channel — the model would have to learn twice where bookkeeping lives, and the one place
    // it is guaranteed to read (the answer) would open with a non-answer. The advisory is
    // bookkeeping ABOUT the call, exactly like the define-introduction and elision notes it sits
    // beside.
    expect(text).toBe(
      '"ok"\n#| ── environment notes ──\nauto-executed as (filesystem/search_files :path "/data" :pattern "log") — call through scheme-repl-with-all-mcp-tools next time.\n|#',
    );
  });

  it("matches the BARE tool name too, resolving it to the qualified symbol", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("matches the underscore-joined wire spelling too (still resolves via the normalized fallback — an old-habit guess isn't stranded)", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "filesystem_search_files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    // Resolves to the REAL (`/`-joined) qualified name — the underscore spelling is never
    // echoed back; normalizeSymbolName collapses "/" and "_" identically, so the normalized-key
    // fallback still finds the one real tool.
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("a hyphen/underscore-drifted spelling of the bare tool name also resolves (normalizeSymbolName)", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "search-files", arguments: { path: "/data" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain(
      'auto-executed as (filesystem/search_files :path "/data")',
    );
  });

  it("an executed bypass's OWN failure travels through untouched, note prepended — auto-exec never masks it", async () => {
    // A dedicated upstream declaring `path` REQUIRED. arrival's kwargs decode is strict
    // (args-error-reporting-v2.md §2.5) — the missing required kwarg is rejected at OUR
    // layer (kwargs-rejection.ts's frozen grammar) before the upstream is ever invoked; the
    // bypass path must carry that failure through untouched the same way it carries an
    // upstream domain failure.
    const server = new Server({ name: "fake-strict-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_files",
          description: "Search files",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const path = (request.params.arguments as { path?: string } | undefined)?.path;
      if (path === undefined) throw new Error("path is required");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const upstream = await connectServer("filesystem", clientTransport);
    const manifoldServer = await buildManifoldServer([upstream]);
    const [st, ct] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(st);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(ct);

    const result = await client.callTool({ name: "filesystem_search_files", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toContain("auto-executed as (filesystem/search_files)");
    expect(text).toContain("Error: filesystem/search_files: arguments rejected — 1 problem(s):");
    expect(text).toContain("\n  :path — missing (required)");
  });

  it("DECLINES to auto-exec when an arg key isn't a valid scheme keyword — teaches, never runs broken syntax (no data loss, no misfire)", async () => {
    const client = await manifoldClient();
    // `search_files` resolves UNIQUELY to filesystem/search_files, but the arg key "weird key" is
    // structurally inexpressible as a kwarg (no `:keyword` form, no dict-arg escape hatch — both
    // verified against the interpreter). Auto-executing a degraded `(… :weird key "x")` would read
    // `key` as an unbound variable and silently DROP the datum; declining + teaching is faithful.
    const result = await client.callTool({ name: "search_files", arguments: { "weird key": "x", path: "/data" } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // NOT auto-executed: no "auto-executed as …" note, and never the broken `:weird key` fragment.
    expect(text).not.toContain("[auto-executed");
    expect(text).not.toContain(":weird key");
    // Teaches: the tool is a symbol inside the manifold, names the bad key, shows the safe shape.
    expect(text).toContain("filesystem/search_files");
    expect(text).toContain('"weird key"');
  });

  it("a declined auto-exec logs the bare-tool-call door, NOT a bypass-autoexec event (nothing ran)", async () => {
    const client = await manifoldClient();
    await client.callTool({ name: "search_files", arguments: { "weird key": 5 } });
    const events = doorEvents();
    expect(events.some((e) => e.door === "envelope/bypass-autoexec")).toBe(false);
    expect(events.some((e) => e.door === "envelope/bare-tool-call" && e.tool === "search_files")).toBe(true);
  });
});

describe("bypass ambiguous — a cross-server tie is never guessed (V's tolerance rule)", () => {
  it("returns the candidates door (no auto-exec) when two servers bind the same bare tool name", async () => {
    const client = await twoServerAmbiguousClient();
    const result = await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // `fact` names the ATTEMPTED (bare) name, not either qualified candidate.
    expect(text).toMatch(
      /^Error: search_files is a symbol inside the scheme-repl-with-all-mcp-tools tool's repl-input-scheme-program/,
    );
    expect(text).toContain("also bound as");
  });
});

describe("envelope/unknown-tool — a name bound nowhere at all", () => {
  it("returns a did-you-mean door over the catalog", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({ name: "totally_unbound_operation_zzz", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toMatch(/^Error: totally_unbound_operation_zzz is not a tool on this server/);
    expect(text).toContain("Retry — call the scheme-repl-with-all-mcp-tools tool with repl-input-scheme-program = (");
  });
});

describe("envelope/bypass-autoexec — telemetry (V's design, 2026-07-05)", () => {
  it("logs one {door, seq, tool, resolvedTo} line, distinct from envelope/bare-tool-call", async () => {
    const client = await manifoldClient();
    await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    const events = doorEvents();
    expect(events).toContainEqual({
      door: "envelope/bypass-autoexec",
      seq: 1,
      tool: "search_files",
      resolvedTo: "filesystem/search_files",
    });
  });
});

describe("verbosity gate + telemetry (DoorSession)", () => {
  it("end-to-end: an AMBIGUOUS bypass door then the successful explicit retry emits door + door-followed on stderr", async () => {
    // A unique bypass no longer renders a door at all (it auto-executes — see the
    // "bypass auto-exec" describe block above) — this end-to-end door+follow-rate
    // telemetry is now exercised via the genuinely ambiguous cross-server tie instead.
    const client = await twoServerAmbiguousClient();
    await client.callTool({ name: "search_files", arguments: { path: "/data" } });
    await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: '(filesystem/search_files :path "/data")' },
    });
    const events = doorEvents();
    expect(events).toContainEqual({ door: "envelope/bare-tool-call", seq: 1, tool: "search_files" });
    expect(events).toContainEqual({ "door-followed": "envelope/bare-tool-call", tool: "search_files" });
  });
});

describe("envelope/unbound-in-expr — the THREE-TIER tool-resolution door (unboundInExprDoor)", () => {
  it("end-to-end: a real in-expr unbound wall is ENRICHED — the frozen first line stays verbatim, the example call rides on the real tool schema", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [
          {
            name: "search_files",
            inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            invoke: async () => ({}),
          },
        ],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: '(search_files :path "/data")' });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    // H-4: the FIRST line is arrival's wall, byte-for-byte; the door is an indented suffix below.
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `search_files'");
    expect(text).toContain("the symbol you want is `filesystem/search_files`");
    // The example call is recovered end-to-end off the REAL env's schema (bind.ts's
    // toolSchemasForEnv), with NO extra wiring beyond the bound-tool registry.
    expect(text).toContain("For example: (filesystem/search_files :path #|string|#)");
  });

  it("end-to-end: a library-verb typo is arrival's OWN enrichment now — the manifold door adds nothing of its own", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => ({}) }],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: '(string-splt "a,b" ",")' });
    const text = textOf(result as { content: unknown });
    // H-4: the frozen first line is arrival's own message VERBATIM — the `polyglot-rich-errors`
    // capability enriches "Unbound variable" at the interpreter level for its curated well-known
    // symbols (SRFI/R7RS), so its did-you-mean already rides inline on the ONE line. The manifold
    // door (tiers 1-3, tool names only) has nothing to add here — no second, indented suffix line.
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/^Error: Unbound variable `string-splt'/);
  });

  it("end-to-end: a genuinely unknown symbol is NOT enriched — the wall is exactly one line", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => ({}) }],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: "(frobnicate 1)" });
    expect(textOf(result as { content: unknown })).toBe("Error: Unbound variable `frobnicate'");
  });
});
