// AUTO-PRESENT — e2e coverage through a REAL manifold server. Two things land together,
// at one seam:
//
//   1. A single-text-block response that isn't valid JSON is now ALSO tried against
//      `detectParse`'s strict recognizer family (ndjson/csv/tsv/toon/python-literal),
//      the same class as the pre-existing grandfathered JSON.parse (server.ts's
//      `unwrapToolResult`) — a refusal still falls back to the raw string, exactly as
//      before.
//   2. The FIRST time a tool's response is auto-presented this way, its catalog
//      signature line gains an `[observed] <format> <shape>` annotation on the next
//      "soft refresh" — a catalog-only rebuild (server.ts's `softRefresh`) that reuses
//      the SAME ambient/scope/tools (unlike a `tools/listChanged` hard rebuild, this one
//      preserves `(define ...)`s) and fires `tools/list_changed` at most once per call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { connectServer } from "../connect.js";
import { ARG_NAME, TOOL_NAME } from "../names.js";
import { amendSignatureText, ObservedSignatureTracker } from "../normalizer/observed-signature.js";
import { buildManifoldServer } from "../server.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

const CSV_TEXT = "Player_No,Team_id,Position\n7,101,Forward\n9,101,Striker\n4,102,Defender";
const PY_LITERAL_TEXT = "[{'id': 1, 'name': 'Ada'}, {'id': 2, 'name': 'Alan'}]";
const PROSE_TEXT = "Commit history:\nCommit abc123 by Ada Lovelace, two days ago.";
const JSON_TEXT = '{"name":"Ada Lovelace","role":"analyst"}';

/** A fake upstream exposing five tools, one per scenario this file covers:
 *    - `csv-tool` / `pyrepr-tool`: strictly-parseable text with NO declared outputSchema
 *      (the auto-present + observed-signature-amendment path).
 *    - `json-tool`: the pre-existing grandfathered JSON.parse path (must stay unchanged).
 *    - `prose-tool`: text that round-trip-parses as nothing (refusal = raw passthrough).
 *    - `declared-tool`: DECLARES a real outputSchema and sends `structuredContent` — the
 *      MCP SDK's own `Client.callTool` REJECTS a schema-declaring tool's response that
 *      lacks `structuredContent` ("has an output schema but did not return structured
 *      content"), so a real declared-output tool always takes `unwrapToolResult`'s rule-2
 *      path (`structuredContent` wins outright, H-5) and never reaches the text-block
 *      auto-present branch at all — "declared wins" holds by construction, not just by
 *      `amendSignatureText`'s guard (which is unit-pinned separately below as
 *      defense-in-depth). */
async function fakeUpstream() {
  const server = new Server({ name: "fake-upstream", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "csv-tool", description: "Returns CSV text", inputSchema: { type: "object" } },
      { name: "pyrepr-tool", description: "Returns a Python repr list", inputSchema: { type: "object" } },
      { name: "json-tool", description: "Returns a JSON object", inputSchema: { type: "object" } },
      { name: "prose-tool", description: "Returns unstructured prose", inputSchema: { type: "object" } },
      {
        name: "declared-tool",
        description: "Declares its own output shape",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case "csv-tool":
        return { content: [{ type: "text", text: CSV_TEXT }] };
      case "declared-tool":
        return {
          content: [{ type: "text", text: JSON.stringify({ value: CSV_TEXT }) }],
          structuredContent: { value: CSV_TEXT },
        };
      case "pyrepr-tool":
        return { content: [{ type: "text", text: PY_LITERAL_TEXT }] };
      case "json-tool":
        return { content: [{ type: "text", text: JSON_TEXT }] };
      case "prose-tool":
        return { content: [{ type: "text", text: PROSE_TEXT }] };
      default:
        throw new Error(`unknown tool ${request.params.name}`);
    }
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

async function manifoldClient() {
  const upstream = await connectServer("t", await fakeUpstream());
  const manifoldServer = await buildManifoldServer([upstream]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

const callRepl = (client: Client, expr: string) =>
  client.callTool({ name: TOOL_NAME, arguments: { [ARG_NAME]: expr } });

const catalogOf = async (client: Client): Promise<string> => {
  const { tools } = await client.listTools();
  return tools[0]?.description ?? "";
};

describe("auto-present — strictly-parseable text arrives as a parsed value", () => {
  it("a CSV-returning tool's response is usable as a vector of records ((:field record) works)", async () => {
    const client = await manifoldClient();
    const define = await callRepl(client, "(define r (t/csv-tool))");
    expect(define.isError).toBeFalsy();
    const count = await callRepl(client, "(vector-length r)");
    expect(count.isError).toBeFalsy();
    expect(textOf(count as { content: unknown })).toBe("3");
    const field = await callRepl(client, "(:Player_No (vector-ref r 0))");
    expect(field.isError).toBeFalsy();
    // CSV cells are strings (never coerced to numbers) — the REPL prints the string literal.
    expect(textOf(field as { content: unknown })).toBe('"7"');
  });

  it("a JSON-returning tool's response is parsed — the pre-existing grandfathered behavior stays intact", async () => {
    const client = await manifoldClient();
    const result = await callRepl(client, "(:name (t/json-tool))");
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain("Ada Lovelace");
  });

  it("prose that parses as nothing stays a raw string — refusal is passthrough, never a mangle", async () => {
    const client = await manifoldClient();
    const result = await callRepl(client, "(t/prose-tool)");
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain("Commit history");
    expect(textOf(result as { content: unknown })).toContain("Ada Lovelace");
  });

  it("a Python-repr-returning tool's response is parsed into records", async () => {
    const client = await manifoldClient();
    const result = await callRepl(client, "(:name (vector-ref (t/pyrepr-tool) 1))");
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain("Alan");
  });
});

describe("auto-present — observed-signature amendment", () => {
  it("after the first CSV response, the tool's catalog line gains an [observed] csv annotation", async () => {
    const client = await manifoldClient();
    expect(await catalogOf(client)).not.toMatch(/t\/csv-tool.*\[observed]/);

    await callRepl(client, "(t/csv-tool)");

    await vi.waitFor(async () => expect(await catalogOf(client)).toMatch(/t\/csv-tool[^\n]*\[observed] csv/));
    const catalog = await catalogOf(client);
    expect(catalog).toMatch(/Player_No/);
  });

  it("a tool WITH a declared outputSchema is never amended — its structuredContent short-circuits auto-present entirely", async () => {
    const client = await manifoldClient();
    const before = await catalogOf(client);
    expect(before).toContain("t/declared-tool");
    expect(before).toMatch(/t\/declared-tool[^\n]*-> \{value:string\}/);

    const result = await callRepl(client, "(:value (t/declared-tool))");
    expect(result.isError).toBeFalsy();
    expect(textOf(result as { content: unknown })).toContain("Player_No"); // structuredContent's raw string, untouched

    // Give any (wrongly-fired) soft refresh a turn to land, then assert nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = await catalogOf(client);
    expect(after).toBe(before);
    expect(after).not.toMatch(/t\/declared-tool[^\n]*\[observed]/);
  });
});

describe("amendSignatureText — declared-wins guard (unit)", () => {
  it("splices ' -> annotation' right after the head when no output shape exists yet", () => {
    expect(amendSignatureText("(t/csv-tool) - Returns CSV text", "[observed] csv records {a, b}")).toBe(
      "(t/csv-tool) -> [observed] csv records {a, b} - Returns CSV text",
    );
  });

  it("splices correctly even with no trailing description", () => {
    expect(amendSignatureText("(t/csv-tool)", "[observed] csv records {a, b}")).toBe(
      "(t/csv-tool) -> [observed] csv records {a, b}",
    );
  });

  // The old guard suppressed amendment whenever a tool declared `-> {content}` — wrong,
  // because the only way `amendSignatureText` is even CALLED for a tool is via the
  // text-block auto-present path (server.ts's `toBoundServer`), reachable ONLY when
  // `structuredContent` did NOT arrive (unwrapToolResult's rule 2 already short-circuits
  // and returns before rule 3's auto-present ever runs — see the e2e "declared-tool"
  // test above). So an observation that reaches this function is BY CONSTRUCTION evidence
  // that the declared prior never materialized structurally this call — the catalog
  // was actively lying about the tool's real shape. The declared shape is demoted to a
  // parenthetical note instead of suppressing the (ground-truth) observation.
  it("A5: an OBSERVED shape AMENDS a DECLARED one — declared demotes to a parenthetical note", () => {
    const declared = "(t/declared-tool) -> {value:string} - Declares its own output shape";
    const amended = amendSignatureText(declared, "[observed] csv records {a, b}");
    expect(amended).toBe(
      "(t/declared-tool) -> [observed] csv records {a, b} (declared: {value:string}) - Declares its own output shape",
    );
  });

  it("A5: amendment over a declared shape with NO trailing description splices correctly too", () => {
    const declared = "(t/declared-tool) -> {value:string}";
    expect(amendSignatureText(declared, "[observed] csv records {a, b}")).toBe(
      "(t/declared-tool) -> [observed] csv records {a, b} (declared: {value:string})",
    );
  });

  it("is idempotent — re-amending an already-amended line is a no-op (the same guard)", () => {
    const once = amendSignatureText("(t/csv-tool)", "[observed] csv records {a, b}");
    expect(amendSignatureText(once, "[observed] csv records {a, b}")).toBe(once);
  });

  it("A5: is ALSO idempotent over a declared+amended line — a second soft refresh doesn't double-wrap", () => {
    const declared = "(t/declared-tool) -> {value:string} - Declares its own output shape";
    const once = amendSignatureText(declared, "[observed] csv records {a, b}");
    const twice = amendSignatureText(once, "[observed] csv records {a, b}");
    expect(twice).toBe(once);
    expect(twice).not.toContain("(declared: [observed]"); // never double-wraps
  });
});

describe("ObservedSignatureTracker (unit)", () => {
  it("latches the FIRST call only — a second, differently-shaped response never overwrites it", () => {
    const tracker = new ObservedSignatureTracker();
    tracker.record("t/x", "csv", [{ a: 1 }]);
    expect(tracker.get("t/x")?.format).toBe("csv");
    tracker.record("t/x", "json", { totally: "different" });
    expect(tracker.get("t/x")?.format).toBe("csv"); // unchanged — one-shot latch
  });

  it("refuses to latch a scalar value — there is no shape to teach", () => {
    const tracker = new ObservedSignatureTracker();
    tracker.record("t/x", "json", 3);
    expect(tracker.get("t/x")).toBeUndefined();
    expect(tracker.drainPending()).toEqual([]);
  });

  it("drainPending returns newly-latched names once, then clears", () => {
    const tracker = new ObservedSignatureTracker();
    tracker.record("t/a", "csv", [{ a: 1 }]);
    tracker.record("t/b", "json", { k: 1 });
    expect(tracker.drainPending().toSorted((a, b) => a.localeCompare(b))).toEqual(["t/a", "t/b"]);
    expect(tracker.drainPending()).toEqual([]); // drained — nothing left
    tracker.record("t/a", "toon", [{ a: 2 }]); // already latched — no new pending entry
    expect(tracker.drainPending()).toEqual([]);
  });

  it("renders a compact key sample — records+row-count for an array, bare keys for an object", () => {
    const tracker = new ObservedSignatureTracker();
    tracker.record("t/records", "csv", [{ Player_No: "7" }, { Player_No: "9" }]);
    expect(tracker.get("t/records")?.annotation).toBe("[observed] csv records {Player_No} (2 rows seen)");

    tracker.record("t/object", "json", { name: "Ada", role: "analyst" });
    expect(tracker.get("t/object")?.annotation).toBe("[observed] json {name, role}");
  });
});

describe("auto-present — soft refresh preserves session state", () => {
  it("(define x 1) survives the soft refresh triggered by a later first-detection", async () => {
    const client = await manifoldClient();
    const define = await callRepl(client, "(define x 1)");
    expect(define.isError).toBeFalsy();

    // Trigger the amendment + soft refresh on an UNRELATED tool.
    const csv = await callRepl(client, "(t/csv-tool)");
    expect(csv.isError).toBeFalsy();
    await vi.waitFor(async () => expect(await catalogOf(client)).toMatch(/\[observed] csv/));

    const readBack = await callRepl(client, "x");
    expect(readBack.isError).toBeFalsy();
    expect(textOf(readBack as { content: unknown })).toBe("1");
  });
});

describe("auto-present — listChanged debounce", () => {
  it("emits tools/list_changed at most once even when ONE program first-observes two different tools", async () => {
    const client = await manifoldClient();
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });

    const result = await callRepl(client, "(t/csv-tool)\n(t/pyrepr-tool)");
    expect(result.isError).toBeFalsy();

    await vi.waitFor(async () => expect(await catalogOf(client)).toMatch(/\[observed] csv/));
    const catalog = await catalogOf(client);
    expect(catalog).toMatch(/t\/pyrepr-tool[^\n]*\[observed] python-literal/);

    // One eval call, two first-detections — still exactly one notification.
    expect(notifications).toBe(1);
  });

  it("a second call whose tool was already observed triggers no further notification", async () => {
    const client = await manifoldClient();
    await callRepl(client, "(t/csv-tool)");
    await vi.waitFor(async () => expect(await catalogOf(client)).toMatch(/\[observed] csv/));

    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications += 1;
    });
    await callRepl(client, "(t/csv-tool)"); // same tool, already latched — nothing changes
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toBe(0);
  });
});
