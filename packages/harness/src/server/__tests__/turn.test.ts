import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reactChunks, SessionTurn, tapeCompletion } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { OpenAiCompatActor } from "@/providers/openai-compat";

import { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";
import { listenCompat } from "../testkit/compat-server.js";
import { installScriptedModel, scriptedConnectionId, type ModelScript } from "../testkit/scripted-model.js";
import { sequenceReply } from "../testkit/sequence-provider.js";

const REPLICA_MS = 5_000;

describe("turn", () => {
  it("turn door TABLE: no connection, empty prompt, busy admit, compact while running, continue on closed head is a no-op", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-turn-door-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-turn-door-p-")));
    try {
      await using daemon = new HarnessDaemon(kernel);
      await daemon.listen();
      await using client = await Client.start(kernel, workspace);

      const noConnection = await rejected(client.request("turn", { prompt: "hello" }));
      const emptyPrompt = await client.request("turn", { prompt: "   " });
      const emptyContinue = await client.request("turn", { prompt: "", kind: "continue" });
      const retryIdle = await client.request("turn/retry", {});
      const idle = {
        noConnection,
        emptyPrompt,
        emptyContinue,
        retryIdle,
        head: client.sessionRoot.head,
      };

      const model = installScriptedModel(await daemon.kernel());
      await client.request("kv/set", { key: "connection", value: scriptedConnectionId() });
      await client.request("kv/set", { key: "model", value: "m1" });
      await expect(client.request("turn", { prompt: "hello" })).resolves.toEqual({ ok: true });
      await when(() => client.sessionRoot.head instanceof SessionTurn && client.sessionRoot.head.prompt === "hello", {
        timeout: REPLICA_MS,
      });
      const runningUuid = client.sessionRoot.head instanceof SessionTurn ? client.sessionRoot.head.uuid : "";

      const secondMint = await client.request("turn", { prompt: "again" });
      const queued = await client.request("turn", { prompt: "later", kind: "queue" });
      const continueWhileRunning = await client.request("turn", { prompt: "", kind: "continue" });
      const compactWhileRunning = await rejected(client.request("compact", { focus: "keep" }));
      await when(() => client.sessionRoot.steerQueue.length === 1 && client.sessionRoot.promptQueue.length === 1, {
        timeout: REPLICA_MS,
      });
      const head = client.sessionRoot.head;
      const busy = {
        secondMint,
        queued,
        continueWhileRunning,
        compactWhileRunning,
        prompt: head instanceof SessionTurn ? head.prompt : "",
        uuid: head instanceof SessionTurn ? head.uuid : "",
        steer: client.sessionRoot.steerQueue.map((row) => row.text),
        queue: client.sessionRoot.promptQueue.map((row) => row.text),
      };

      // The first round stays unanswered through the busy snapshot. Later replies
      // let steer and the prompt queue finish.
      await answerUntil(
        model,
        () =>
          client.sessionRoot.head instanceof SessionTurn &&
          client.sessionRoot.head.reducerExited &&
          client.sessionRoot.steerQueue.length === 0 &&
          client.sessionRoot.promptQueue.length === 0,
      );
      const closedUuid = client.sessionRoot.head instanceof SessionTurn ? client.sessionRoot.head.uuid : "";
      const continued = await client.request("turn", { prompt: "", kind: "continue" });
      const closedContinue = {
        continued,
        uuid: client.sessionRoot.head instanceof SessionTurn ? client.sessionRoot.head.uuid : "",
        closedUuid,
      };

      expect({ idle, busy, closedContinue }).toEqual({
        idle: {
          noConnection: { ok: false, message: expect.stringMatching(/connection is required/) },
          emptyPrompt: { ok: true },
          emptyContinue: { ok: true },
          retryIdle: { ok: true },
          head: null,
        },
        busy: {
          secondMint: { ok: true },
          queued: { ok: true },
          continueWhileRunning: { ok: true },
          compactWhileRunning: { ok: false, message: expect.stringMatching(/already running/) },
          prompt: "hello",
          uuid: runningUuid,
          steer: ["again"],
          queue: ["later"],
        },
        closedContinue: {
          continued: { ok: true },
          uuid: closedUuid,
          closedUuid,
        },
      });
    } finally {
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it("turn/retry skips openai-compat backoff after a 500", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-turn-retry-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-turn-retry-p-")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const compat = await listenCompat({
      reply: (post) => {
        n += 1;
        if (n === 1) throw new Error("down");
        return sequenceReply(post);
      },
      gate,
    });
    try {
      await using daemon = new HarnessDaemon(kernel);
      await daemon.listen();
      await using client = await Client.start(kernel, workspace);
      await client.request("connect/adopt", {
        driver: "openai-compat",
        name: "Work",
        settings: { baseUrl: compat.baseUrl },
      });
      await client.request("kv/set", { key: "model", value: "m1" });
      await expect(client.request("turn", { prompt: "hello" })).resolves.toEqual({ ok: true });

      const project = await daemon.project(workspace);
      const session = project.sessions[client.sessionId];
      if (session === undefined) throw new Error("missing session");
      await expect
        .poll(
          () => {
            const turn = session.root.findRunningTurn();
            if (turn == null) return false;
            for (const chunk of reactChunks(turn)) {
              const pew = tapeCompletion(chunk);
              if (pew == null || pew.outcome != null) continue;
              const actor = session.orchestrator.actorOf(pew);
              if (actor instanceof OpenAiCompatActor) {
                actor.backoffMs = () => 60_000;
                return true;
              }
            }
            return false;
          },
          { timeout: REPLICA_MS },
        )
        .toBe(true);
      release();
      await expect.poll(() => compat.posts.length, { timeout: REPLICA_MS }).toBe(1);
      await expect
        .poll(
          () => {
            const turn = session.root.findRunningTurn();
            if (turn == null) return false;
            return reactChunks(turn).some((chunk) => {
              const pew = tapeCompletion(chunk);
              if (pew == null || pew.outcome != null) return false;
              return typeof (pew.report as { retryUntilMs?: number } | null)?.retryUntilMs === "number";
            });
          },
          { timeout: REPLICA_MS },
        )
        .toBe(true);
      await expect(client.request("turn/retry", {})).resolves.toEqual({ ok: true });
      await expect.poll(() => compat.posts.length, { timeout: REPLICA_MS }).toBe(2);
    } finally {
      release();
      await compat.close();
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Deliver text rounds until `done`. A reply queued before the next `complete` is the next round. */
async function answerUntil(model: ModelScript, done: () => boolean): Promise<void> {
  let stop = false;
  const pumping = (async () => {
    while (!stop) {
      model.reply({ text: "ok" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  try {
    await when(done, { timeout: 15_000 });
  } finally {
    stop = true;
  }
  await pumping;
}

async function rejected(
  promise: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
