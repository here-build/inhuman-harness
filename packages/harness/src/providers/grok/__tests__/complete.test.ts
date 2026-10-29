import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GROK_CLIENT_VERSION, GrokDriverConnection } from "../index.js";
import { installGrokFetch, listenGrok } from "./grok-server.js";

function homeRound(plexus: SessionPlexus, round: CompletionExpectation): void {
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: round.promptText,
    doneWork: [new CompletionJob({ expectation: round })],
    queue: [],
  });
}

describe("Grok completion on scripted HTTP", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installGrokFetch();
  });
  afterEach(() => {
    restore();
  });

  it("stamps subscription headers and returns the wire text", async () => {
    const grok = await listenGrok({ reply: () => "from-grok" });
    const connection = new GrokDriverConnection("row-grok", { baseUrl: grok.baseUrl }, { apiKey: "grok-at" });
    const plexus = SessionPlexus.create("grok-complete", "/ws");
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-grok",
        model: "grok-4",
      });
      homeRound(plexus, round);
      const result = await connection.complete({
        model: "grok-4",
        promptText: "hi",
        round,
      });
      expect(result.text).toBe("from-grok");
      expect(round.outcome).toBe("successful");
      expect(grok.posts).toHaveLength(1);
      expect(grok.requestHeaders[0]).toMatchObject({
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-client-identifier": "grok-shell",
        "x-grok-model-override": "grok-4",
        "user-agent": `xai-grok-cli/${GROK_CLIENT_VERSION}`,
        authorization: "Bearer grok-at",
      });
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await grok.close();
    }
  });

  it("pins grok cache flavor and conv-id affinity", () => {
    const connection = new GrokDriverConnection("row-grok", {
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
    });
    expect(connection.cacheFlavor()).toBe("grok");
    expect(
      connection.cacheAffinity("sess-1", "grok-4", {
        requestId: "req-9",
        turnIndex: 3,
      }),
    ).toEqual({
      headers: {
        "x-grok-conv-id": "sess-1",
        "x-grok-session-id": "sess-1",
        "x-grok-req-id": "req-9",
        "x-grok-turn-idx": "3",
        "x-grok-model-override": "grok-4",
      },
      body: { prompt_cache_key: "sess-1" },
    });
    expect(connection.cacheAffinity("  ", "grok-4").headers).toEqual({
      "x-grok-model-override": "grok-4",
    });
    void connection[Symbol.asyncDispose]();
  });
});
