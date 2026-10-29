import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  CompactJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { ChatGptDriverConnection } from "@/providers/chatgpt";
import { GrokDriverConnection } from "@/providers/grok";
import {
  OpenAiCompatActor,
  OpenAiCompatDriverConnection,
  cacheAffinityFor,
  cacheFlavorFromBaseUrl,
  chatgptCacheAffinity,
  grokCacheAffinity,
  openaiCacheAffinity,
  usesExplicitPromptCache,
} from "@/providers/openai-compat";
import { bindSessionCatalog } from "@/tool-catalog";

import { listenCompat } from "../../testkit/compat-server.js";
import { KernelToolCatalog } from "../../toolkit/tool-table.js";

class Grokish extends OpenAiCompatDriverConnection {
  override cacheFlavor() {
    return "grok" as const;
  }
}

async function drain(connection: OpenAiCompatDriverConnection, round: CompletionExpectation): Promise<void> {
  const actor = connection.resolveExpectation(round);
  if (actor instanceof OpenAiCompatActor) actor.backoffMs = () => 0;
  actor.start();
  const settlement = await actor.settled;
  if (settlement.outcome !== "complete") {
    throw new Error(String(settlement.reason));
  }
}

describe("cache affinity", () => {
  it("affinity fields pin flavor, clamp 64 code points, stamp expected vs actual hit, and skip hit after a cutoff", async () => {
    const chatgpt = new ChatGptDriverConnection("chatgpt", {
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    const grok = new GrokDriverConnection("grok", { baseUrl: "https://cli-chat-proxy.grok.com/v1" });
    const generic = new OpenAiCompatDriverConnection("row", { baseUrl: "https://api.x.ai/v1" });
    const chatgptLocal = new ChatGptDriverConnection("chatgpt", { baseUrl: "http://127.0.0.1:1234" });
    const chatgptExpected = {
      headers: { "session-id": "session", "thread-id": "session" },
      body: { prompt_cache_key: "session" },
    };
    const clamped = chatgptCacheAffinity("😀".repeat(70)).body.prompt_cache_key as string;
    expect({
      flavors: {
        grok: cacheFlavorFromBaseUrl("https://api.x.ai/v1"),
        grokProxy: cacheFlavorFromBaseUrl("https://cli-chat-proxy.grok.com/v1"),
        openai: cacheFlavorFromBaseUrl("https://api.openai.com/v1"),
        chatgpt: cacheFlavorFromBaseUrl("https://chatgpt.com/backend-api/codex"),
        openrouter: cacheFlavorFromBaseUrl("https://openrouter.ai/api/v1"),
        local: cacheFlavorFromBaseUrl("http://127.0.0.1:1234/v1"),
      },
      grok: grokCacheAffinity("sess-1"),
      grokTurn: grokCacheAffinity("sess-1", { requestId: "req-9", turnIndex: 3 }),
      openai54: openaiCacheAffinity("sess-1", "gpt-5.4"),
      openai56: openaiCacheAffinity("sess-1", "gpt-5.6"),
      none: cacheAffinityFor("none", "sess-1", "m1"),
      explicit: {
        gpt55: usesExplicitPromptCache("gpt-5.5"),
        gpt56sol: usesExplicitPromptCache("gpt-5.6-sol"),
        gpt6: usesExplicitPromptCache("gpt-6"),
      },
      pin: {
        grok: grok.cacheFlavor(),
        chatgpt: chatgpt.cacheFlavor(),
        generic: generic.cacheFlavor(),
        grokHeaders: grok.cacheAffinity("s", "grok-4.6").headers,
        grokTurnHeaders: grok.cacheAffinity("s", "grok-4.6", { requestId: "r1", turnIndex: 2 }).headers,
        chatgptAffinity: chatgpt.cacheAffinity("s", "gpt-5.4"),
      },
      chatgptModels: Object.fromEntries(
        ["gpt-5.4", "gpt-5.6-sol", "gpt-6-astra"].map((model) => [
          model,
          {
            connection: chatgptLocal.cacheAffinity("session", model),
            flavor: cacheAffinityFor(cacheFlavorFromBaseUrl("https://chatgpt.com/backend-api/codex"), "session", model),
          },
        ]),
      ),
      emptyKey: chatgptLocal.cacheAffinity("  ", "gpt-5.4"),
      clamp: { length: [...clamped].length, value: clamped },
    }).toEqual({
      flavors: {
        grok: "grok",
        grokProxy: "grok",
        openai: "openai",
        chatgpt: "chatgpt",
        openrouter: "openrouter",
        local: "none",
      },
      grok: {
        headers: { "x-grok-conv-id": "sess-1", "x-grok-session-id": "sess-1" },
        body: { prompt_cache_key: "sess-1" },
      },
      grokTurn: {
        headers: {
          "x-grok-conv-id": "sess-1",
          "x-grok-session-id": "sess-1",
          "x-grok-req-id": "req-9",
          "x-grok-turn-idx": "3",
        },
        body: { prompt_cache_key: "sess-1" },
      },
      openai54: {
        headers: {},
        body: { prompt_cache_key: "sess-1", prompt_cache_retention: "24h" },
      },
      openai56: {
        headers: {},
        body: {
          prompt_cache_key: "sess-1",
          prompt_cache_options: { mode: "implicit", ttl: "30m" },
        },
      },
      none: { headers: {}, body: {} },
      explicit: { gpt55: false, gpt56sol: true, gpt6: true },
      pin: {
        grok: "grok",
        chatgpt: "chatgpt",
        generic: "grok",
        grokHeaders: expect.objectContaining({ "x-grok-conv-id": "s", "x-grok-session-id": "s" }),
        grokTurnHeaders: expect.objectContaining({ "x-grok-req-id": "r1", "x-grok-turn-idx": "2" }),
        chatgptAffinity: {
          headers: { "session-id": "s", "thread-id": "s" },
          body: { prompt_cache_key: "s" },
        },
      },
      chatgptModels: {
        "gpt-5.4": { connection: chatgptExpected, flavor: chatgptExpected },
        "gpt-5.6-sol": { connection: chatgptExpected, flavor: chatgptExpected },
        "gpt-6-astra": { connection: chatgptExpected, flavor: chatgptExpected },
      },
      emptyKey: { headers: {}, body: {} },
      clamp: { length: 64, value: "😀".repeat(64) },
    });

    const firstCompat = await listenCompat({
      reply: () => ({
        content: "ok",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    });
    const firstConn = new Grokish("row-cache", { baseUrl: firstCompat.baseUrl, model: "grok-4.6" });
    const firstPlexus = SessionPlexus.create("sess-cache", "/ws");
    bindSessionCatalog(firstPlexus.root, new KernelToolCatalog());
    const first = new CompletionExpectation({
      promptText: prompt.user`hi`,
      connectionId: "row-cache",
      model: "grok-4.6",
    });
    try {
      await firstConn.ensureBootstrapStarted();
      firstPlexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [new CompletionJob({ expectation: first })],
        queue: [],
      });
      await drain(firstConn, first);
    } finally {
      firstPlexus.destroy();
      await firstConn[Symbol.asyncDispose]();
      await firstCompat.close();
    }

    let n = 0;
    const hitting = await listenCompat({
      reply: () => {
        n += 1;
        return {
          content: "ok",
          usage: {
            prompt_tokens: 20,
            completion_tokens: 4,
            total_tokens: 24,
            prompt_tokens_details: { cached_tokens: n === 1 ? 256 : 0 },
          },
        };
      },
    });
    const warm = new Grokish("row-warm", { baseUrl: hitting.baseUrl, model: "grok-4.6" });
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cache-inv-")));
    const warmPlexus = SessionPlexus.create("sess-warm", workspace);
    bindSessionCatalog(warmPlexus.root, new KernelToolCatalog());
    const prior = new CompletionExpectation({
      promptText: prompt.user`first`,
      connectionId: "row-warm",
      model: "grok-4.6",
    });
    prior.responseText = "a";
    prior.warmUntil = new Date(Date.now() + 60_000);
    const hit = new CompletionExpectation({
      promptText: prompt.user`second`,
      connectionId: "row-warm",
      model: "grok-4.6",
    });
    const miss = new CompletionExpectation({
      promptText: prompt.user`third`,
      connectionId: "row-warm",
      model: "grok-4.6",
    });
    try {
      await warm.ensureBootstrapStarted();
      warmPlexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`second`,
        doneWork: [
          new CompletionJob({ expectation: prior }),
          new CompletionJob({ expectation: hit }),
          new CompletionJob({ expectation: miss }),
        ],
        queue: [],
      });
      await drain(warm, hit);
      hit.warmUntil = new Date(Date.now() + 60_000);
      await drain(warm, miss);
    } finally {
      warmPlexus.destroy();
      await warm[Symbol.asyncDispose]();
      await hitting.close();
    }
    const dumpRoot = join(workspace, ".harness", "cache", "sess-warm");
    const dirs = existsSync(dumpRoot) ? readdirSync(dumpRoot) : [];

    const foldCompat = await listenCompat({
      reply: () => ({
        content: "ok",
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    });
    const foldConn = new Grokish("row-fold", { baseUrl: foldCompat.baseUrl, model: "grok-4.6" });
    const foldPlexus = SessionPlexus.create("sess-fold", "/ws");
    bindSessionCatalog(foldPlexus.root, new KernelToolCatalog());
    const snap = new CompletionExpectation({
      promptText: prompt.user`old`,
      connectionId: "row-fold",
      model: "grok-4.6",
    });
    snap.responseText = "snapshot";
    snap.warmUntil = new Date(Date.now() + 60_000);
    const compact = new CompactJob({ standIn: snap.responseText || "summary", completed: true });
    const tip = new CompletionExpectation({
      promptText: prompt.user`new`,
      connectionId: "row-fold",
      model: "grok-4.6",
    });
    try {
      await foldConn.ensureBootstrapStarted();
      foldPlexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`new`,
        doneWork: [new CompletionJob({ expectation: snap }), compact, new CompletionJob({ expectation: tip })],
        queue: [],
      });
      await drain(foldConn, tip);
    } finally {
      foldPlexus.destroy();
      await foldConn[Symbol.asyncDispose]();
      await foldCompat.close();
      rmSync(workspace, { recursive: true, force: true });
    }

    expect({
      first: {
        expectedCacheHit: first.expectedCacheHit,
        cacheHit: first.cacheHit,
        cachedTokens: first.cachedTokens,
        misaligned: first.cacheMisaligned(),
        report: first.report,
      },
      hit: {
        expectedCacheHit: hit.expectedCacheHit,
        cacheHit: hit.cacheHit,
        cachedTokens: hit.cachedTokens,
        misaligned: hit.cacheMisaligned(),
        report: hit.report,
      },
      miss: {
        expectedCacheHit: miss.expectedCacheHit,
        cacheHit: miss.cacheHit,
        cachedTokens: miss.cachedTokens,
        misaligned: miss.cacheMisaligned(),
        report: miss.report,
        dirs: dirs.filter((name) => name !== "index.jsonl").toSorted(),
      },
      cutoff: {
        expectedCacheHit: tip.expectedCacheHit,
        cacheHit: tip.cacheHit,
        misaligned: tip.cacheMisaligned(),
        report: tip.report,
      },
    }).toMatchObject({
      first: {
        expectedCacheHit: false,
        cacheHit: false,
        cachedTokens: 0,
        misaligned: false,
        report: { cacheHit: false, expectedCacheHit: false },
      },
      hit: {
        expectedCacheHit: true,
        cacheHit: true,
        cachedTokens: 256,
        misaligned: false,
        report: { cacheHit: true, expectedCacheHit: true },
      },
      miss: {
        expectedCacheHit: true,
        cacheHit: false,
        cachedTokens: 0,
        misaligned: true,
        report: { cacheHit: false, expectedCacheHit: true },
        dirs: expect.arrayContaining([
          expect.stringMatching(/aligned-hit$/u),
          expect.stringMatching(/unexpected-miss$/u),
        ]),
      },
      cutoff: {
        expectedCacheHit: false,
        cacheHit: null,
        misaligned: false,
        report: { cacheHit: null, expectedCacheHit: false },
      },
    });
  });
});
