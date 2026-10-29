import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CONTEXT_NEED_TOOL_NAME,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  PromptMessage,
  responseCall,
  RegisteredToolsSet,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolSpec,
} from "@inhuman.tools/harness-model";
import { describe, expect, it, onTestFinished } from "vitest";

import { BACKGROUND_TOOL, IN_FLIGHT_TOOL } from "@/context";
import { bindSessionCatalog, KernelToolCatalog } from "@/tool-catalog";

import { bindCompletionFace, OpenAiCompatActor, OpenAiCompatDriverConnection, toolsFor } from "../index.js";
import { listenCompat } from "./compat-server.js";

function testCatalog(): KernelToolCatalog {
  const catalog = new KernelToolCatalog();
  catalog.TOOLS_SYSTEM_ADDENDUM = prompt.system`You have real tools.`;
  catalog.replacePack([
    {
      wireName: "shell",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
      class: "effect",
      source: { kind: "pack", pluginName: "pack" },
      representation: "both",
    },
  ]);
  return catalog;
}

const TOOLS_FACE_SYSTEM = testCatalog().TOOLS_SYSTEM_ADDENDUM;

const SCHEMA = {
  type: "object",
  properties: { decision: { type: "string", enum: ["allow", "deny"] } },
  required: ["decision"],
  additionalProperties: false,
};

class ResponsesDriver extends OpenAiCompatDriverConnection {
  override completionApi(): "chat" | "responses" {
    return "responses";
  }
  override completionRequestUrl(): string {
    return `${this.settings.baseUrl}/responses`;
  }
}

class Grokish extends OpenAiCompatDriverConnection {
  override cacheFlavor() {
    return "grok" as const;
  }
}

class OpenAiish extends OpenAiCompatDriverConnection {
  override cacheFlavor() {
    return "openai" as const;
  }
}

class DeepSeekish extends OpenAiCompatDriverConnection {
  override reasoningFlavor() {
    return "deepseek" as const;
  }
}

async function drain(
  connection: OpenAiCompatDriverConnection,
  round: CompletionExpectation,
  opts?: { backoffMs?: (n: number) => number },
): Promise<void> {
  const actor = connection.resolveExpectation(round);
  if (opts?.backoffMs !== undefined && actor instanceof OpenAiCompatActor) actor.backoffMs = opts.backoffMs;
  actor.start();
  const settlement = await actor.settled;
  if (settlement.outcome !== "complete") {
    throw new Error(String(settlement.reason));
  }
}

async function listenStatus(status: number): Promise<{
  readonly baseUrl: string;
  readonly posts: unknown[];
  close(): Promise<void>;
}> {
  const posts: unknown[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      return;
    }
    if (req.method === "POST" && (req.url?.includes("/chat/completions") || req.url?.includes("/responses"))) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(status);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const port = await new Promise<number>((resolve, reject) => {
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
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function completeOnce(opts: {
  sessionId: string;
  connection: (baseUrl: string) => OpenAiCompatDriverConnection;
  models?: Parameters<typeof listenCompat>[0]["models"];
  reply?: Parameters<typeof listenCompat>[0]["reply"];
  build: (plexus: SessionPlexus) => CompletionExpectation;
}): Promise<{
  posts: unknown[];
  headers: Array<Record<string, string>>;
  contentType: string;
  round: CompletionExpectation;
}> {
  const compat = await listenCompat({
    models: opts.models,
    reply: opts.reply ?? (() => "ok"),
  });
  const connection = opts.connection(compat.baseUrl);
  const plexus = SessionPlexus.create(opts.sessionId, "/ws");
  bindSessionCatalog(plexus.root, testCatalog());
  try {
    await connection.ensureBootstrapStarted();
    const round = opts.build(plexus);
    await drain(connection, round);
    return {
      posts: [...compat.posts],
      headers: [...compat.requestHeaders],
      contentType: compat.completionContentType,
      round,
    };
  } finally {
    plexus.destroy();
    await connection[Symbol.asyncDispose]();
    await compat.close();
  }
}

function spineTurn(
  plexus: SessionPlexus,
  round: CompletionExpectation,
  extra?: { toolsDefinition?: RegisteredToolsSet },
): void {
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt({ env: { Mode: "act" } }),
    prompt: round.promptText,
    doneWork: [new CompletionJob({ expectation: round })],
    queue: [],
    ...extra,
  });
}

const RESP_CONN = "row-resp";
const RESP_ENV = {
  role: "developer" as const,
  content: "Workspace: /ws\nMode: act",
};

function nativeCalls(...rows: Array<[id: string, name: string, args?: string]>) {
  return rows.map(([id, name, args]) => responseCall(id, name, args ?? "{}"));
}

function respondRound(
  promptText: string,
  extra?: {
    readonly calls?: ReturnType<typeof nativeCalls>;
    readonly text?: string;
    readonly thought?: string;
    readonly encrypted?: string;
  },
): CompletionExpectation {
  const node = new CompletionExpectation({
    promptText: prompt.user`${promptText}`,
    connectionId: RESP_CONN,
    model: "m1",
  });
  if (extra?.calls !== undefined) node.setResponseCalls(extra.calls);
  if (extra?.text !== undefined) node.responseText = extra.text;
  if (extra?.thought !== undefined) node.responseThought = extra.thought;
  if (extra?.encrypted !== undefined) node.responseReasoningEncrypted = extra.encrypted;
  return node;
}

function respondTip(
  plexus: SessionPlexus,
  cells: Array<CompletionExpectation | SystemToolJob | ProgrammaticJob | ContextNeedToolJob>,
  extra?: { readonly systemNote?: string },
): CompletionExpectation {
  const last = cells.at(-1);
  if (!(last instanceof CompletionExpectation)) throw new Error("respondTip: last cell is not a CompletionExpectation");
  if (extra?.systemNote !== undefined) last.systemNote = prompt.system`${extra.systemNote}`;
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt({ env: { Mode: "act" } }),
    prompt: last.promptText,
    doneWork: cells.map((cell) =>
      cell instanceof CompletionExpectation ? new CompletionJob({ expectation: cell }) : cell,
    ),
    queue: [],
  });
  return last;
}

describe("openai-compat complete: tools face, model preference, usage stamp", () => {
  it("complete() keeps catalog tools, stamps usage, prefers the turn model; JSON schema on chat and Responses; Grok/OpenAI cache keys; frozen tools; Responses tool items", async () => {
    const toolsUsage = await completeOnce({
      sessionId: "pew-complete",
      connection: (baseUrl) =>
        new OpenAiCompatDriverConnection("row-ok", {
          baseUrl,
          model: "settings-model",
        }),
      models: [
        { id: "catalog-first", context_length: 4096 },
        { id: "grok-4.6", context_length: 8192 },
      ],
      reply: () => ({
        content: "ok",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 8 },
          cache_creation_input_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 1 },
          cost: 0.0012,
        },
      }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-ok",
          model: "grok-4.6",
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    const post = toolsUsage.posts[0] as {
      model: string;
      stream: boolean;
      tools: unknown[];
      messages: unknown[];
    };
    expect({
      contentType: toolsUsage.contentType,
      post: {
        model: post.model,
        stream: post.stream,
        stream_options: (toolsUsage.posts[0] as { stream_options?: unknown }).stream_options,
        messages: post.messages,
        toolCount: post.tools.length,
      },
      usage: {
        totalTokens: toolsUsage.round.totalTokens,
        cachedTokens: toolsUsage.round.cachedTokens,
        inputTokens: toolsUsage.round.inputTokens,
        outputTokens: toolsUsage.round.outputTokens,
        cacheWriteTokens: toolsUsage.round.cacheWriteTokens,
        reasoningTokens: toolsUsage.round.reasoningTokens,
        costUsd: toolsUsage.round.costUsd,
        contextLimit: toolsUsage.round.contextLimit,
      },
    }).toEqual({
      contentType: "application/json",
      post: {
        model: "grok-4.6",
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: TOOLS_FACE_SYSTEM },
          { role: "system", content: "Workspace: /ws\nMode: act" },
          { role: "user", content: "hi" },
        ],
        toolCount: expect.any(Number),
      },
      usage: {
        totalTokens: 14,
        cachedTokens: 8,
        inputTokens: 10,
        outputTokens: 4,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        costUsd: 0.0012,
        contextLimit: 8192,
      },
    });
    expect(post.tools.length).toBeGreaterThan(0);

    const schemaChat = await completeOnce({
      sessionId: "pew-schema",
      connection: (baseUrl) =>
        new OpenAiCompatDriverConnection("row-schema", {
          baseUrl,
          model: "m1",
        }),
      reply: () => ({ content: JSON.stringify({ decision: "allow" }) }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`vote`,
          connectionId: "row-schema",
          model: "m1",
          responseSchema: SCHEMA,
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    expect(schemaChat.posts[0]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "Output", schema: SCHEMA, strict: true },
      },
    });

    const schemaResponses = await completeOnce({
      sessionId: "pew-responses",
      connection: (baseUrl) => new ResponsesDriver("row-responses", { baseUrl, model: "m1" }),
      reply: () => ({ content: JSON.stringify({ decision: "allow" }) }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`vote`,
          connectionId: "row-responses",
          model: "m1",
          responseSchema: SCHEMA,
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    const responsesSchemaPost = schemaResponses.posts[0] as {
      tools: unknown[];
      text?: unknown;
    };
    expect({
      text: responsesSchemaPost.text,
      toolCount: responsesSchemaPost.tools.length,
      hasResponseFormat: Object.hasOwn(responsesSchemaPost, "response_format"),
    }).toEqual({
      text: {
        format: {
          type: "json_schema",
          name: "Output",
          strict: true,
          schema: SCHEMA,
        },
      },
      toolCount: expect.any(Number),
      hasResponseFormat: false,
    });
    expect(responsesSchemaPost.tools.length).toBeGreaterThan(0);

    const grok = await completeOnce({
      sessionId: "sess-grok",
      connection: (baseUrl) => new Grokish("row-grok", { baseUrl, model: "grok-4.6" }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-grok",
          model: "grok-4.6",
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    const remainder = await completeOnce({
      sessionId: "sess-grok",
      connection: (baseUrl) => new Grokish("row-rem", { baseUrl, model: "grok-4.6" }),
      build: (plexus) => {
        const tool = new SystemToolJob({
          toolCallId: "t1",
          name: "read_file",
          argsJson: '{"path":".."}',
        });
        const round = new CompletionExpectation({
          promptText: prompt.user`classify`,
          connectionId: "row-rem",
          model: "grok-4.6",
        });
        plexus.root.head = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          doneWork: [tool],
          queue: [],
        });
        tool.children.push(new CompletionJob({ expectation: round, turnTail: tool }));
        return round;
      },
    });
    expect({
      grok: {
        conv: grok.headers[0]?.["x-grok-conv-id"],
        session: grok.headers[0]?.["x-grok-session-id"],
        reqId: grok.headers[0]?.["x-grok-req-id"],
        turnIdx: grok.headers[0]?.["x-grok-turn-idx"],
        cacheKey: (grok.posts[0] as { prompt_cache_key?: string }).prompt_cache_key,
      },
      remainder: {
        conv: remainder.headers[0]?.["x-grok-conv-id"],
        session: remainder.headers[0]?.["x-grok-session-id"],
        cacheKey: (remainder.posts[0] as { prompt_cache_key?: string }).prompt_cache_key,
      },
    }).toEqual({
      grok: {
        conv: "sess-grok",
        session: "sess-grok",
        reqId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu),
        turnIdx: "1",
        cacheKey: "sess-grok",
      },
      remainder: {
        conv: "sess-grok:off-spine",
        session: "sess-grok:off-spine",
        cacheKey: "sess-grok:off-spine",
      },
    });
    expect((grok.posts[0] as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined();

    const grokEffort = await completeOnce({
      sessionId: "sess-grok-effort",
      connection: (baseUrl) => new Grokish("row-grok-effort", { baseUrl, model: "grok-4.6" }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-grok-effort",
          model: "grok-4.6",
          reasoningEffort: "high",
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    expect((grokEffort.posts[0] as { reasoning_effort?: string }).reasoning_effort).toBe("high");

    const deepseek = await completeOnce({
      sessionId: "sess-ds",
      connection: (baseUrl) => new DeepSeekish("row-ds", { baseUrl, model: "deepseek-v4-pro" }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-ds",
          model: "deepseek-v4-pro",
          reasoningEffort: "medium",
        });
        spineTurn(plexus, round);
        return round;
      },
    });
    expect({
      thinking: (deepseek.posts[0] as { thinking?: unknown }).thinking,
      effort: (deepseek.posts[0] as { reasoning_effort?: string }).reasoning_effort,
    }).toEqual({ thinking: { type: "enabled" }, effort: "high" });

    const openai = await completeOnce({
      sessionId: "sess-oai",
      connection: (baseUrl) => new OpenAiish("row-oai", { baseUrl, model: "gpt-5.6" }),
      build: (plexus) => {
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-oai",
          model: "gpt-5.6",
        });
        spineTurn(plexus, round, {
          toolsDefinition: new RegisteredToolsSet({
            entries: [
              new ToolSpec({
                name: "frozen_only",
                description: "d",
                argsJson: '{"type":"object"}',
              }),
            ],
          }),
        });
        return round;
      },
    });
    const openaiBody = openai.posts[0] as {
      prompt_cache_key: string;
      prompt_cache_options: unknown;
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect({
      prompt_cache_key: openaiBody.prompt_cache_key,
      prompt_cache_options: openaiBody.prompt_cache_options,
      tools: openaiBody.tools.map((tool) => tool.function.name),
      firstMessage: openaiBody.messages[0],
    }).toEqual({
      prompt_cache_key: "sess-oai",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
      tools: ["frozen_only"],
      firstMessage: {
        role: "system",
        content: [
          {
            type: "text",
            text: expect.any(String),
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    });

    const responsesTools = await completeOnce({
      sessionId: "sess-resp",
      connection: (baseUrl) => new ResponsesDriver("row-resp", { baseUrl, model: "m1" }),
      build: (plexus) => {
        const tip = new CompletionExpectation({
          promptText: prompt.user`next`,
          connectionId: "row-resp",
          model: "m1",
        });
        spineTurn(plexus, tip);
        return tip;
      },
    });
    const responsesBody = responsesTools.posts[0] as {
      tools: unknown[];
      store: boolean;
      include: unknown;
      reasoning: unknown;
    };
    expect({
      store: responsesBody.store,
      include: responsesBody.include,
      reasoning: responsesBody.reasoning,
      hasTools: responsesBody.tools.length > 0,
    }).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "auto" },
      hasTools: true,
    });
  });

  it("schema non-JSON keeps the completion and quotes it in failReason", async () => {
    const content = "sure, here:\n```json\n{nope}\n```";
    const compat = await listenCompat({ reply: () => ({ content }) });
    const connection = new OpenAiCompatDriverConnection("row-schema-text", {
      baseUrl: compat.baseUrl,
      model: "m1",
    });
    const plexus = SessionPlexus.create("pew-schema-text", "/ws");
    bindSessionCatalog(plexus.root, testCatalog());
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`vote`,
        connectionId: "row-schema-text",
        model: "m1",
        responseSchema: SCHEMA,
      });
      spineTurn(plexus, round);
      const actor = connection.resolveExpectation(round);
      actor.start();
      const settlement = await actor.settled;
      expect({
        settlement: settlement.outcome,
        pew: round.outcome,
        text: round.responseText,
        failReason: round.failReason,
      }).toEqual({
        settlement: "fail",
        pew: "failed",
        text: content,
        failReason: 'response schema: completion is not JSON ("sure, here: ```json {nope} ```")',
      });
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });

  it.each([
    {
      name: "retries 500 then succeeds without fail-sealing the PEW",
      kind: "500" as const,
    },
    {
      name: "does not retry 401; fails the round without catalog sticky-fail",
      kind: "401" as const,
    },
    {
      name: "skipBackoff() during a long sleep starts the second fetch immediately",
      kind: "skipBackoff" as const,
    },
  ])("$name", async ({ kind }) => {
    if (kind === "401") {
      const compat = await listenStatus(401);
      const connection = new OpenAiCompatDriverConnection("row-401", {
        baseUrl: compat.baseUrl,
        model: "m1",
      });
      const plexus = SessionPlexus.create("pew-401", "/ws");
      bindSessionCatalog(plexus.root, testCatalog());
      try {
        await connection.ensureBootstrapStarted();
        const round = new CompletionExpectation({
          promptText: prompt.user`hi`,
          connectionId: "row-401",
          model: "m1",
        });
        plexus.root.head = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          doneWork: [new CompletionJob({ expectation: round })],
          queue: [],
        });
        const actor = connection.resolveExpectation(round);
        (actor as OpenAiCompatActor).backoffMs = () => 0;
        actor.start();
        const settlement = await actor.settled;
        expect({
          settlement: settlement.outcome,
          pew: round.outcome,
          posts: compat.posts.length,
          readyState: connection.readyState,
          failReason: round.failReason,
          error: connection.error,
          lastChallenge: connection.lastChallenge,
          actorKind: actor instanceof OpenAiCompatActor,
        }).toEqual({
          settlement: "fail",
          pew: "failed",
          posts: 1,
          readyState: "ready",
          failReason: `completion POST ${compat.baseUrl}/chat/completions: HTTP 401`,
          error: "",
          lastChallenge: 401,
          actorKind: true,
        });
      } finally {
        plexus.destroy();
        await connection[Symbol.asyncDispose]();
        await compat.close();
      }
      return;
    }

    let n = 0;
    const compat = await listenCompat({
      reply: () => {
        n += 1;
        if (n === 1) throw new Error("down");
        return "ok";
      },
    });
    const connectionId = kind === "500" ? "row-retry" : "row-skip";
    const connection = new OpenAiCompatDriverConnection(connectionId, {
      baseUrl: compat.baseUrl,
      model: "m1",
    });
    const plexus = SessionPlexus.create(kind === "500" ? "pew-retry" : "pew-skip", "/ws");
    bindSessionCatalog(plexus.root, testCatalog());
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId,
        model: "m1",
      });
      plexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [new CompletionJob({ expectation: round })],
        queue: [],
      });
      if (kind === "500") {
        await drain(connection, round, { backoffMs: () => 0 });
        expect({ outcome: round.outcome, posts: compat.posts.length }).toEqual({
          outcome: "successful",
          posts: 2,
        });
        return;
      }
      void round.awareness;
      const actor = connection.resolveExpectation(round);
      const compatActor = actor as OpenAiCompatActor;
      compatActor.backoffMs = () => 60_000;
      actor.start();
      await expect.poll(() => compat.posts.length).toBe(1);
      await expect.poll(() => typeof (round.report as { retryUntilMs?: number } | null)?.retryUntilMs).toBe("number");
      compatActor.skipBackoff();
      const settlement = await actor.settled;
      expect({
        settlement: settlement.outcome,
        pew: round.outcome,
        posts: compat.posts.length,
        actorKind: actor instanceof OpenAiCompatActor,
      }).toEqual({
        settlement: "complete",
        pew: "successful",
        posts: 2,
        actorKind: true,
      });
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });

  it("retries a wrapped dropped completion POST then succeeds", async () => {
    const posts: unknown[] = [];
    let n = 0;
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1" }] }));
        return;
      }
      if (req.method === "POST" && (req.url?.includes("/chat/completions") || req.url?.includes("/responses"))) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        posts.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        n += 1;
        if (n === 1) {
          req.socket?.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    };
    const server = createServer((req, res) => {
      void handle(req, res);
    });
    const port = await new Promise<number>((resolve, reject) => {
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
    const connection = new OpenAiCompatDriverConnection("row-wrap", {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m1",
    });
    const plexus = SessionPlexus.create("pew-wrap", "/ws");
    bindSessionCatalog(plexus.root, testCatalog());
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-wrap",
        model: "m1",
      });
      plexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [new CompletionJob({ expectation: round })],
        queue: [],
      });
      await drain(connection, round, { backoffMs: () => 0 });
      expect({ outcome: round.outcome, posts: posts.length }).toEqual({
        outcome: "successful",
        posts: 2,
      });
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

describe("Responses input is the chat wire lowered", () => {
  it.each([
    {
      name: "tool_calls plus matching function_call_output",
      build: (plexus: SessionPlexus) => {
        const job = new SystemToolJob({
          toolCallId: "call_1",
          name: "read_file",
          argsJson: "{}",
          outcomeJson: JSON.stringify({ ok: true, text: "file-ok" }),
          humanApprove: false,
          regenerateable: true,
          completed: true,
        });
        return respondTip(plexus, [
          respondRound("q", { calls: nativeCalls(["call_1", "read_file"]) }),
          job,
          respondRound("next"),
        ]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_1", output: "file-ok" },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "unresolved background and foreground emit correlator output",
      build: (plexus: SessionPlexus) => {
        const background = new SystemToolJob({
          toolCallId: "bg_1",
          name: "shell",
          argsJson: "{}",
          background: true,
        });
        const inflight = new SystemToolJob({
          toolCallId: "fg_1",
          name: "shell",
          argsJson: "{}",
        });
        const prior = respondRound("q", {
          calls: nativeCalls(["bg_1", "shell"], ["fg_1", "shell"]),
        });
        return respondTip(plexus, [prior, background, inflight, respondRound("next")]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        {
          type: "function_call",
          call_id: "bg_1",
          name: "shell",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "fg_1",
          name: "shell",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "bg_1",
          output: BACKGROUND_TOOL,
        },
        {
          type: "function_call_output",
          call_id: "fg_1",
          output: IN_FLIGHT_TOOL,
        },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "leftover system is developer; first system is instructions only",
      build: (plexus: SessionPlexus) =>
        respondTip(plexus, [respondRound("next")], {
          systemNote: "Call update_metadata in the same completion",
        }),
      input: [
        RESP_ENV,
        {
          role: "developer",
          content: "Call update_metadata in the same completion",
        },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "need-only prior is an empty assistant shell",
      build: (plexus: SessionPlexus) => {
        const needArgs = JSON.stringify({ min_remaining_tokens: 8000 });
        const need = new ContextNeedToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "n1",
          name: CONTEXT_NEED_TOOL_NAME,
          argsJson: needArgs,
          outcomeJson: JSON.stringify({ ok: true }),
          completed: true,
        });
        return respondTip(plexus, [
          respondRound("q", {
            calls: nativeCalls(["n1", CONTEXT_NEED_TOOL_NAME, needArgs]),
          }),
          need,
          respondRound("next"),
        ]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        { role: "assistant", content: "" },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "encrypted reasoning item has no id",
      build: (plexus: SessionPlexus) => {
        const prior = respondRound("q", {
          text: "ok",
          thought: "plan",
          encrypted: "enc-blob",
        });
        return respondTip(plexus, [prior, respondRound("next")]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "plan" }],
          encrypted_content: "enc-blob",
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "scheme_repl parts flatten to one output string",
      build: (plexus: SessionPlexus) => {
        const job = new ProgrammaticJob({
          toolCallId: "call_1",
          argsJson: JSON.stringify({
            description: "test",
            expr: '(+ 1 2)\n(string-append "hello" " " "world")',
          }),
          outcomeJson: JSON.stringify({
            ok: true,
            value: ["3", "hello world"],
          }),
          completed: true,
        });
        return respondTip(plexus, [
          respondRound("q", { calls: nativeCalls(["call_1", "scheme_repl"]) }),
          job,
          respondRound("next"),
        ]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "scheme_repl",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "3\nhello world",
        },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "update_metadata stays append-only",
      build: (plexus: SessionPlexus) => {
        const firstArgs = JSON.stringify({ current_turn_title: "First" });
        const laterArgs = JSON.stringify({ current_turn_title: "Later" });
        const stale = new SystemToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "m1",
          name: "update_metadata",
          argsJson: firstArgs,
          outcomeJson: JSON.stringify({ ok: true }),
          completed: true,
        });
        const live = new SystemToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "m2",
          name: "update_metadata",
          argsJson: laterArgs,
          outcomeJson: JSON.stringify({ ok: true }),
          completed: true,
        });
        return respondTip(plexus, [
          respondRound("q", {
            calls: nativeCalls(["m1", "update_metadata", firstArgs]),
          }),
          stale,
          respondRound("again", {
            calls: nativeCalls(["m2", "update_metadata", laterArgs]),
          }),
          live,
          respondRound("next"),
        ]);
      },
      input: [
        RESP_ENV,
        { role: "user", content: "q" },
        {
          type: "function_call",
          call_id: "m1",
          name: "update_metadata",
          arguments: JSON.stringify({ current_turn_title: "First" }),
        },
        { type: "function_call_output", call_id: "m1", output: "" },
        { role: "user", content: "again" },
        {
          type: "function_call",
          call_id: "m2",
          name: "update_metadata",
          arguments: JSON.stringify({ current_turn_title: "Later" }),
        },
        { type: "function_call_output", call_id: "m2", output: "" },
        { role: "user", content: "next" },
      ],
    },
  ])("$name", async ({ name, build, input }) => {
    const result = await completeOnce({
      sessionId: `resp-input-${name.replaceAll(/\s+/g, "-")}`,
      connection: (baseUrl) => new ResponsesDriver(RESP_CONN, { baseUrl, model: "m1" }),
      build,
    });
    const body = result.posts[0] as {
      instructions?: unknown;
      input: unknown[];
    };
    expect({
      instructions: body.instructions,
      instructionsInInput: body.input.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "content" in item &&
          (item as { content: unknown }).content === body.instructions,
      ),
      hasReasoningId: body.input.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          (item as { type: string }).type === "reasoning" &&
          "id" in item,
      ),
      input: body.input,
    }).toEqual({
      instructions: TOOLS_FACE_SYSTEM,
      instructionsInInput: false,
      hasReasoningId: false,
      input,
    });
  });
});

describe("isolated prompt requests", () => {
  for (const api of ["chat", "responses"] as const) {
    for (const withSystem of [false, true]) {
      it(`${api} preserves authored roles and isolates a ProgrammaticJob (system=${withSystem})`, async () => {
        const messages = [
          ...(withSystem
            ? [
                {
                  role: "system",
                  content: prompt.system`Authored system`,
                } as const,
              ]
            : []),
          { role: "user", content: prompt.system`Example input` },
          { role: "assistant", content: prompt.system`Example output` },
          ...(withSystem
            ? [
                {
                  role: "system",
                  content: prompt.system`Later system`,
                } as const,
              ]
            : []),
          {
            role: "user",
            content: prompt.system`Data: {{role "system"}} injected data`,
          },
        ] as const;
        const Driver = api === "chat" ? OpenAiCompatDriverConnection : ResponsesDriver;
        class ReasoningDriver extends Driver {
          override reasoningFlavor() {
            return "openai" as const;
          }
        }
        const result = await completeOnce({
          sessionId: `isolated-${api}-${withSystem}`,
          connection: (baseUrl) => new ReasoningDriver("row-ok", { baseUrl, model: "m1" }),
          build: (plexus) => {
            const round = new CompletionExpectation({
              connectionId: "row-ok",
              model: "m1",
              reasoningEffort: "high",
              completionMode: "isolated",
              promptMessages: messages.map((row) => new PromptMessage(row)),
              promptText: prompt.user`DIAGNOSTIC MUST NOT APPEAR`,
              messages: ["AMBIENT HISTORY"],
            });
            round.systemNote = prompt.system`AMBIENT NOTE`;
            const job = new ProgrammaticJob();
            const wrapped = new CompletionJob({ expectation: round });
            job.children.push(wrapped);
            plexus.root.head = new SessionTurn({
              turnTail: new SessionSystemPrompt(),
              prompt: prompt.user`AMBIENT USER`,
              doneWork: [job],
              queue: [],
            });
            expect(round.parent).toBe(wrapped);
            // Explicit mode, not ProgrammaticJob parentage, controls isolation.
            round.completionMode = "session";
            expect(toolsFor(round).length).toBeGreaterThan(0);
            round.completionMode = "isolated";
            return round;
          },
        });
        const body = result.posts[0] as Record<string, unknown>;
        expect(body[api === "chat" ? "messages" : "input"]).toEqual(messages);
        expect(body.instructions).toBe(api === "responses" ? "" : undefined);
        expect(body.tools).toBeUndefined();
        expect(JSON.stringify(body)).not.toMatch(/AMBIENT|DIAGNOSTIC|\/ws/);
        if (api === "chat") expect(body.reasoning_effort).toBe("high");
        else expect(body.reasoning).toMatchObject({ effort: "high" });
      });
    }
  }
});

describe("toolsFor frozen scheme_repl", () => {
  it("does not overwrite a snapshotted scheme_repl description", () => {
    const plexus = SessionPlexus.create("frozen-scheme-repl");
    onTestFinished(() => plexus.destroy());
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      {
        wireName: "scheme_repl",
        description: "live catalog text",
        parameters: { type: "object", properties: {} },
        class: "effect",
        source: { kind: "pack", pluginName: "pack" },
        representation: "tool",
      },
    ]);
    bindSessionCatalog(plexus.root, catalog);
    const pew = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`q`,
    });
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      doneWork: [new CompletionJob({ expectation: pew })],
      queue: [],
      toolsDefinition: new RegisteredToolsSet({
        entries: [
          new ToolSpec({
            name: "scheme_repl",
            description: "FROZEN scheme inventory",
            argsJson: '{"type":"object"}',
          }),
        ],
      }),
    });
    const row = toolsFor(pew).find((tool) => tool.function.name === "scheme_repl");
    expect(row?.function.description).toBe("FROZEN scheme inventory");
  });
});

describe("toolsFor live catalog face", () => {
  it("uses the bound session view and live scheme_repl overlay, not the product catalog", () => {
    const plexus = SessionPlexus.create("live-catalog-face");
    onTestFinished(() => plexus.destroy());
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      {
        wireName: "shell",
        description: "Run a shell command",
        parameters: { type: "object", properties: {} },
        class: "effect",
        source: { kind: "pack", pluginName: "pack" },
        representation: "both",
      },
      {
        wireName: "scheme_repl",
        description: "static catalog blurb",
        parameters: { type: "object", properties: {} },
        class: "effect",
        source: { kind: "pack", pluginName: "pack" },
        representation: "tool",
      },
    ]);
    bindSessionCatalog(plexus.root, catalog);
    bindCompletionFace(plexus.root, {
      catalog: () => catalog.view((wire) => wire !== "shell"),
      liveDescription: (name) => (name === "scheme_repl" ? "live inventory" : undefined),
    });
    const pew = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`q`,
    });
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      doneWork: [new CompletionJob({ expectation: pew })],
      queue: [],
    });
    const names = toolsFor(pew).map((tool) => tool.function.name);
    const scheme = toolsFor(pew).find((tool) => tool.function.name === "scheme_repl");
    expect(names.includes("shell")).toBe(false);
    expect(scheme?.function.description).toBe("live inventory");
    expect(scheme?.function.description).not.toBe("static catalog blurb");
  });
});
