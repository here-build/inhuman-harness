/**
 * Kernel seat machine: remember/retract, park on last seat drop,
 * title/recency from turn/steer only, worker lens, production Client seat.
 */
import { rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  AskAgentSpec,
  ProgrammaticJob,
  publishKernelSeat,
  sessionIsOccupied,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { sessionMintKvs } from "@inhuman.tools/harness-model/shared";
import { Client } from "@inhuman.tools/harness-sdk";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { documentKey } from "@/protocol/document";

import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { HarnessDaemon } from "../../server/HarnessDaemon.js";
import { KernelDaemon } from "../KernelDaemon.js";

const TIMEOUT = 8_000;

describe("kernel seat machine", () => {
  beforeEach(() => resetLocalIDs());

  it("remembers, parks on seat drop, titles from turn/steer, worker lens", { timeout: 30_000 }, async () => {
    const system = await realpath(await mkdtemp(join(tmpdir(), "harness-seat-k-")));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "harness-seat-p-")));
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    let restored: KernelDaemon | null = null;
    let firstGone = false;
    onTestFinished(() => {
      restored?.[Symbol.dispose]();
      if (!firstGone) kernel[Symbol.dispose]();
    });

    const globalHost = kernel.project(system);
    expect({
      selfListed: kernel.plexus.root.projects[system],
      global: globalHost.globalHost,
      same: kernel.project(system) === globalHost,
    }).toEqual({ selfListed: undefined, global: true, same: true });

    const conversation = await project.session("conversation");
    const worker = await project.session("worker");
    worker.root.agent.spec.recipeScope = "project";
    kernel.internSession("worker", worker.plexus, worker);
    expect({
      project: kernel.plexus.root.projects[project.path],
      conversation: project.root.sessions.conversation,
      worker: project.root.sessions.worker,
      conversationGlance: kernel.plexus.root.sessions.conversation != null,
      workerGlance: kernel.plexus.root.sessions.worker != null,
      workerScope: kernel.plexus.root.sessions.worker?.recipeScope ?? null,
      conversationTitle: kernel.plexus.root.sessions.conversation?.title ?? null,
      conversationId: conversation.sessionId,
    }).toEqual({
      project: "",
      conversation: "",
      worker: undefined,
      conversationGlance: true,
      workerGlance: true,
      workerScope: "project",
      conversationTitle: "",
      conversationId: "conversation",
    });

    const created = kernel.plexus.root.sessions.conversation;
    expect({
      title: created?.title,
      stamped: (created?.lastMessageAt ?? 0) > 0,
      mint: sessionMintKvs(kernel.plexus.root.kvs, project.root.kvs)
        .map((row) => row.key)
        .includes("conversation"),
      kv: kernel.plexus.root.kvs.conversation,
    }).toEqual({ title: "", stamped: true, mint: false, kv: undefined });

    created!.lastMessageAt = 1;
    kernel.internSession("conversation", conversation.plexus, conversation);
    expect({ recency: kernel.plexus.root.sessions.conversation?.lastMessageAt }).toEqual({ recency: 1 });

    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello there`, queue: [] });
    turn.reducerExited = true;
    conversation.root.head = turn;
    expect({
      title: kernel.plexus.root.sessions.conversation?.title,
      lastPrompt: kernel.plexus.root.sessions.conversation?.lastPrompt,
      recency: (kernel.plexus.root.sessions.conversation?.lastMessageAt ?? 0) > 1,
    }).toEqual({ title: "hello there", lastPrompt: "hello there", recency: true });

    const sitting = new SystemToolJob({
      toolCallId: "ask-sh",
      name: "shell",
      policyResult: "ask",
    });
    turn.pushChild(sitting);
    // The head is closed, so its leftover ask is not the session's ask.
    expect({
      unfinished: kernel.plexus.root.sessions.conversation?.unfinished,
      askLine: kernel.plexus.root.sessions.conversation?.askLine,
    }).toEqual({ unfinished: "tools", askLine: "" });
    sitting.humanApprove = true;
    sitting.completed = true;
    expect({
      unfinished: kernel.plexus.root.sessions.conversation?.unfinished,
      askLine: kernel.plexus.root.sessions.conversation?.askLine,
    }).toEqual({ unfinished: "", askLine: "" });

    const tTurn = kernel.plexus.root.sessions.conversation!.lastMessageAt ?? 0;
    await conversation.handleRequest("rename", { title: "Auth refactor" });
    expect({
      title: kernel.plexus.root.sessions.conversation?.title,
      recency: kernel.plexus.root.sessions.conversation?.lastMessageAt,
    }).toEqual({ title: "Auth refactor", recency: tTurn });

    await conversation.handleRequest("rename", { title: "" });
    expect({
      title: kernel.plexus.root.sessions.conversation?.title,
      recency: kernel.plexus.root.sessions.conversation?.lastMessageAt,
    }).toEqual({ title: "hello there", recency: tTurn });

    turn.doneWork.push(
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        toolCallId: "m1",
        name: "update_metadata",
        argsJson: JSON.stringify({ current_turn_title: "Fix login" }),
      }),
    );
    expect({
      title: kernel.plexus.root.sessions.conversation?.title,
      recency: kernel.plexus.root.sessions.conversation?.lastMessageAt,
    }).toEqual({ title: "Fix login", recency: tTurn });

    admitSteer(conversation.root, prompt.user`more`, turn.uuid);
    expect({ recency: (kernel.plexus.root.sessions.conversation!.lastMessageAt ?? 0) > tTurn }).toEqual({
      recency: true,
    });

    worker.root.agent.spec.name = "reviewer";
    worker.root.agent.spec.recipeScope = "session";
    worker.root.agent.spec.keepAlive = true;
    worker.root.agent.spec.resident = false;
    worker.root.applyKvs([{ form: "kv-set", key: "model", value: "haiku" }]);
    worker.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`check`, queue: [] });
    const glance = kernel.plexus.root.sessions.worker;
    expect({
      specName: glance?.specName,
      scope: glance?.recipeScope,
      resident: glance?.resident,
      keepAlive: glance?.keepAlive,
      model: glance?.model,
      midMotion: glance?.midMotion,
      openTurn: glance?.openTurn,
      openToolCount: glance?.openToolCount,
      unfinished: glance?.unfinished,
      oneShot: glance?.oneShot,
      conversation: project.root.sessions.worker,
    }).toEqual({
      specName: "reviewer",
      scope: "session",
      resident: false,
      keepAlive: true,
      model: "haiku",
      midMotion: true,
      openTurn: true,
      openToolCount: 0,
      unfinished: "turn",
      oneShot: false,
      conversation: undefined,
    });

    const recency = glance!.lastMessageAt;
    worker.root.head!.reducerExited = true;
    expect({
      midMotion: kernel.plexus.root.sessions.worker?.midMotion,
      openTurn: kernel.plexus.root.sessions.worker?.openTurn,
      recency: kernel.plexus.root.sessions.worker?.lastMessageAt,
    }).toEqual({ midMotion: false, openTurn: false, recency });

    const leftover = new SystemToolJob({ toolCallId: "t-open", name: "read_file" });
    worker.root.head!.pushChild(leftover);
    expect({
      midMotion: kernel.plexus.root.sessions.worker?.midMotion,
      openTurn: kernel.plexus.root.sessions.worker?.openTurn,
      openToolCount: kernel.plexus.root.sessions.worker?.openToolCount,
      unfinished: kernel.plexus.root.sessions.worker?.unfinished,
      recency: kernel.plexus.root.sessions.worker?.lastMessageAt,
    }).toEqual({ midMotion: true, openTurn: false, openToolCount: 1, unfinished: "tools", recency });
    leftover.completed = true;
    expect({
      midMotion: kernel.plexus.root.sessions.worker?.midMotion,
      openToolCount: kernel.plexus.root.sessions.worker?.openToolCount,
    }).toEqual({ midMotion: false, openToolCount: 0 });

    const watch = new ProgrammaticJob({
      toolName: "scheme_watch",
      periodWaitUntilMs: Date.now() + 60_000,
    });
    worker.root.head!.pushChild(watch);
    expect({ periodArmed: kernel.plexus.root.sessions.worker?.periodArmed }).toEqual({ periodArmed: true });
    watch.completed = true;
    expect({ periodArmed: kernel.plexus.root.sessions.worker?.periodArmed }).toEqual({ periodArmed: false });

    worker.root.agent.spec.resident = true;
    expect({ resident: kernel.plexus.root.sessions.worker?.resident }).toEqual({ resident: true });

    const ask = await project.session("ask-1");
    ask.root.agent.spec = new AskAgentSpec({ name: "explore" });
    kernel.internSession("ask-1", ask.plexus, ask);
    expect({
      oneShot: kernel.plexus.root.sessions["ask-1"]?.oneShot,
      specName: kernel.plexus.root.sessions["ask-1"]?.specName,
      conversation: project.root.sessions["ask-1"],
    }).toEqual({ oneShot: true, specName: "explore", conversation: undefined });

    const seated = await project.session("seated");
    await project.session("idle");
    const hub = kernel.plexus.awareness;
    expect({
      seated: kernel.liveSession("seated") != null,
      idle: kernel.liveSession("idle") != null,
      resident: kernel.plexus.root.sessions.seated?.resident,
    }).toEqual({ seated: true, idle: true, resident: false });

    publishKernelSeat(hub, "seated");
    await when(() => sessionIsOccupied(hub, "seated"), { timeout: TIMEOUT });
    publishKernelSeat(hub, null);
    await when(() => kernel.liveSession("seated") == null, { timeout: TIMEOUT });
    expect({ parked: kernel.liveSession("seated") == null, idle: kernel.liveSession("idle") != null }).toEqual({
      parked: true,
      idle: true,
    });

    seated.root.agent.spec.resident = true;
    await when(() => kernel.plexus.root.sessions.seated?.resident === true, { timeout: TIMEOUT });
    const woken = await kernel.attachSession("seated");
    expect({ woken: woken != null && kernel.liveSession("seated") === woken }).toEqual({ woken: true });

    project[Symbol.dispose]();
    expect({
      project: kernel.plexus.root.projects[project.path],
      conversationGlance: kernel.plexus.root.sessions.conversation != null,
    }).toEqual({ project: "", conversationGlance: true });

    const documents = kernel.runtime.documents!;
    const kernelKey = documentKey("kernel", "kernel");
    const flushed = await documents.flush(kernelKey, documents.checkpoint(kernelKey)!);
    expect(flushed.ok).toBe(true);
    kernel[Symbol.dispose]();
    firstGone = true;
    restored = new KernelDaemon(system);
    await restored.ready;
    expect({
      seated: restored.liveSession("seated") != null,
      idleGone: restored.liveSession("idle") == null,
      resident: restored.plexus.root.sessions.seated?.resident,
    }).toEqual({ seated: true, idleGone: true, resident: true });

    const clientKernel = await realpath(await mkdtemp(join(tmpdir(), "harness-seat-client-k-")));
    const clientWorkspace = await realpath(await mkdtemp(join(tmpdir(), "harness-seat-client-p-")));
    onTestFinished(() => {
      rmSync(clientKernel, { recursive: true, force: true });
      rmSync(clientWorkspace, { recursive: true, force: true });
    });
    await using harness = new HarnessDaemon(clientKernel);
    await harness.listen();
    const started = await Client.start(clientKernel, clientWorkspace);
    try {
      await using watcher = await Client.kernel(clientKernel);
      await when(() => sessionIsOccupied(watcher.plexus.awareness, started.sessionId), { timeout: TIMEOUT });
      await started[Symbol.asyncDispose]();
      await when(() => !sessionIsOccupied(watcher.plexus.awareness, started.sessionId), { timeout: TIMEOUT });
    } finally {
      await started[Symbol.asyncDispose]().catch(() => undefined);
    }
  });
});
