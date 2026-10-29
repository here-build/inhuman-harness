/**
 * Conversation rewind is a head write. Mint ends the episode. Redo walks
 * loadEntity, not liveTurns. Continue off-tip does not mint.
 */
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  tapeCompletion,
  findTurnById,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { documentKey } from "@/protocol/document";
import { documentImagePath } from "@/yjs/storage";

import { RpcInvalidParams } from "../../../contract.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-rewind-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-rewind-p-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: "c1" });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return session;
}

function closed(tail: SessionSystemPrompt | SessionTurn, promptText: string): SessionTurn {
  return new SessionTurn({ turnTail: tail, prompt: prompt.user`${promptText}`, queue: [], reducerExited: true });
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof RpcInvalidParams ? error.message : String(error);
  }
}

describe("turn/rewind", () => {
  beforeEach(() => resetLocalIDs());

  it("mint pairs tip; rewind/redo; refuse off-chain and continue; send ends the episode", async () => {
    const session = await openSession();
    const noHead = await refused(session.handleRequest("turn/rewind", { turnId: "missing" }));

    const one = closed(new SessionSystemPrompt(), "one");
    const blank = closed(one, "");
    const two = closed(blank, "two");
    session.root.head = two;
    session.root.tip = two;

    const back = await session.handleRequest("turn/rewind", { turnId: one.uuid });
    const afterBack = {
      result: back,
      head: session.root.head?.prompt,
      tip: session.root.tip?.prompt,
      liveHasTwo: findTurnById(session.root, two.uuid) != null,
      loadedTwo: session.plexus.loadEntity(two.uuid) instanceof SessionTurn,
    };

    const redo = await session.handleRequest("turn/rewind", { turnId: two.uuid });
    const afterRedo = {
      result: redo,
      head: session.root.head?.prompt,
      tip: session.root.tip?.prompt,
    };

    await session.handleRequest("turn/rewind", { turnId: one.uuid });
    const missingId = one.uuid.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
    const blankRefuse = await refused(session.handleRequest("turn/rewind", { turnId: blank.uuid }));
    const unknownRefuse = await refused(session.handleRequest("turn/rewind", { turnId: missingId }));
    const continueRefuse = await refused(session.handleRequest("turn", { prompt: "", kind: "continue" }));
    const stuck = { head: session.root.head?.prompt, tip: session.root.tip?.prompt };

    const run = new SessionTurn({ turnTail: two, prompt: prompt.user`live` });
    session.root.head = run;
    session.root.tip = run;
    await when(() => run.work.some((chunk) => tapeCompletion(chunk)?.outcome == null), { timeout: 2_000 });
    admitQueue(session.root, prompt.user`later`, run.uuid);
    admitQueue(session.root, prompt.user`also`, run.uuid);
    await session.handleRequest("turn/rewind", { turnId: one.uuid });
    const afterCancel = {
      head: session.root.head?.prompt,
      tip: session.root.tip?.prompt,
      cancelled: run.cancelRequested,
      queue: session.root.promptQueue.map((row) => row.text),
    };

    await session.handleRequest("turn", { prompt: "three" });
    const afterSend = {
      paired: session.root.head?.uuid === session.root.tip?.uuid,
      prompt: session.root.head?.prompt,
      twoOffChain: await refused(session.handleRequest("turn/rewind", { turnId: two.uuid })),
    };

    const sessionsDir = join(session.kernel.root, "documents", "sessions");
    const image = documentImagePath(session.kernel.root, documentKey("sessions", session.sessionId));
    await chmod(sessionsDir, 0o555);
    await chmod(image, 0o444);
    onTestFinished(async () => {
      await chmod(image, 0o600);
      await chmod(sessionsDir, 0o755);
    });
    await session.handleRequest("turn/rewind", { turnId: one.uuid });
    const beforeEval = { head: session.root.head?.prompt, tip: session.root.tip?.prompt };
    const persist = await refused(
      session.handleRequest("eval", { requestId: "req-rewind", expr: "(+ 1 2)", policy: "auto" }),
    );
    const afterEval = { head: session.root.head?.prompt, tip: session.root.tip?.prompt };

    expect({
      noHead,
      afterBack,
      afterRedo,
      refuses: { blankRefuse, unknownRefuse, continueRefuse, stuck },
      afterCancel,
      afterSend,
      abandon: { persist, beforeEval, afterEval },
    }).toEqual({
      noHead: "no-head",
      afterBack: {
        result: { ok: true, turnId: one.uuid },
        head: "one",
        tip: "two",
        liveHasTwo: false,
        loadedTwo: true,
      },
      afterRedo: {
        result: { ok: true, turnId: two.uuid },
        head: "two",
        tip: "two",
      },
      refuses: {
        blankRefuse: "not-a-pin",
        unknownRefuse: "unknown-id",
        continueRefuse: "off-tip",
        stuck: { head: "one", tip: "two" },
      },
      afterCancel: {
        head: "one",
        tip: "live",
        cancelled: true,
        queue: [],
      },
      afterSend: {
        paired: true,
        prompt: "three",
        twoOffChain: "off-chain",
      },
      abandon: {
        persist: "eval admission could not be persisted",
        beforeEval: { head: "one", tip: "three" },
        afterEval: { head: "one", tip: "three" },
      },
    });
  });
});

it("restores the retained tip even when its last turn has no prompt", async () => {
  const session = await openSession();
  const one = closed(new SessionSystemPrompt(), "one");
  const tip = closed(one, "");
  session.root.head = tip;
  session.root.tip = tip;
  await session.handleRequest("turn/rewind", { turnId: one.uuid });
  await session.handleRequest("turn/rewind", { turnId: tip.uuid });
  expect(session.root.head).toBe(tip);
  expect(session.root.tip).toBe(tip);
});
