// A TOOL'S SCHEMA IS A CLAIM ABOUT ITS PAYLOAD, NOT A LICENCE TO DELETE IT.
//
// Reported (real trajectory):
//   (filesystem/directory_tree :path "/data")
//   => Error: Failed to call tool 'filesystem_directory_tree': MCP error -32602:
//      Output validation error: Invalid structured content for tool directory_tree:
//      [{ "expected": "string", "code": "invalid_type", "path": ["content"],
//         "message": "Invalid input: expected string, received array" }]
//
// The UPSTREAM tool's own output failed the UPSTREAM tool's own declared schema. The model got a
// hard error and no data — the tool was simply UNUSABLE. And the data was fine: `directory_tree`
// returns an array of entries; its schema merely claims a string. The DECLARATION is wrong.
//
// The MCP SDK's `callTool` receives the full result over the wire, runs client-side output-schema
// validation, and THROWS on mismatch — discarding the content blocks that already arrived
// (sdk/client/index.js: the result is received, the validator rejects, the payload is dropped).
// Nothing is lost on the wire. It is destroyed locally, to protect a claim that is itself false.
//
// So the manifold issues the request itself (`client.request`, which performs no output validation)
// and keeps the payload. The tool is the authority on what it RETURNED; its schema is only its claim
// about what it MEANT to return, and when the two disagree it is the claim that is wrong.
//
// KNOWN GAP (ticketed, deliberately not faked): the catalog is not yet TAUGHT that the declaration
// was wrong. `ObservedSignatureTracker` can render `-> [observed] <shape> (declared: <shape>)` and
// A5 already ruled the declared line is not ground truth — but detecting the disagreement requires
// comparing shapes on our own terms, because the only thing that can tell a correct declaration from
// an incorrect one (the SDK's validator) is `private` in its typings. Recording EVERY declared tool
// would annotate the correct ones too, which teaches nothing. The payload no longer dies either way,
// which is the part that made the tool unusable.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { connectServer } from "../connect.js";
import { ARG_NAME, TOOL_NAME } from "../names.js";
import { buildManifoldServer } from "../server.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/**
 * A REAL upstream MCP server (in-memory transport, real SDK Client on our side) whose tool DECLARES
 * `content: string` and RETURNS `content: [...]`. This is the reported `filesystem/directory_tree`
 * pathology exactly: the data is good, the declaration is a lie.
 *
 * It MUST go through a real SDK Client — that is the entire point. The SDK's `callTool` is what
 * validates and throws; a hand-rolled fake `invoke` would bypass the very code being tested and the
 * test would pass while proving nothing.
 */
async function lyingSchemaUpstream() {
  const server = new Server({ name: "fs", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "directory_tree",
        description: "recursive directory listing",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        // DECLARES: content is a STRING.
        outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    // RETURNS: content is an ARRAY. The schema is wrong; the payload is fine.
    content: [{ type: "text", text: JSON.stringify({ content: ["src", "a.ts"] }) }],
    structuredContent: { content: ["src", "a.ts"] },
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("filesystem", await lyingSchemaUpstream());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

describe("LAW — a declared-but-violated output schema must NOT destroy the payload", () => {
  it("the reported trace: directory_tree returns DATA, not an output-validation error", async () => {
    const client = await manifoldClient();
    const r = await client.callTool({
      name: TOOL_NAME,
      arguments: { [ARG_NAME]: `(filesystem/directory_tree :path "/data")` },
    });

    // THE DEFECT: this used to be isError with no payload at all — the tool was unusable.
    expect((r as { isError?: boolean }).isError ?? false).toBe(false);

    const text = textOf(r as { content: unknown });
    expect(text).not.toContain("Output validation error");
    expect(text).not.toContain("does not match the tool");

    // The data the SDK was throwing away is right there.
    expect(text).toContain("src");
    expect(text).toContain("a.ts");
  });

  it("the payload is USABLE — a tool whose data you cannot touch is no better than one that errors", async () => {
    const client = await manifoldClient();
    const r = await client.callTool({
      name: TOOL_NAME,
      arguments: {
        [ARG_NAME]: [`(define tree (filesystem/directory_tree :path "/data"))`, `(length (:content tree))`],
      },
    });
    expect((r as { isError?: boolean }).isError ?? false).toBe(false);
    expect(textOf(r as { content: unknown })).toContain("2");
  });
});

// ─── THE NEGATIVE SIDE ────────────────────────────────────────────────────────────────────────
//
// We removed the SDK's client-side output validation WHOLESALE (`callTool` → `request`). That buys
// the payload back, and it could just as easily have bought a catastrophe: if error propagation went
// with it, EVERY FAILING TOOL WOULD NOW LOOK LIKE IT SUCCEEDED — the exact silent-lie class this
// whole body of work exists to kill, reintroduced by the fix for it.
//
// Nothing below is about the salvage. Everything below is about what the salvage MUST NOT have
// broken.

/** An upstream whose tool declares a schema and RESPECTS it — the ordinary, correct case. */
async function honestSchemaUpstream() {
  const server = new Server({ name: "fs", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "stat",
        description: "file stat",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        outputSchema: { type: "object", properties: { size: { type: "number" } }, required: ["size"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: JSON.stringify({ size: 42 }) }],
    structuredContent: { size: 42 },
  }));
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  return ct;
}

/** An upstream whose tool FAILS — returns `isError: true`. */
async function failingUpstream() {
  const server = new Server({ name: "fs", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "boom", description: "always fails", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "permission denied: /root" }],
    isError: true,
  }));
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  return ct;
}

/** An upstream whose handler THROWS — a JSON-RPC-level failure, not a tool-level one. */
async function throwingUpstream() {
  const server = new Server({ name: "fs", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "explode", description: "throws", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    throw new Error("upstream exploded");
  });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  return ct;
}

async function clientFor(transportFactory: () => Promise<Awaited<ReturnType<typeof lyingSchemaUpstream>>>) {
  const upstream = await connectServer("filesystem", await transportFactory());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(st);
  const client = new Client({ name: "test", version: "0.1.0" });
  await client.connect(ct);
  return client;
}

describe("NEGATIVE — dropping the SDK's validator must not have dropped anything ELSE", () => {
  it("a tool with an HONEST schema still works — structuredContent is still the typed value", async () => {
    const client = await clientFor(honestSchemaUpstream);
    const r = await client.callTool({
      name: TOOL_NAME,
      arguments: { [ARG_NAME]: `(:size (filesystem/stat :path "/a"))` },
    });
    expect((r as { isError?: boolean }).isError ?? false).toBe(false);
    expect(textOf(r as { content: unknown })).toContain("42");
  });

  it("a tool that FAILS still surfaces as an error — the salvage must not swallow isError", async () => {
    // THE CATASTROPHE THIS PINS: if bypassing callTool had also bypassed error propagation, every
    // failing tool would read as a success and the model would build on a lie.
    const client = await clientFor(failingUpstream);
    const r = await client.callTool({ name: TOOL_NAME, arguments: { [ARG_NAME]: `(filesystem/boom)` } });
    const text = textOf(r as { content: unknown });
    expect(text).toContain("Error");
    expect(text).toContain("permission denied");
  });

  it("an upstream that THROWS still fails loudly (JSON-RPC-level failure, frame stripped)", async () => {
    const client = await clientFor(throwingUpstream);
    const r = await client.callTool({ name: TOOL_NAME, arguments: { [ARG_NAME]: `(filesystem/explode)` } });
    const text = textOf(r as { content: unknown });
    expect(text).toContain("Error");
    expect(text).toContain("exploded");
    // The SDK's JSON-RPC plumbing frame must still be stripped — models never see transport internals.
    expect(text).not.toContain("MCP error -");
  });
});
