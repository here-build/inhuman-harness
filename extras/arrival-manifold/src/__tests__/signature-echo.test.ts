// SIGNATURE-ECHO — e2e coverage through a REAL manifold server (doors.ts's signatureEchoFor +
// DoorSession.echoSignature + manifold-tool.ts's catch hook + bind.ts's signatureByName +
// server.ts wiring). The pure unit coverage of the detection logic itself (`isToolMisuseError`,
// `implicatedTool`, `signatureEchoFor`/`DoorSession.echoSignature` in isolation) lives in
// `@inhuman.tools/substrate`'s own `signature-echo.test.ts` — this file keeps only the
// wiring-through-a-real-server matrix. Measured problem: ~15% of eval errors
// are tool MISUSE (wrong kwarg name, dangling keyword, wrong arg type/shape) — the model gets the
// error but not the CONTRACT, so it guesses again. The manifold already holds every tool's
// one-line signature; echoing the relevant one below a misuse error teaches "this is how this
// symbol works". It is a SIBLING of the unbound did-you-mean enrichment, on the DISJOINT
// tool-misuse family — and it NEVER fires on a tool that ran and failed on domain grounds (its
// args were fine), nor on an unbound-variable wall.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { connectServer } from "../connect.js";
import { createManifoldTool } from "../manifold-tool.js";
import { buildManifoldServer } from "../server.js";

const TOOL = "scheme-repl-with-all-mcp-tools";
const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/** A VALIDATING upstream, the way a real (high-level-SDK) MCP server behaves: `add` reports a
 *  missing/wrong-type argument as an `isError` result with clean `invalid arguments for add: …`
 *  text (which the manifold re-raises as the standard `Error:` observation, H-5 rule 1); `greet`
 *  echoes its `name`; `boom` runs fine and throws a DOMAIN error (its args were valid). */
const argError = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" }, label: { type: "string" } },
          required: ["a", "b"],
        },
      },
      {
        name: "greet",
        description: "Greet someone",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
      {
        name: "boom",
        description: "Explodes at runtime",
        inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as Record<string, unknown>;
    switch (request.params.name) {
      case "add": {
        if (!("a" in args)) return argError("invalid arguments for add: 'a' is a required property");
        if (typeof args.a !== "number")
          return argError("invalid arguments for add: a: Expected number, received string");
        return { content: [{ type: "text", text: String((args.a as number) + ((args.b as number) ?? 0)) }] };
      }
      case "greet":
        return { content: [{ type: "text", text: `hi ${args.name}` }] };
      default: // boom — args are fine; the tool RAN and failed on domain grounds
        throw new Error("ValueError: database connection refused");
    }
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("toy", await fakeUpstream());
  // attestation "off": model-authored literals reach the upstream (so ITS validation fires),
  // and no s/* wrapping is demanded — the point here is the tool's own argument rejection.
  const manifoldServer = await buildManifoldServer([upstream], { attestation: "off" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

const call = async (client: Client, expr: string): Promise<{ content: unknown; isError?: boolean }> =>
  (await client.callTool({ name: TOOL, arguments: { expr } })) as { content: unknown; isError?: boolean };

describe("signature-echo — e2e through the manifold server (misuse → Signature line)", () => {
  it("dangling keyword → the frozen error first line, then the tool's Signature", async () => {
    const client = await manifoldClient();
    const r = await call(client, "(toy/add :a 1 :b)");
    expect(r.isError).toBe(true);
    const text = textOf(r);
    // H-4: the first line is arrival's kwargs wall, byte-for-byte.
    expect(text.split("\n")[0]).toBe(
      "Error: kwargs call has a dangling keyword with no value — expected interleaved `:key value` pairs, got 3 arg(s)",
    );
    // …and the tool's contract is echoed below it, verbatim from the catalog.
    expect(text).toContain("\nSignature: (toy/add :a number :b number :label string?) - Add two numbers");
  });

  it("wrong keyword name (typo on a required param → strict own-decode rejection) → Signature", async () => {
    const client = await manifoldClient();
    // `:aa` is not a param — arrival's kwargs decode is STRICT (z.strictObject): the unknown
    // key is REJECTED at our own layer, never silently dropped, and `:a` is reported missing
    // in the same rejection. The frozen head is kwargs-rejection.ts's grammar; the echoed
    // signature still shows the real keyword names.
    const r = await call(client, "(toy/add :aa 1 :b 2)");
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text.split("\n")[0]).toBe("Error: toy/add: arguments rejected — 2 problem(s):");
    expect(text).toContain("\n  :a — missing (required)");
    expect(text).toContain("Signature: (toy/add :a number :b number :label string?) - Add two numbers");
  });

  it("wrong-type arg → upstream type rejection, then the Signature", async () => {
    const client = await manifoldClient();
    const r = await call(client, '(toy/add :a "one" :b 2)');
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text.split("\n")[0]).toBe("Error: invalid arguments for add: a: Expected number, received string");
    expect(text).toContain("Signature: (toy/add :a number :b number :label string?)");
  });

  it("wrong-type arg → the Signature echo is now followed by a synthesized, schema-driven example call (V's design, 2026-07-05)", async () => {
    const client = await manifoldClient();
    const r = await call(client, '(toy/add :a "one" :b 2)');
    expect(r.isError).toBe(true);
    const text = textOf(r);
    // The original error text and the Signature echo are PRESENT, unchanged...
    expect(text.split("\n")[0]).toBe("Error: invalid arguments for add: a: Expected number, received string");
    expect(text).toContain("Signature: (toy/add :a number :b number :label string?)");
    // …and the example call is APPENDED after it, never replacing it — required params only
    // (`a`, `b`), `label` (optional) omitted; each non-enum slot is a type-placeholder hole,
    // not a fabricated concrete value.
    expect(text).toContain("Example: (toy/add :a #|number|# :b #|number|#)");
    expect(text.indexOf("Signature:")).toBeLessThan(text.indexOf("Example:"));
  });

  it("an upstream EXECUTION error (the tool ran, args were fine) → NO Signature echo", async () => {
    const client = await manifoldClient();
    const r = await call(client, "(toy/boom :x 1)");
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toBe("Error: ValueError: database connection refused");
    expect(text).not.toContain("Signature:");
  });

  it("two different tool calls, error names neither → NO echo (ambiguous, no false teaching)", async () => {
    const client = await manifoldClient();
    // greet runs fine; the OUTER add form has a dangling :b (kwargs wall names no tool). Both
    // toy/add and toy/greet appear in the statement → ambiguous → skip.
    const r = await call(client, '(toy/add :a (toy/greet :name "hi") :b)');
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text.split("\n")[0]).toContain("kwargs call has a dangling keyword");
    expect(text).not.toContain("Signature:");
  });

  it("an unbound variable → the unbound-in-expr door only, never a Signature line", async () => {
    const client = await manifoldClient();
    // bare `add` (slug is "toy") is unbound → the unbound wall + its explicit-fact enrichment
    // (a single tier-1 tool match is a certainty, doors.ts explicitToolDoor).
    const r = await call(client, "(add :a 1 :b 2)");
    expect(r.isError).toBe(true);
    const text = textOf(r);
    // did-you-mean is an ADDITIVE suffix (unbound-variable.ts) — the frozen first line still
    // matches, now WITH the suggestion appended.
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `add' — did you mean `and`?");
    expect(text).toContain("the symbol you want is `toy/add`");
    expect(text).not.toContain("Signature:");
  });

  it("a bound tool with an EMPTY inputSchema (no properties/required) → the appended example degrades to a bare call, never crashes", async () => {
    // A dangling keyword is a misuse error REGARDLESS of the tool's schema (collectKwargsObject's
    // arity check, arrival's own kwargs decode) — so this exercises the "missing schema →
    // graceful fallback" case even though `ping` declares no PARAMS at all. (The MCP wire
    // protocol itself requires a Tool's inputSchema to be a present, valid object — `{type:
    // "object"}` with no properties is the minimal shape a real upstream can actually send.)
    const server = new Server({ name: "no-schema-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const upstream = await connectServer("toy2", clientTransport);
    const manifoldServer = await buildManifoldServer([upstream], { attestation: "off" });
    const [st, ct] = InMemoryTransport.createLinkedPair();
    await manifoldServer.connect(st);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await client.connect(ct);

    const r = await call(client, "(toy2/ping :x)"); // dangling keyword
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain("kwargs call has a dangling keyword");
    expect(text).toContain("Signature: (toy2/ping)");
    expect(text).toContain("Example: (toy2/ping)");
  });

  it("no implicated tool (execution error) → NEITHER Signature nor Example are appended", async () => {
    const client = await manifoldClient();
    const r = await call(client, "(toy/boom :x 1)");
    const text = textOf(r);
    expect(text).not.toContain("Signature:");
    expect(text).not.toContain("Example:");
  });

  it("ambiguous statement (names neither tool) → NEITHER Signature nor Example are appended", async () => {
    const client = await manifoldClient();
    const r = await call(client, '(toy/add :a (toy/greet :name "hi") :b)');
    const text = textOf(r);
    expect(text).not.toContain("Signature:");
    expect(text).not.toContain("Example:");
  });

  it("a tool built WITHOUT a signature map (frozen-contract construction) never echoes", async () => {
    // buildManifoldEnv gives the map, but a direct createManifoldTool omitting it (as the frozen
    // error-contract tests do) must keep the single-block shape — the echo is opt-in like tracker.
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "toy",
        tools: [
          {
            name: "add",
            description: "Add",
            inputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
            invoke: async () => 1,
          },
        ],
      },
    ]);
    expect(manifoldEnv.signatureByName.get("toy/add")).toContain("(toy/add :a number");
    const tool = createManifoldTool(manifoldEnv, "CATALOG"); // no signatureByName
    const r = await tool.call({ expr: "(toy/add :a)" });
    expect(textOf(r as { content: unknown })).toBe(
      "Error: kwargs call has a dangling keyword with no value — expected interleaved `:key value` pairs, got 1 arg(s)",
    );
  });
});
