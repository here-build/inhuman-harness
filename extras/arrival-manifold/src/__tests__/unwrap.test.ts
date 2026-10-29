// H-5 — reverse marshalling: a tool's CallToolResult re-enters evaluation as a VALUE
// (unwrapToolResult's four frozen rules, server.ts), upstream isError THROWS, and the SDK's
// JSON-RPC plumbing frame never reaches the model (stripJsonRpcFrame). The e2e half proves
// the point of it all: nested tool composition — the failure class the manifold exists to
// dissolve — actually composes.
//
// BINARY CONTENT BLOCKS (attachments.ts): rule 4's "non-text blocks pass through untouched"
// carve-out does not apply to BINARY blocks (image/audio/embedded-resource blob) — those stub
// in the value and pass through as separate response content blocks instead of leaking raw
// base64 into the REPL text. See the dedicated describe blocks below.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { AttachmentCollector, DEFAULT_PASSTHROUGH_ATTACHMENTS, MAX_PASSTHROUGH_ATTACHMENTS } from "../attachments.js";
import { connectServer } from "../connect.js";
import { buildManifoldServer, stripJsonRpcFrame, unwrapToolResult } from "../server.js";

describe("unwrapToolResult (H-5, frozen rules)", () => {
  it("rule 1: isError THROWS with the text blocks' text — never flows as a successful value", () => {
    expect(() => unwrapToolResult({ isError: true, content: [{ type: "text", text: "domain says no" }] })).toThrow(
      "domain says no",
    );
    expect(() => unwrapToolResult({ isError: true, content: [] })).toThrow(
      "the upstream tool reported failure without diagnostic text — retry with different arguments, " +
        "or continue without this tool's result.",
    );
  });

  it("rule 2: structuredContent wins when present — it is the typed value", () => {
    expect(
      unwrapToolResult({
        content: [{ type: "text", text: '{"temp":21}' }],
        structuredContent: { temp: 21 },
      }),
    ).toEqual({ temp: 21 });
  });

  it("rule 3: a single text block JSON-parses when valid JSON, else stays a raw string", () => {
    expect(unwrapToolResult({ content: [{ type: "text", text: "3" }] })).toBe(3);
    expect(unwrapToolResult({ content: [{ type: "text", text: "true" }] })).toBe(true);
    expect(unwrapToolResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(unwrapToolResult({ content: [{ type: "text", text: "[1,2]" }] })).toEqual([1, 2]);
    expect(unwrapToolResult({ content: [{ type: "text", text: "Ada Lovelace (analyst)" }] })).toBe(
      "Ada Lovelace (analyst)",
    );
  });

  it(`A2: desktop-commander \`get_config\` REAL WIRE SHAPE — prose-prefixed JSON single block ${String.raw`('Current configuration:\n{...}') auto-presents as the parsed object, prefix dropped`}`, () => {
    const text = 'Current configuration:\n{"blockedCommands":["mkfs","format"],"defaultShell":"/bin/sh"}';
    const value = unwrapToolResult({ content: [{ type: "text", text }] });
    expect(value).toEqual({ blockedCommands: ["mkfs", "format"], defaultShell: "/bin/sh" });
  });

  it("A2: pure prose (no embedded structure) still stays a raw string — refusal is passthrough", () => {
    const text = "Commit history:\nCommit abc123 by Ada Lovelace, two days ago.";
    expect(unwrapToolResult({ content: [{ type: "text", text }] })).toBe(text);
  });

  it("A2: onAutoPresent fires for the prose-envelope path with the inner format tag, not a generic label", () => {
    const seen: Array<{ format: string; value: unknown }> = [];
    unwrapToolResult(
      { content: [{ type: "text", text: 'Current configuration:\n{"a":1}' }] },
      undefined,
      (format, value) => seen.push({ format, value }),
    );
    expect(seen).toEqual([{ format: "json", value: { a: 1 } }]);
  });

  it(
    "A3: met-museum `get-museum-object` REAL WIRE SHAPE — a double-JSON-encoded colon-KV " +
      "prose scalar (JSON.parse succeeds and yields a STRING) is re-fed through detectEnvelope " +
      "once; no recognizer matches colon-KV prose (A6 deferred), so it stays a PLAIN STRING, " +
      "never silently coerced into something else",
    () => {
      const inner = "Object ID: 438821\nTitle: X";
      const text = JSON.stringify(inner); // the block's raw text is a JSON-encoded string
      const value = unwrapToolResult({ content: [{ type: "text", text }] });
      expect(value).toBe(inner);
      expect(typeof value).toBe("string");
    },
  );

  it(
    "A3: a genuinely double-JSON-encoded OBJECT (text block's text is a JSON string whose " +
      "OWN content is itself valid JSON) recurses through detectEnvelope and surfaces the object",
    () => {
      const innerJson = '{"objectID":438821,"title":"The Rehearsal of the Ballet Onstage"}';
      const text = JSON.stringify(innerJson); // JSON.parse(text) === innerJson (a string);
      // re-detect must recurse into innerJson and parse IT as JSON too.
      const value = unwrapToolResult({ content: [{ type: "text", text }] });
      expect(value).toEqual({ objectID: 438_821, title: "The Rehearsal of the Ballet Onstage" });
    },
  );

  it("A3: onAutoPresent still fires (with 'json') when the JSON.parse yields an ordinary non-double-encoded value", () => {
    const seen: Array<{ format: string; value: unknown }> = [];
    unwrapToolResult({ content: [{ type: "text", text: '{"a":1}' }] }, undefined, (format, value) =>
      seen.push({ format, value }),
    );
    expect(seen).toEqual([{ format: "json", value: { a: 1 } }]);
  });

  it(
    "rule 4: zero TEXT blocks, and MULTIPLE text blocks that don't fit the block-envelope " +
      "algebra (A1), pass the raw content array through untouched (regression pin, RE-PINNED)",
    () => {
      // This pin covers only the "genuinely unclassifiable" case: zero-structural blocks, or 2+
      // structural blocks of MIXED top-level kind. detect.ts's `detectBlockEnvelope` classifies
      // every other multi-block shape — a single structural block plus prose, or an
      // all-structural-homogeneous set — before falling back to raw passthrough; those shapes
      // are covered by the tests below instead.
      const multi = [
        { type: "text", text: "part 1" },
        { type: "text", text: "part 2" },
      ];
      expect(unwrapToolResult({ content: multi })).toBe(multi);
      const empty: unknown[] = [];
      expect(unwrapToolResult({ content: empty })).toBe(empty);
    },
  );

  it("A1: mixed structural KINDS across ALL-structural blocks still pass through raw (strict-or-refuse)", () => {
    const mixedKinds = [
      { type: "text", text: '{"a":1}' },
      { type: "text", text: "[1,2,3]" },
    ];
    expect(unwrapToolResult({ content: mixedKinds })).toBe(mixedKinds);
  });

  it("A1: 2-of-3 structural (not exactly 1, not ALL) passes through raw", () => {
    const partial = [
      { type: "text", text: '{"a":1}' },
      { type: "text", text: "prose in the middle, not JSON" },
      { type: "text", text: '{"b":2}' },
    ];
    expect(unwrapToolResult({ content: partial })).toBe(partial);
  });

  it(`A1: cli-mcp-server \`run_command :command "cat 'Barber Shop.csv'"\` REAL WIRE SHAPE — ${String.raw`CSV payload block + the invariant '\nCommand completed with return code: 0' trailer `}block — auto-presents as a records-vector envelope, never raw passthrough`, () => {
    const csvBlock =
      "Customer Gender,Customer Age,Barber_ID,Service,Price\n" +
      "Male,42,1,Haircut,$15.00\n" +
      "Male,37,2,Beard Trim,$8.00\n" +
      "Female,42,3,Haircut,$12.00";
    const trailerBlock = "\nCommand completed with return code: 0";
    const value = unwrapToolResult({
      content: [
        { type: "text", text: csvBlock },
        { type: "text", text: trailerBlock },
      ],
    }) as { value: unknown; suffix?: string; prefix?: string };
    expect(value.value).toEqual([
      { "Customer Gender": "Male", "Customer Age": "42", Barber_ID: "1", Service: "Haircut", Price: "$15.00" },
      { "Customer Gender": "Male", "Customer Age": "37", Barber_ID: "2", Service: "Beard Trim", Price: "$8.00" },
      { "Customer Gender": "Female", "Customer Age": "42", Barber_ID: "3", Service: "Haircut", Price: "$12.00" },
    ]);
    expect(value.suffix).toBe(trailerBlock);
    expect(value.prefix).toBeUndefined();
  });

  it(
    "A1: pubmed `search_pubmed_key_words` REAL WIRE SHAPE — every block a complete JSON " +
      "object (JSONL-by-blocks) — auto-presents as a vector of the parsed objects",
    () => {
      const block1 = JSON.stringify({ PMID: "42386520", Title: "Developmental Trauma", "Publication Date": "2026" });
      const block2 = JSON.stringify({ PMID: "42385295", Title: "Sexual orientation", "Publication Date": "2026" });
      const block3 = JSON.stringify({ PMID: "42303069", Title: "Clinical profile", "Publication Date": "2026" });
      const value = unwrapToolResult({
        content: [
          { type: "text", text: block1 },
          { type: "text", text: block2 },
          { type: "text", text: block3 },
        ],
      });
      expect(value).toEqual([
        JSON.parse(block1) as unknown,
        JSON.parse(block2) as unknown,
        JSON.parse(block3) as unknown,
      ]);
    },
  );

  it("A1: onAutoPresent fires for the block-envelope path (cli-shape) — latches an observed signature", () => {
    const seen: Array<{ format: string; value: unknown }> = [];
    unwrapToolResult(
      {
        content: [
          { type: "text", text: "id,name\n1,alpha\n2,beta" },
          { type: "text", text: "\nCommand completed with return code: 0" },
        ],
      },
      undefined,
      (format, value) => seen.push({ format, value }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.format).toBe("csv");
    // onAutoPresent receives the INNER value only — the envelope shell's own keys
    // (raw/value/prefix/suffix) must never enter the observed-signature type (§4.2).
    expect(seen[0]!.value).toEqual([
      { id: "1", name: "alpha" },
      { id: "2", name: "beta" },
    ]);
  });

  it("rule 4 EXCEPTION: a non-binary non-text block (resource_link, no payload) still passes through untouched", () => {
    // resource_link carries no base64 payload at all — isBinaryContentBlock excludes it, so the
    // untouched-passthrough behavior applies: there is no base64 to leak.
    const linked = [{ type: "resource_link", uri: "file:///report.pdf", name: "report" }];
    expect(unwrapToolResult({ content: linked })).toBe(linked);
  });
});

describe("unwrapToolResult binary content blocks (attachment stubbing, 2026-07-05)", () => {
  it("a lone binary block collapses to its bare stub string, capturing the original for pass-through", () => {
    const collector = new AttachmentCollector();
    const image = { type: "image", data: "aGVsbG8gd29ybGQ=", mimeType: "image/jpeg" }; // "hello world", 11 bytes
    const value = unwrapToolResult({ content: [image] }, collector.stub);
    expect(value).toBe("#<attachment 1: image/jpeg, 11 bytes>");
    expect(collector.drainBlocks()).toEqual([image]);
  });

  it("multiple binary blocks number sequentially, in encounter order", () => {
    const collector = new AttachmentCollector();
    const img1 = { type: "image", data: "aGVsbG8gd29ybGQ=", mimeType: "image/jpeg" }; // 11 bytes
    const img2 = { type: "image", data: "QUJD", mimeType: "image/png" }; // "ABC", 3 bytes
    const value = unwrapToolResult({ content: [img1, img2] }, collector.stub);
    expect(value).toEqual([
      { type: "text", text: "#<attachment 1: image/jpeg, 11 bytes>" },
      { type: "text", text: "#<attachment 2: image/png, 3 bytes>" },
    ]);
    expect(collector.drainBlocks()).toEqual([img1, img2]);
  });

  it("a mix of text and binary blocks stubs only the binary members, leaving text blocks' own objects untouched", () => {
    const collector = new AttachmentCollector();
    const text = { type: "text", text: "here is your chart" };
    const img = { type: "image", data: "QUJD", mimeType: "image/png" };
    const value = unwrapToolResult({ content: [text, img] }, collector.stub);
    expect(value).toEqual([text, { type: "text", text: "#<attachment 1: image/png, 3 bytes>" }]);
    expect(collector.drainBlocks()).toEqual([img]);
  });

  it("an audio block and an embedded-resource blob both count as binary", () => {
    const collector = new AttachmentCollector();
    const audio = { type: "audio", data: "QUJD", mimeType: "audio/wav" };
    const embedded = { type: "resource", resource: { uri: "res://x", mimeType: "application/pdf", blob: "QUJD" } };
    const value = unwrapToolResult({ content: [audio, embedded] }, collector.stub);
    expect(value).toEqual([
      { type: "text", text: "#<attachment 1: audio/wav, 3 bytes>" },
      { type: "text", text: "#<attachment 2: application/pdf, 3 bytes>" },
    ]);
  });

  it("an embedded-resource carrying TEXT (not blob) is not binary — no stubbing", () => {
    const collector = new AttachmentCollector();
    const textResource = { type: "resource", resource: { uri: "res://x", mimeType: "text/plain", text: "hi" } };
    const only = [textResource];
    expect(unwrapToolResult({ content: only }, collector.stub)).toBe(only);
    expect(collector.drainBlocks()).toEqual([]);
  });

  it("text-only multi-block results never invoke the stub callback (regression)", () => {
    let called = false;
    const stub = (): string => {
      called = true;
      return "unused";
    };
    const multi = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ];
    expect(unwrapToolResult({ content: multi }, stub)).toBe(multi);
    expect(called).toBe(false);
  });

  it("without a supplied stub callback, falls back to a private per-call counter (standalone use)", () => {
    const img1 = { type: "image", data: "QUJD", mimeType: "image/png" };
    const img2 = { type: "image", data: "QUJD", mimeType: "image/png" };
    // No collector passed — each unwrapToolResult call gets its OWN fresh numbering.
    expect(unwrapToolResult({ content: [img1] })).toBe("#<attachment 1: image/png, 3 bytes>");
    expect(unwrapToolResult({ content: [img2] })).toBe("#<attachment 1: image/png, 3 bytes>");
  });

  it("stub() grades by encounter order against the DEFAULT quota when beginCall is never called explicitly", () => {
    const collector = new AttachmentCollector(); // quota defaults to DEFAULT_PASSTHROUGH_ATTACHMENTS (3)
    const images = Array.from({ length: DEFAULT_PASSTHROUGH_ATTACHMENTS + 2 }, (_, i) => ({
      type: "image",
      data: "QUJD",
      mimeType: `image/x-${i}`,
    }));
    const value = unwrapToolResult({ content: images }, collector.stub) as Array<{ type: string; text: string }>;
    expect(value.map((v) => v.text)).toEqual([
      "#<attachment 1: image/x-0, 3 bytes>",
      "#<attachment 2: image/x-1, 3 bytes>",
      "#<attachment 3: image/x-2, 3 bytes>",
      "#<image 4: image/x-3, 3 bytes>",
      "#<image 5: image/x-4, 3 bytes>",
    ]);
  });

  it("AttachmentCollector.drainBlocks bounds pass-through to the call's quota; drainNote names the hidden tail", () => {
    const collector = new AttachmentCollector();
    collector.beginCall(3);
    const images = Array.from({ length: 5 }, (_, i) => ({ type: "image", data: "QUJD", mimeType: `image/x-${i}` }));
    unwrapToolResult({ content: images }, collector.stub);
    expect(collector.drainBlocks()).toEqual(images.slice(0, 3)); // ONLY the within-quota blocks — no note mixed in
    expect(collector.drainNote()).toBe(
      "#| 2 images hidden (quota 3) — raise the 'response-attachments' tool argument |#",
    );
  });

  it("drainNote says 'attachments' (not the per-kind word) when the hidden tail mixes kinds", () => {
    const collector = new AttachmentCollector();
    collector.beginCall(0); // both blocks hidden — a mixed image+audio hidden tail
    const img = { type: "image", data: "QUJD", mimeType: "image/png" };
    const audio = { type: "audio", data: "QUJD", mimeType: "audio/wav" };
    unwrapToolResult({ content: [img, audio] }, collector.stub);
    expect(collector.drainNote()).toBe(
      "#| 2 attachments hidden (quota 0) — raise the 'response-attachments' tool argument |#",
    );
  });

  it("drainNote is undefined when nothing was hidden (every captured block within quota)", () => {
    const collector = new AttachmentCollector();
    collector.beginCall(MAX_PASSTHROUGH_ATTACHMENTS);
    const img = { type: "image", data: "QUJD", mimeType: "image/png" };
    unwrapToolResult({ content: [img] }, collector.stub);
    expect(collector.drainNote()).toBeUndefined();
  });

  it("a quota of 0 hides everything: drainBlocks is empty, every stub grades HIDDEN, drainNote fires", () => {
    const collector = new AttachmentCollector();
    collector.beginCall(0);
    const img = { type: "image", data: "QUJD", mimeType: "image/png" };
    const value = unwrapToolResult({ content: [img] }, collector.stub);
    expect(value).toBe("#<image 1: image/png, 3 bytes>");
    expect(collector.drainBlocks()).toEqual([]);
    expect(collector.drainNote()).toBe(
      "#| 1 images hidden (quota 0) — raise the 'response-attachments' tool argument |#",
    );
  });

  it("AttachmentCollector.beginCall resets numbering, captured blocks, AND quota between calls", () => {
    const collector = new AttachmentCollector();
    const img = { type: "image", data: "QUJD", mimeType: "image/png" };
    collector.beginCall(1);
    expect(unwrapToolResult({ content: [img, img] }, collector.stub)).toEqual([
      { type: "text", text: "#<attachment 1: image/png, 3 bytes>" },
      { type: "text", text: "#<image 2: image/png, 3 bytes>" },
    ]);
    collector.beginCall(); // no explicit quota — falls back to DEFAULT_PASSTHROUGH_ATTACHMENTS
    expect(unwrapToolResult({ content: [img] }, collector.stub)).toBe("#<attachment 1: image/png, 3 bytes>");
    expect(collector.drainBlocks()).toEqual([img]); // only the SECOND call's capture survives
    expect(collector.drainNote()).toBeUndefined(); // 1 block, default quota 3 — nothing hidden this call
  });
});

describe("stripJsonRpcFrame (H-4 reconciliation)", () => {
  it("strips the SDK's leading 'MCP error <code>: ' plumbing frame, keeping the upstream message", () => {
    expect(stripJsonRpcFrame("MCP error -32603: ValueError: boom")).toBe("ValueError: boom");
    expect(stripJsonRpcFrame("MCP error -32602: invalid arguments for add: 'a' is a required property")).toBe(
      "invalid arguments for add: 'a' is a required property",
    );
  });

  it("leaves unframed messages untouched, and only strips a LEADING frame", () => {
    expect(stripJsonRpcFrame("ValueError: boom")).toBe("ValueError: boom");
    expect(stripJsonRpcFrame("saw 'MCP error -32603: x' upstream")).toBe("saw 'MCP error -32603: x' upstream");
  });
});

/** A fake upstream shaped like the bench ToolServers: `add` answers a bare-JSON text block
 *  (no structuredContent), `whois` declares structuredContent, `reject` returns isError,
 *  `crash` throws from its handler (arriving to us as an SDK McpError with the JSON-RPC frame). */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      { name: "whois", description: "Structured user", inputSchema: { type: "object" } },
      { name: "reject", description: "isError result", inputSchema: { type: "object" } },
      { name: "crash", description: "handler throws", inputSchema: { type: "object" } },
      { name: "photo", description: "one image block", inputSchema: { type: "object" } },
      { name: "manyPhotos", description: "more images than the pass-through bound", inputSchema: { type: "object" } },
      {
        name: "sevenPhotos",
        description: "exactly 7 images (3 injected, 4 hidden at the default quota)",
        inputSchema: { type: "object" },
      },
      {
        name: "mixedAttachments",
        description: "images + audio + blob, hidden tail mixes kinds",
        inputSchema: { type: "object" },
      },
    ],
  }));
  // A tiny 3-byte PNG-shaped base64 payload ("ABC") — the actual bytes never matter to this
  // suite, only that it is a real base64 string a real MCP client would render as an image.
  const TINY_IMAGE = { type: "image" as const, data: "QUJD", mimeType: "image/png" };
  const TINY_AUDIO = { type: "audio" as const, data: "QUJD", mimeType: "audio/wav" };
  const TINY_BLOB = {
    type: "resource" as const,
    resource: { uri: "res://x", mimeType: "application/pdf", blob: "QUJD" },
  };
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as { a?: number; b?: number };
    switch (request.params.name) {
      case "add":
        return { content: [{ type: "text", text: JSON.stringify((args.a ?? 0) + (args.b ?? 0)) }] };
      case "whois":
        return {
          content: [{ type: "text", text: '{"name":"Ada Lovelace","role":"analyst"}' }],
          structuredContent: { name: "Ada Lovelace", role: "analyst" },
        };
      case "reject":
        return { content: [{ type: "text", text: "domain rejected: quota exhausted" }], isError: true };
      case "photo":
        return { content: [TINY_IMAGE] };
      case "manyPhotos":
        return { content: Array.from({ length: MAX_PASSTHROUGH_ATTACHMENTS + 2 }, () => TINY_IMAGE) };
      case "sevenPhotos":
        return { content: Array.from({ length: 7 }, () => TINY_IMAGE) };
      case "mixedAttachments":
        return { content: [TINY_IMAGE, TINY_IMAGE, TINY_IMAGE, TINY_AUDIO, TINY_BLOB] };
      default:
        throw new Error("ValueError: boom");
    }
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("toy", await fakeUpstream());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

describe("tool results compose as values through the manifold (H-5, e2e)", () => {
  it("nests a tool call as another tool call's argument — the manifold's raison d'être", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/add :a (toy/add :a 1 :b 1) :b 3)" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toBe("5");
  });

  it("a bare tool result is the VALUE, not a content-block envelope", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(+ (toy/add :a 1 :b 2) 10)" },
    });
    expect(textOf(result as { content: unknown })).toBe("13");
  });

  it("structuredContent arrives as a dict the program can project", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/whois)" },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain("Ada Lovelace");
  });

  it("an upstream isError result surfaces as the standard Error: observation, never as data", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/reject)" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as { content: unknown })).toBe("Error: domain rejected: quota exhausted");
  });

  it("an upstream handler throw crosses without the JSON-RPC plumbing frame", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/crash)" },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content: unknown });
    expect(text).toContain("ValueError: boom");
    expect(text).not.toContain("MCP error -32");
  });
});

/** Response-shape pins for the attachment pass-through feature: the manifold tool's OWN MCP
 *  response — not just the in-value stub — carries the original binary blocks.
 *
 *  `attachments.ts`'s `AttachmentCollector.drainNote()` returns a standalone
 *  `#| N images hidden … |#` line; substrate's runner.ts collects every note-shaped producer
 *  (introduced-bindings, elision, futility, attachment) into one combined
 *  `#| ── environment notes ── … |#` block, always LAST (after real content, including the
 *  pass-through image blocks) — never interleaved as a peer block ahead of data. The invariant
 *  these cases protect: attachments over quota are named, with the right count/kind/quota. */
const envNotesBlock = (line: string): string => ["#| ── environment notes ──", line, "|#"].join("\n");

describe("attachment pass-through (e2e, response shape)", () => {
  it("MCP result content is [text (rendering with the stub), the original image block]", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/photo)" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("#<attachment 1: image/png, 3 bytes>");
    expect(content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
  });

  it("numbering continues across multiple statements within ONE call, in encounter order", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/photo)\n(toy/photo)" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const texts = content.filter((b) => b.type === "text").map((b) => b.text);
    expect(texts[0]).toContain("#<attachment 1:");
    expect(texts[1]).toContain("#<attachment 2:");
    expect(content.filter((b) => b.type === "image")).toHaveLength(2);
  });

  it("numbering + capture RESETS on the next manifold-tool call — never accumulates across calls", async () => {
    const client = await manifoldClient();
    const first = await client.callTool({ name: "scheme-repl-with-all-mcp-tools", arguments: { expr: "(toy/photo)" } });
    const second = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/photo)" },
    });
    const firstText = (first.content as Array<{ text?: string }>)[0]!.text;
    const secondText = (second.content as Array<{ text?: string }>)[0]!.text;
    expect(firstText).toContain("#<attachment 1:");
    expect(secondText).toContain("#<attachment 1:"); // not "attachment 2" — fresh call, fresh count
  });

  it("defaults pass-through to DEFAULT_PASSTHROUGH_ATTACHMENTS (3), not the hard cap — the rest hide with a note", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/manyPhotos)" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    const imageBlocks = content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(DEFAULT_PASSTHROUGH_ATTACHMENTS); // 3, not MAX_PASSTHROUGH_ATTACHMENTS
    const textBlock = content.find((b) => b.type === "text");
    // NUMBERING CONTINUITY (design §5): injected+hidden share ONE running sequence — attachment
    // 1..3 (within default quota), then image 4..10 (the hidden tail, MAX_PASSTHROUGH_ATTACHMENTS+2 total).
    expect(textBlock!.text).toContain("#<attachment 1:");
    expect(textBlock!.text).toContain("#<attachment 3:");
    expect(textBlock!.text).toContain(`#<image 4:`);
    expect(textBlock!.text).toContain(`#<image ${MAX_PASSTHROUGH_ATTACHMENTS + 2}:`);
    expect(textBlock!.text).not.toContain("#<attachment 4:");
    // The consolidated environment-notes block is appended once, AFTER the pass-through image
    // blocks — bookkeeping about the call as a whole, positioned last like every other note class.
    const noteIndex = content.findIndex((b) => b.text?.startsWith("#|"));
    const firstImageIndex = content.findIndex((b) => b.type === "image");
    expect(noteIndex).toBeGreaterThan(-1);
    expect(noteIndex).toBeGreaterThan(firstImageIndex);
    expect(content[noteIndex]!.text).toBe(
      envNotesBlock(
        `#| 7 images hidden (quota ${DEFAULT_PASSTHROUGH_ATTACHMENTS}) — raise the 'response-attachments' tool argument |#`,
      ),
    );
  });

  it("pins the trailing note text verbatim for an exact 4-hidden case", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/sevenPhotos)" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.filter((b) => b.type === "image")).toHaveLength(3);
    const note = content.find((b) => b.text?.startsWith("#|"));
    expect(note?.text).toBe(
      envNotesBlock("#| 4 images hidden (quota 3) — raise the 'response-attachments' tool argument |#"),
    );
  });

  it("says 'attachments' (mixed-type wording) when the hidden tail spans more than one kind", async () => {
    const client = await manifoldClient();
    // 3 images (fill the default quota) + 1 audio + 1 blob resource — the hidden tail is audio+blob.
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/mixedAttachments)" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.filter((b) => b.type === "image")).toHaveLength(3);
    const note = content.find((b) => b.text?.startsWith("#|"));
    expect(note?.text).toBe(
      envNotesBlock("#| 2 attachments hidden (quota 3) — raise the 'response-attachments' tool argument |#"),
    );
    expect(note?.text).not.toContain("images hidden");
  });

  it("no trailing note at all when nothing was hidden", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/photo)" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content.some((b) => b.text?.startsWith("#|"))).toBe(false);
  });

  describe("response-attachments — model-controlled per-call pass-through quota", () => {
    it("raises the quota for this call only, past the default (arg present)", async () => {
      const client = await manifoldClient();
      const result = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": MAX_PASSTHROUGH_ATTACHMENTS },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.filter((b) => b.type === "image")).toHaveLength(MAX_PASSTHROUGH_ATTACHMENTS);
      const note = content.find((b) => b.text?.startsWith("#|"));
      expect(note?.text).toBe(
        envNotesBlock(
          `#| 2 images hidden (quota ${MAX_PASSTHROUGH_ATTACHMENTS}) — raise the 'response-attachments' tool argument |#`,
        ),
      );
    });

    it("clamps a request above MAX_PASSTHROUGH_ATTACHMENTS down to the hard transport cap", async () => {
      const client = await manifoldClient();
      const result = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": 999 },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.filter((b) => b.type === "image")).toHaveLength(MAX_PASSTHROUGH_ATTACHMENTS);
    });

    it("a quota of 0 hides every attachment (zero-quota case)", async () => {
      const client = await manifoldClient();
      const result = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": 0 },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.filter((b) => b.type === "image")).toHaveLength(0);
      const textBlock = content.find((b) => b.type === "text");
      expect(textBlock!.text).not.toContain("#<attachment");
      expect(textBlock!.text).toContain("#<image 1:");
      const note = content.find((b) => b.text?.startsWith("#|"));
      expect(note?.text).toBe(
        envNotesBlock(
          `#| ${MAX_PASSTHROUGH_ATTACHMENTS + 2} images hidden (quota 0) — raise the 'response-attachments' tool argument |#`,
        ),
      );
    });

    it("ignores a non-numeric response-attachments (falls back to the default quota, no error)", async () => {
      const client = await manifoldClient();
      const result = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": "lots" },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.filter((b) => b.type === "image")).toHaveLength(DEFAULT_PASSTHROUGH_ATTACHMENTS);
    });

    // clampAttachmentQuota mirrors clampResponseSize's exact pattern (typeof === "number" &&
    // Number.isFinite ? clamp : default) — the cases below cover negative, non-integer, and
    // non-finite requests that 0/999/"lots" above don't exercise.
    const imageCountFor = async (client: Awaited<ReturnType<typeof manifoldClient>>, value: number) => {
      const result = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": value },
      });
      return (result.content as Array<{ type: string }>).filter((b) => b.type === "image").length;
    };

    it("a negative request clamps to the floor (0), not a negative quota", async () => {
      expect(await imageCountFor(await manifoldClient(), -5)).toBe(0);
    });

    it("a non-integer request truncates toward zero (2.7 -> 2), matching Math.trunc, not Math.round", async () => {
      expect(await imageCountFor(await manifoldClient(), 2.7)).toBe(2);
    });

    it("a negative non-integer request truncates then floors (-2.7 -> 0)", async () => {
      expect(await imageCountFor(await manifoldClient(), -2.7)).toBe(0);
    });

    it("NaN is treated as absent (falls back to the default), never propagated through Math.min/max", async () => {
      expect(await imageCountFor(await manifoldClient(), Number.NaN)).toBe(DEFAULT_PASSTHROUGH_ATTACHMENTS);
    });

    it("Infinity is treated as absent (falls back to the default) — Number.isFinite excludes it before any clamp math runs", async () => {
      expect(await imageCountFor(await manifoldClient(), Number.POSITIVE_INFINITY)).toBe(
        DEFAULT_PASSTHROUGH_ATTACHMENTS,
      );
    });

    it("-Infinity is likewise treated as absent, not clamped to the floor", async () => {
      expect(await imageCountFor(await manifoldClient(), Number.NEGATIVE_INFINITY)).toBe(
        DEFAULT_PASSTHROUGH_ATTACHMENTS,
      );
    });

    it("never leaks a call's quota into the NEXT call — each call reads its own arg (or the default)", async () => {
      const client = await manifoldClient();
      const first = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)", "response-attachments": 1 },
      });
      const firstImages = (first.content as Array<{ type: string }>).filter((b) => b.type === "image");
      expect(firstImages).toHaveLength(1);

      const second = await client.callTool({
        name: "scheme-repl-with-all-mcp-tools",
        arguments: { expr: "(toy/manyPhotos)" },
      });
      const secondImages = (second.content as Array<{ type: string }>).filter((b) => b.type === "image");
      expect(secondImages).toHaveLength(DEFAULT_PASSTHROUGH_ATTACHMENTS); // back to the default, not 1
    });
  });

  it("H-4/H-5 regression: a text-only tool result is unaffected by the attachment machinery", async () => {
    const client = await manifoldClient();
    const result = await client.callTool({
      name: "scheme-repl-with-all-mcp-tools",
      arguments: { expr: "(toy/add :a (toy/add :a 1 :b 1) :b 3)" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "5" }]);
  });
});
