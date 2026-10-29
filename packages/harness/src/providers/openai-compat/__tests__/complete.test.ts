import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import { describe, expect, it, vi } from "vitest";

import type { AccountSnapshot } from "../api-extensions/types.js";
import { OpenAiCompatDriverConnection } from "../index.js";
import { listenCompat } from "./compat-server.js";

function homeRound(plexus: SessionPlexus, round: CompletionExpectation): void {
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: round.promptText,
    doneWork: [new CompletionJob({ expectation: round })],
    queue: [],
  });
}

describe("openai-compat connection.complete: honor live (no double-start) and honor disposed", () => {
  it("handle then complete is idempotent (honor live)", async () => {
    const compat = await listenCompat({ reply: () => "from-wire" });
    const connection = new OpenAiCompatDriverConnection("row-ok", {
      baseUrl: compat.baseUrl,
    });
    const plexus = SessionPlexus.create("complete-honor-live", "/ws");
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-ok",
        model: "m1",
      });
      homeRound(plexus, round);
      connection.handle(round);
      const result = await connection.complete({
        model: "m1",
        promptText: "hi",
        round,
      });
      expect(result.text).toBe("from-wire");
      expect(round.outcome).toBe("successful");
      expect(compat.posts).toHaveLength(1);
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });

  it("complete starts the actor when honor is disposed", async () => {
    const compat = await listenCompat({ reply: () => "solo" });
    const connection = new OpenAiCompatDriverConnection("row-ok", {
      baseUrl: compat.baseUrl,
    });
    const plexus = SessionPlexus.create("complete-honor-disposed", "/ws");
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-ok",
        model: "m1",
      });
      homeRound(plexus, round);
      const result = await connection.complete({
        model: "m1",
        promptText: "hi",
        round,
      });
      expect(result.text).toBe("solo");
      expect(round.outcome).toBe("successful");
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });

  it("needs-auth and failed throw ConnectionMiss after the wait", async () => {
    const keyed = new OpenAiCompatDriverConnection("row", { baseUrl: "https://api.example.test/v1" }, { apiKey: "sk" });
    keyed.noteChallenge(401);
    const plexus = SessionPlexus.create("complete-miss", "/ws");
    const round = new CompletionExpectation({
      promptText: prompt.user`x`,
      connectionId: "row",
      model: "m1",
    });
    homeRound(plexus, round);
    await expect(keyed.complete({ model: "m1", round })).rejects.toMatchObject({
      name: "ConnectionMiss",
      code: "needs-auth",
    });
    const failed = new OpenAiCompatDriverConnection("dead", {
      baseUrl: "https://api.example.test/v1",
    });
    failed.noteFail(new Error("dead"));
    const deadRound = new CompletionExpectation({
      promptText: prompt.user`x`,
      connectionId: "dead",
      model: "m1",
    });
    homeRound(plexus, deadRound);
    await expect(failed.complete({ model: "m1", round: deadRound })).rejects.toBeInstanceOf(ConnectionMiss);
    plexus.destroy();
    await keyed[Symbol.asyncDispose]();
    await failed[Symbol.asyncDispose]();
  });

  it("an aborted wait ends the round instead of leaving it open", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compat = await listenCompat({ reply: () => "late", gate });
    const connection = new OpenAiCompatDriverConnection("row-ok", {
      baseUrl: compat.baseUrl,
    });
    const plexus = SessionPlexus.create("complete-abort", "/ws");
    const attempt = new AbortController();
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-ok",
        model: "m1",
      });
      homeRound(plexus, round);
      const pending = connection.complete({
        model: "m1",
        promptText: "hi",
        round,
        signal: attempt.signal,
      });
      const hung = pending.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      attempt.abort(new Error("classifier timed out"));
      await expect(hung).resolves.toBe("classifier timed out");
      expect(round.outcome).toBe("failed");
      expect(round.isDone).toBe(true);
    } finally {
      release();
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });

  it("complete refreshes quota after the round settles", async () => {
    const compat = await listenCompat({ reply: () => "ok" });
    const connection = new OpenAiCompatDriverConnection("row-ok", {
      baseUrl: compat.baseUrl,
    });
    const plexus = SessionPlexus.create("complete-quota", "/ws");
    try {
      await connection.ensureBootstrapStarted();
      const loads: number[] = [];
      const proto = OpenAiCompatDriverConnection.prototype as unknown as {
        accountPolls(): boolean;
        loadAccount(): Promise<AccountSnapshot | undefined>;
      };
      const polls = vi.spyOn(proto, "accountPolls").mockReturnValue(true);
      const load = vi.spyOn(proto, "loadAccount").mockImplementation(async () => {
        loads.push(40);
        return {
          identityDetail: { kind: "subscription" },
          balanceDetail: {
            windows: [{ label: "5h", remainingPercent: 40, status: "ok" }],
          },
        } as AccountSnapshot;
      });
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-ok",
        model: "m1",
      });
      homeRound(plexus, round);
      const result = await connection.complete({
        model: "m1",
        promptText: "hi",
        round,
      });
      await vi.waitFor(() => expect(loads.length).toBe(1));
      expect({
        text: result.text,
        remaining: connection.state.account?.balanceDetail?.windows?.[0]?.remainingPercent,
        loads: loads.length,
      }).toEqual({
        text: "ok",
        remaining: 40,
        loads: 1,
      });
      polls.mockRestore();
      load.mockRestore();
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  });
});
