import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { bindSessionCatalog, KernelToolCatalog } from "@/tool-catalog";

import { retryAfterMs } from "../actor.js";
import { OpenAiCompatActor, OpenAiCompatDriverConnection } from "../index.js";

type Handler = (n: number, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<{ baseUrl: string; posts: () => number; close(): Promise<void> }> {
  let posts = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      return;
    }
    req.resume();
    req.on("end", () => handler(posts++, res));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts: () => posts,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function run(
  handler: Handler,
  setup?: (round: CompletionExpectation) => void,
  setupActor?: (actor: OpenAiCompatActor) => void,
  responses = false,
): Promise<{ round: CompletionExpectation; posts: number; ms: number }> {
  const server = await listen(handler);
  class ResponsesDriver extends OpenAiCompatDriverConnection {
    override completionApi(): "chat" | "responses" {
      return "responses";
    }
    override completionRequestUrl(): string {
      return `${this.settings.baseUrl}/responses`;
    }
  }
  const Driver = responses ? ResponsesDriver : OpenAiCompatDriverConnection;
  const connection = new Driver("row", { baseUrl: server.baseUrl, model: "m1" });
  const plexus = SessionPlexus.create("retry-and-stop", "/ws");
  bindSessionCatalog(plexus.root, new KernelToolCatalog());
  try {
    await connection.ensureBootstrapStarted();
    const round = new CompletionExpectation({ promptText: prompt.user`hi`, connectionId: "row", model: "m1" });
    setup?.(round);
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: round.promptText,
      doneWork: [new CompletionJob({ expectation: round })],
      queue: [],
    });
    const actor = connection.resolveExpectation(round);
    if (actor instanceof OpenAiCompatActor) {
      actor.backoffMs = () => 0;
      setupActor?.(actor);
    }
    const started = Date.now();
    actor.start();
    await actor.settled;
    return { round, posts: server.posts(), ms: Date.now() - started };
  } finally {
    plexus.destroy();
    await connection[Symbol.asyncDispose]();
    await server.close();
  }
}

describe("Retry-After", () => {
  it("reads seconds, milliseconds, and dates on 429 and 503 only", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "7" }), 429)).toBe(7000);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }), 503)).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250", "retry-after": "9" }), 429)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }), 503, now)).toBe(30_000);
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 31 Dec 2025 00:00:00 GMT" }), 503, now)).toBe(0);
    expect(retryAfterMs(new Headers({ "retry-after": "7" }), 500)).toBeUndefined();
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }), 429)).toBeUndefined();
    expect(retryAfterMs(new Headers(), 429)).toBeUndefined();
  });

  it("waits at least as long as the server asked before the next attempt", async () => {
    const { round, posts, ms } = await run((n, res) => {
      if (n === 0) {
        res.writeHead(429, { "retry-after-ms": "300" });
        res.end();
        return;
      }
      sse(res, [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    expect({ posts, outcome: round.outcome, text: round.responseText }).toEqual({
      posts: 2,
      outcome: "successful",
      text: "ok",
    });
    expect(ms).toBeGreaterThanOrEqual(280);
  });
});

describe("retry budget", () => {
  it("retries a transient error with no limit by default", async () => {
    const { round, posts } = await run((n, res) => {
      if (n < 4) {
        res.writeHead(503);
        res.end();
        return;
      }
      sse(res, [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    });
    expect({ posts, outcome: round.outcome }).toEqual({ posts: 5, outcome: "successful" });
  });

  it("gives up after the recorded number of attempts and says why", async () => {
    const { round, posts } = await run(
      (_n, res) => {
        res.writeHead(503);
        res.end();
      },
      (r) => r.stampRetryLimits({ maxMs: 0, maxAttempts: 3 }),
    );
    expect({ posts, outcome: round.outcome }).toEqual({ posts: 3, outcome: "failed" });
    expect(round.failReason).toContain("gave up after 3 attempts");
  });

  it("gives up after the recorded time", async () => {
    const { round } = await run(
      (_n, res) => {
        res.writeHead(503, { "retry-after-ms": "120" });
        res.end();
      },
      (r) => r.stampRetryLimits({ maxMs: 200, maxAttempts: 0 }),
    );
    expect(round.outcome).toBe("failed");
    expect(round.failReason).toContain("of retrying");
  });
});

describe("stop reasons on the wire", () => {
  it("records the provider's stop reason on the completion", async () => {
    const { round } = await run((_n, res) =>
      sse(res, [
        { choices: [{ delta: { content: "partial" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    );
    expect({ finish: round.finishReason, text: round.responseText }).toEqual({ finish: "length", text: "partial" });
  });

  it("records content_filter", async () => {
    const { round } = await run((_n, res) => sse(res, [{ choices: [{ delta: {}, finish_reason: "content_filter" }] }]));
    expect(round.finishReason).toBe("content_filter");
    expect(round.responseText).toBe("");
  });

  it("keeps a tool call cut off by the output limit as a flagged call, not as arguments to run", async () => {
    const { round } = await run((_n, res) =>
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "write_file", arguments: "" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts","content":"hel' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    );
    expect(round.finishReason).toBe("length");
    expect(round.responseCalls.map((call) => [call.toolCallId, call.name, call.dropReason])).toEqual([
      ["call_1", "write_file", "truncated"],
    ]);
  });

  it("keeps a whole call whole when the stop reason is tool_calls", async () => {
    const { round } = await run((_n, res) =>
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "write_file", arguments: '{"path":"a"}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    expect(round.finishReason).toBe("tool_calls");
    expect(round.responseCalls.map((call) => [call.name, call.dropReason])).toEqual([["write_file", ""]]);
  });
});

describe("completion no-progress deadlines", () => {
  it.each(["headers", "json", "error"])("fails a stalled %s once rather than leaving the turn live", async (phase) => {
    const { round, posts, ms } = await run(
      (_n, res) => {
        if (phase !== "headers") {
          res.writeHead(phase === "error" ? 503 : 200, { "content-type": "application/json" });
          res.flushHeaders();
          res.write('{"partial":');
        }
      },
      undefined,
      (actor) => {
        actor.stallMs = 40;
      },
    );
    expect(round.outcome).toBe("failed");
    expect(round.endCause).toBe("settled");
    expect(round.failReason).toContain("stalled after 40ms");
    expect(posts).toBe(1);
    expect(ms).toBeLessThan(2000);
  });
});

describe("authoritative provider termination", () => {
  it.each([
    {
      name: "chat EOF without terminal",
      responses: false,
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
      type: "text/event-stream",
    },
    {
      name: "chat error JSON",
      responses: false,
      body: JSON.stringify({ error: { message: "upstream failed" } }),
      type: "application/json",
    },
    {
      name: "chat missing message",
      responses: false,
      body: JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
      type: "application/json",
    },
    {
      name: "chat missing terminal",
      responses: false,
      body: JSON.stringify({ choices: [{ message: { content: "partial" } }] }),
      type: "application/json",
    },
    {
      name: "Responses failed JSON",
      responses: true,
      body: JSON.stringify({ status: "failed", error: { message: "upstream failed" }, output: [] }),
      type: "application/json",
    },
    {
      name: "Responses error JSON",
      responses: true,
      body: JSON.stringify({ error: { message: "upstream failed" } }),
      type: "application/json",
    },
    {
      name: "Responses missing status",
      responses: true,
      body: JSON.stringify({ output: [] }),
      type: "application/json",
    },
    {
      name: "Responses unknown incomplete reason",
      responses: true,
      body: JSON.stringify({ status: "incomplete", incomplete_details: { reason: "unknown_reason" }, output: [] }),
      type: "application/json",
    },
  ])("$name cannot become a successful empty answer", async ({ responses, body, type }) => {
    const { round, posts } = await run(
      (_n, res) => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      },
      (attempt) => attempt.stampRetryLimits({ maxMs: 0, maxAttempts: 1 }),
      undefined,
      responses,
    );
    expect({ outcome: round.outcome, calls: round.responseCalls.length, posts }).toEqual({
      outcome: "failed",
      calls: 0,
      posts: 1,
    });
  });

  it.each([
    { reason: "max_output_tokens", finish: "length", outcome: "successful" },
    { reason: "content_filter", finish: "content_filter", outcome: "successful" },
    { reason: "unknown_reason", finish: "", outcome: "failed" },
  ])("Responses $reason has the same terminal meaning in bulk and SSE", async ({ reason, finish, outcome }) => {
    const response = {
      status: "incomplete",
      incomplete_details: { reason },
      output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
    };
    const got = [];
    for (const encoding of ["bulk", "sse"]) {
      const { round } = await run(
        (_n, res) => {
          res.writeHead(200, { "content-type": encoding === "bulk" ? "application/json" : "text/event-stream" });
          res.end(
            encoding === "bulk"
              ? JSON.stringify(response)
              : `data: ${JSON.stringify({ type: "response.incomplete", response })}\n\n`,
          );
        },
        (attempt) => attempt.stampRetryLimits({ maxMs: 0, maxAttempts: 1 }),
        undefined,
        true,
      );
      got.push({ encoding, outcome: round.outcome, finish: round.finishReason, text: round.responseText });
    }
    expect(got).toEqual(
      ["bulk", "sse"].map((encoding) => ({
        encoding,
        outcome,
        finish,
        text: outcome === "successful" ? "partial" : "",
      })),
    );
  });

  it("settles at the chat terminal event even when the server keeps the connection open", async () => {
    const { round } = await run(
      (_n, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n`);
        // Deliberately no EOF; a valid terminal is the receipt.
      },
      undefined,
      (actor) => {
        actor.stallMs = 100;
      },
    );
    expect({ outcome: round.outcome, text: round.responseText, finish: round.finishReason }).toEqual({
      outcome: "successful",
      text: "Done.",
      finish: "stop",
    });
  });
});
