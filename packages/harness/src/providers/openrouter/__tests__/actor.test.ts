import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { OpenRouterDriverConnection } from "../connection.js";
import { listenCompat } from "./compat-server.js";

function homeRound(plexus: SessionPlexus, round: CompletionExpectation): void {
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: round.promptText,
    doneWork: [new CompletionJob({ expectation: round })],
    queue: [],
  });
}

describe("OpenRouter actor", () => {
  it("pins openrouter cache/reasoning and stamps session affinity", async () => {
    const pinned = new OpenRouterDriverConnection("pin", {
      baseUrl: "http://127.0.0.1:9/v1",
    });
    expect(pinned.cacheFlavor()).toBe("openrouter");
    expect(pinned.cacheAffinity("sess-or", "m1")).toEqual({
      headers: { "x-session-id": "sess-or" },
      body: { prompt_cache_key: "sess-or", session_id: "sess-or" },
    });
    expect(pinned.cacheAffinity("  ", "m1")).toEqual({ headers: {}, body: {} });
    expect(pinned.cacheAffinity("x".repeat(300), "m1").headers["x-session-id"]).toHaveLength(256);
    await pinned[Symbol.asyncDispose]();

    const compat = await listenCompat({
      reply: () => ({
        content: "from-openrouter",
        usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0014 },
      }),
    });
    const connection = new OpenRouterDriverConnection("row-or", {
      baseUrl: compat.baseUrl,
      model: "m1",
    });
    const plexus = SessionPlexus.create("sess-or", "/ws");
    try {
      expect(connection.cacheFlavor()).toBe("openrouter");
      expect(connection.reasoningFlavor()).toBe("openrouter");
      expect(OpenRouterDriverConnection.configurationLabel).toBe("openrouter");
      expect(OpenRouterDriverConnection.offers[0]?.settings).toEqual({
        baseUrl: "https://openrouter.ai/api/v1",
      });
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-or",
        model: "m1",
      });
      homeRound(plexus, round);
      const result = await connection.complete({
        model: "m1",
        promptText: "hi",
        round,
      });
      expect(result.text).toBe("from-openrouter");
      expect(round.outcome).toBe("successful");
      expect(round.costUsd).toBe(0.0014);
      expect(compat.requestHeaders[0]?.["x-session-id"]).toBe("sess-or");
      const post = compat.posts[0] as {
        prompt_cache_key?: string;
        session_id?: string;
        reasoning?: unknown;
      };
      expect(post.prompt_cache_key).toBe("sess-or");
      expect(post.session_id).toBe("sess-or");
      expect(post.reasoning).toEqual({ exclude: false });
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });
});
