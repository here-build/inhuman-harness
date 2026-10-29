/** Streaming delta assembly: ChatGPT output_text/reasoning and openai-compat delta. */
import { createServer, type IncomingMessage, type Server } from "node:http";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { afterEach, describe, expect, it } from "vitest";

import { ChatGptDriverConnection } from "@/providers/chatgpt";
import { OpenAiCompatDriverConnection } from "@/providers/openai-compat";
import { bindSessionCatalog } from "@/tool-catalog";

import { KernelToolCatalog } from "../../toolkit/tool-table.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function sse(events: readonly object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function passLocal(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("auth.openai.com") || url.includes("auth.x.ai")) {
      return new Response("{}", { status: 200 });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? null : (JSON.parse(text) as unknown);
}

type Dialect = {
  readonly name: string;
  readonly kind: "chatgpt" | "compat";
  readonly contentType: string;
  readonly body: string;
  readonly out: {
    readonly text: string;
    readonly thought: string;
    readonly thoughtKind?: string;
    readonly calls?: unknown;
    readonly encrypted?: string;
    readonly include?: unknown;
    readonly reasoning?: unknown;
    readonly sessionHeader?: string;
  };
};

const dialects: readonly Dialect[] = [
  {
    name: "chatgpt-sse",
    kind: "chatgpt",
    contentType: "text/event-stream",
    body: sse([
      { type: "response.reasoning_summary_text.delta", delta: "**A**", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", delta: "**B**", summary_index: 1 },
      {
        type: "response.output_item.done",
        item: { type: "reasoning", encrypted_content: "enc-sse" },
      },
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.output_text.delta", delta: " there" },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_sse", name: "read_file", arguments: "{}" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]),
    out: {
      text: "Hi there",
      thought: "**A**\n\n**B**",
      thoughtKind: "summary",
      calls: [{ id: "call_sse", type: "function", function: { name: "read_file", arguments: "{}" } }],
      encrypted: "enc-sse",
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "auto" },
      sessionHeader: "stream-chatgpt-sse",
    },
  },
  {
    name: "chatgpt-json",
    kind: "chatgpt",
    contentType: "application/json",
    body: JSON.stringify({
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should greet them. " }],
          encrypted_content: "enc-json",
        },
        { type: "message", content: [{ type: "output_text", text: "Hello my friend." }] },
        { type: "function_call", call_id: "call_json", name: "read_file", arguments: "{}" },
      ],
    }),
    out: {
      text: "Hello my friend.",
      thought: "I should greet them. ",
      thoughtKind: "summary",
      calls: [{ id: "call_json", type: "function", function: { name: "read_file", arguments: "{}" } }],
      encrypted: "enc-json",
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "auto" },
      sessionHeader: "stream-chatgpt-json",
    },
  },
  {
    name: "chatgpt-sse-mixed",
    kind: "chatgpt",
    contentType: "text/event-stream",
    body: sse([
      { type: "response.reasoning_summary_text.delta", delta: "plan " },
      { type: "response.reasoning_text.delta", delta: "more " },
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed" } },
    ]),
    out: {
      text: "Hi",
      thought: "more ",
      thoughtKind: "raw",
    },
  },
  {
    name: "compat-sse",
    kind: "compat",
    contentType: "text/event-stream",
    body: sse([
      { choices: [{ delta: { reasoning_content: "plan " } }] },
      { choices: [{ delta: { reasoning: "more " } }] },
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { content: " there" } }] },
    ]),
    out: { text: "Hi there", thought: "plan more ", thoughtKind: "raw" },
  },
  {
    name: "compat-tool-split",
    kind: "compat",
    contentType: "text/event-stream",
    body: sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_n1", type: "function", function: { name: "read_file", arguments: "" } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"x"}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
    out: {
      text: "",
      thought: "",
      calls: [{ id: "call_n1", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } }],
    },
  },
  {
    name: "compat-thinking-part",
    kind: "compat",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "plan the edit" }],
          },
          finish_reason: "stop",
        },
      ],
    }),
    out: { text: "", thought: "plan the edit", thoughtKind: "raw" },
  },
  {
    name: "compat-thinking-content-field",
    kind: "compat",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "thinking", content: "plan via content" }],
          },
          finish_reason: "stop",
        },
      ],
    }),
    out: { text: "", thought: "plan via content", thoughtKind: "raw" },
  },
  {
    name: "compat-thought-flag",
    kind: "compat",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "plan via flag", thought: true }],
          },
          finish_reason: "stop",
        },
      ],
    }),
    out: { text: "", thought: "plan via flag", thoughtKind: "raw" },
  },
  {
    name: "compat-redacted-thinking",
    kind: "compat",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: [{ type: "redacted_thinking" }],
          },
          finish_reason: "stop",
        },
      ],
    }),
    out: { text: "", thought: "", thoughtKind: "raw" },
  },
  {
    name: "compat-thinking-delta",
    kind: "compat",
    contentType: "text/event-stream",
    body: sse([
      { choices: [{ delta: { content: [{ type: "thinking", thinking: "plan" }] } }] },
      { choices: [{ delta: { content: [{ type: "text", text: "Done." }] } }] },
      { choices: [{ finish_reason: "stop" }] },
    ]),
    out: { text: "Done.", thought: "plan", thoughtKind: "raw" },
  },
  {
    name: "chatgpt-json-reasoning-only",
    kind: "chatgpt",
    contentType: "application/json",
    body: JSON.stringify({
      output: [{ type: "reasoning", encrypted_content: "enc-only" }],
    }),
    out: {
      text: "",
      thought: "",
      thoughtKind: "raw",
      encrypted: "enc-only",
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "auto" },
      sessionHeader: "stream-chatgpt-json-reasoning-only",
    },
  },
];

async function assemble(
  row: Dialect,
  model = "gpt-5.4",
  expectedOutcome: "complete" | "fail" = "complete",
): Promise<{
  text?: string;
  thought?: string;
  thoughtKind?: string | null;
  calls?: unknown;
  outcome: string;
  reason?: string;
  encrypted?: string;
  include?: unknown;
  reasoning?: unknown;
  sessionHeader?: string;
}> {
  let posted: Record<string, unknown> | undefined;
  let sessionHeader: string | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.url?.includes("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(row.kind === "chatgpt" ? { models: [{ slug: model }] } : { data: [{ id: "m1" }] }));
          return;
        }
        if (req.method === "POST") {
          const body = (await readJson(req)) as Record<string, unknown>;
          posted = body;
          sessionHeader = req.headers["session-id"] as string | undefined;
          if (
            row.kind === "chatgpt" &&
            ("prompt_cache_options" in body ||
              "prompt_cache_retention" in body ||
              body.prompt_cache_key !== `stream-${row.name}`)
          ) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ detail: "Unsupported cache policy or missing affinity" }));
            return;
          }
          res.writeHead(200, { "content-type": row.contentType });
          res.end(row.body);
          return;
        }
        res.writeHead(404);
        res.end();
      } catch {
        res.writeHead(500);
        res.end();
      }
    })();
  });
  const port = await listen(server);
  globalThis.fetch = passLocal(originalFetch);
  const connection =
    row.kind === "chatgpt"
      ? new ChatGptDriverConnection("chatgpt", { baseUrl: `http://127.0.0.1:${port}`, model }, { apiKey: "codex-at" })
      : new OpenAiCompatDriverConnection("row", { baseUrl: `http://127.0.0.1:${port}/v1`, model: "m1" });
  const plexus = SessionPlexus.create(`stream-${row.name}`, "/ws");
  bindSessionCatalog(plexus.root, new KernelToolCatalog());
  try {
    await connection.ensureBootstrapStarted();
    const round = new CompletionExpectation({
      promptText: prompt.user`hi`,
      connectionId: connection.connectionId,
    });
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [new CompletionJob({ expectation: round })],
      queue: [],
    });
    const actor = connection.resolveExpectation(round);
    actor.start();
    const settlement = await actor.settled;
    if (expectedOutcome === "fail") {
      if (settlement.outcome !== "fail") {
        throw new Error(`expected fail, got ${settlement.outcome}`);
      }
      return { outcome: settlement.outcome, reason: String(settlement.reason ?? "") };
    }
    if (settlement.outcome !== "complete") {
      throw new Error(String(settlement.reason));
    }
    return {
      outcome: settlement.outcome,
      text: settlement.result.text,
      thought: settlement.result.thought ?? "",
      thoughtKind: round.responseThoughtKind,
      calls: round.responseCalls.map((call) => ({
        id: call.toolCallId,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
      encrypted: round.responseReasoningEncrypted,
      include: posted?.include,
      reasoning: posted?.reasoning,
      sessionHeader,
    };
  } finally {
    plexus.destroy();
    await connection[Symbol.asyncDispose]();
    await closeServer(server);
  }
}

describe("streaming delta assembly", () => {
  it.each(["gpt-5.4", "gpt-5.6-sol", "gpt-6-astra"])(
    "ChatGPT %s completes without public API cache options",
    async (model) => {
      expect(await assemble(dialects[0]!, model)).toMatchObject(dialects[0]!.out);
    },
  );

  it("yields cumulative speech; HTTP-200 failed/missing/speech-incomplete fail; thought-exhausted incomplete completes", async () => {
    const got: Record<string, Awaited<ReturnType<typeof assemble>>> = {};
    for (const row of dialects) {
      got[row.name] = await assemble(row);
    }
    expect(got).toMatchObject({
      "chatgpt-sse": dialects[0]!.out,
      "chatgpt-json": dialects[1]!.out,
      "chatgpt-sse-mixed": dialects[2]!.out,
      "compat-sse": dialects[3]!.out,
      "compat-tool-split": dialects[4]!.out,
      "compat-thinking-part": dialects[5]!.out,
      "compat-thinking-content-field": dialects[6]!.out,
      "compat-thought-flag": dialects[7]!.out,
      "compat-redacted-thinking": dialects[8]!.out,
      "compat-thinking-delta": dialects[9]!.out,
      "chatgpt-json-reasoning-only": dialects[10]!.out,
    });

    const failed: Dialect = {
      name: "chatgpt-sse-failed",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([{ type: "response.failed", response: { error: { message: "upstream failed" } } }]),
      out: { text: "", thought: "" },
    };
    const unterminated: Dialect = {
      name: "chatgpt-sse-unterminated",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([{ type: "response.output_text.delta", delta: "partial" }]),
      out: { text: "", thought: "" },
    };
    const incompleteSpeech: Dialect = {
      name: "chatgpt-sse-incomplete-speech",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
      out: { text: "", thought: "" },
    };
    const incompleteThought: Dialect = {
      name: "chatgpt-sse-incomplete-thought",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([
        { type: "response.reasoning_summary_text.delta", delta: "plan the edit" },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", encrypted_content: "enc-cut" },
        },
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
      out: { text: "", thought: "plan the edit", thoughtKind: "summary", encrypted: "enc-cut" },
    };
    const incompleteNested: Dialect = {
      name: "chatgpt-sse-incomplete-nested",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [
              {
                type: "reasoning",
                encrypted_content: "enc-nested",
                summary: [{ type: "summary_text", text: "plan from output" }],
              },
            ],
          },
        },
      ]),
      out: { text: "", thought: "plan from output", thoughtKind: "summary", encrypted: "enc-nested" },
    };
    const incompleteTokens: Dialect = {
      name: "chatgpt-sse-incomplete-tokens",
      kind: "chatgpt",
      contentType: "text/event-stream",
      body: sse([
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { output_tokens_details: { reasoning_tokens: 128 } },
          },
        },
      ]),
      out: { text: "", thought: "" },
    };
    expect({
      failed: await assemble(failed, "gpt-5.4", "fail"),
      unterminated: await assemble(unterminated, "gpt-5.4", "fail"),
      incompleteSpeech: await assemble(incompleteSpeech, "gpt-5.4", "fail"),
      incompleteThought: await assemble(incompleteThought, "gpt-5.4"),
      incompleteNested: await assemble(incompleteNested, "gpt-5.4"),
      incompleteTokens: await assemble(incompleteTokens, "gpt-5.4"),
    }).toMatchObject({
      failed: { outcome: "fail", reason: "upstream failed" },
      unterminated: { outcome: "fail", reason: "Responses stream ended before terminal response event" },
      incompleteSpeech: { outcome: "fail", reason: "Responses stream incomplete: max_output_tokens" },
      incompleteThought: {
        outcome: "complete",
        text: "",
        thought: "plan the edit",
        thoughtKind: "summary",
        encrypted: "enc-cut",
      },
      incompleteNested: {
        outcome: "complete",
        text: "",
        thought: "plan from output",
        thoughtKind: "summary",
        encrypted: "enc-nested",
      },
      incompleteTokens: { outcome: "complete", text: "", thought: "", thoughtKind: null },
    });
  });
});
