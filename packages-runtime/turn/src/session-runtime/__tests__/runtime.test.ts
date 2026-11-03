import "@inhuman.tools/harness-model/session/register";
import { RegisteredToolsSet, SessionTurn } from "@inhuman.tools/harness-model/session";
import { onTestFinished, describe, expect, it } from "vitest";

import type { SessionCommandHost } from "../../session/types.js";
import {
  SessionRuntime,
  SessionOwnershipError,
  SessionPersistenceError,
  type SessionCheckpoint,
  type SessionReceipt,
} from "../index.js";

function commands(runtime: SessionRuntime): SessionCommandHost {
  return {
    session: runtime.root,
    constitution: "Test the actual session runtime.",
    env: () => ({}),
    toolsFor: () => new RegisteredToolsSet(),
    queuedVerbs: () => new Set(),
    cancelOwned: (turn) => {
      turn.cancelRequested = true;
    },
  };
}

function stored() {
  let bytes = new Uint8Array();
  let next: "ok" | "before-commit" | "lost-ack" = "ok";
  return {
    bytes: () => bytes,
    fail: (kind: "before-commit" | "lost-ack") => {
      next = kind;
    },
    durability: {
      kind: "durable" as const,
      async commit(checkpoint: SessionCheckpoint): Promise<SessionReceipt> {
        const failure = next;
        next = "ok";
        if (failure === "before-commit") throw new Error("storage refused commit");
        bytes = new Uint8Array(checkpoint.state);
        if (failure === "lost-ack") throw new Error("storage acknowledgement lost");
        return { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision };
      },
    },
  };
}

function open(store = stored()): SessionRuntime {
  const runtime = SessionRuntime.create("conversation", store.durability);
  runtime.root.kvs.connection = "model";
  runtime.recover();
  runtime.activate();
  onTestFinished(async () => {
    await runtime[Symbol.asyncDispose]();
    runtime.session.destroy();
  });
  return runtime;
}

describe("portable session lifecycle and durable effects", () => {
  it("retains binding authority for parked drains and revokes it on disposal", async () => {
    const runtime = open();
    runtime.park();
    expect({
      current: runtime.isCurrent,
      execution: runtime.signal.aborted,
      ownership: runtime.ownershipSignal.aborted,
    }).toEqual({
      current: true,
      execution: true,
      ownership: false,
    });
    await runtime[Symbol.asyncDispose]();
    expect({ current: runtime.isCurrent, ownership: runtime.ownershipSignal.aborted }).toEqual({
      current: false,
      ownership: true,
    });
  });

  it("durably interrupts an abandoned turn and reconciles a lost acknowledgement before another admission", async () => {
    const store = stored();
    const runtime = open(store);
    await runtime.admit(commands(runtime), { prompt: "abandoned" });
    store.fail("lost-ack");
    await expect(runtime.interrupt("stop-abandoned", "storage recovered; execution interrupted")).rejects.toThrow(
      "lost",
    );
    expect({ exited: runtime.root.head?.reducerExited, held: runtime.admissionHeld }).toEqual({
      exited: true,
      held: true,
    });
    await runtime.interrupt("stop-abandoned", "storage recovered; execution interrupted");
    await runtime.admit(commands(runtime), { prompt: "next request" });
    await runtime.interrupt("stop-abandoned", "storage recovered; execution interrupted");
    expect({ prompt: runtime.root.head?.prompt, exited: runtime.root.head?.reducerExited }).toEqual({
      prompt: "next request",
      exited: false,
    });
  });

  it("refuses a cancelled effect result waiting behind another durable command", async () => {
    const runtime = open();
    const enteredEffect = Promise.withResolvers<void>();
    const result = Promise.withResolvers<{ kind: "success"; payload: string }>();
    const enteredCommit = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let commits = 0;
    const isolated = new SessionRuntime(runtime.session, {
      kind: "durable",
      async commit(checkpoint) {
        if (++commits === 2) {
          enteredCommit.resolve();
          await releaseCommit.promise;
        }
        return { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision };
      },
    });
    onTestFinished(async () => {
      await isolated[Symbol.asyncDispose]();
    });
    isolated.recover();
    isolated.activate();
    const controller = new AbortController();
    const effect = isolated.effect(
      "cancel-queued",
      "write",
      "{}",
      {
        invoke() {
          enteredEffect.resolve();
          return result.promise;
        },
      },
      () => {
        isolated.root.kvs.cancelledResult = "applied";
      },
      controller.signal,
    );
    await enteredEffect.promise;
    const hold = isolated.commitMutation("hold", "{}", () => {
      isolated.root.kvs.hold = "committed";
    });
    await enteredCommit.promise;
    result.resolve({ kind: "success", payload: "too late" });
    await Promise.resolve();
    controller.abort(new Error("operation cancelled"));
    releaseCommit.resolve();
    await hold;
    await expect(effect).rejects.toThrow("operation cancelled");
    expect({ value: isolated.root.kvs.cancelledResult, phase: isolated.phase, held: isolated.admissionHeld }).toEqual({
      value: undefined,
      phase: "active",
      held: false,
    });
  });

  it("covers changes made while a prior checkpoint acknowledgement is pending", async () => {
    const runtime = open();
    const first = Promise.withResolvers<void>();
    const enteredFirst = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const enteredSecond = Promise.withResolvers<void>();
    let commits = 0;
    let saved = new Uint8Array();
    const isolated = new SessionRuntime(runtime.session, {
      kind: "durable",
      async commit(checkpoint) {
        commits += 1;
        if (commits === 1) {
          enteredFirst.resolve();
          await first.promise;
        }
        if (commits === 2) {
          enteredSecond.resolve();
          await second.promise;
        }
        saved = new Uint8Array(checkpoint.state);
        return { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision };
      },
    });
    onTestFinished(async () => {
      await isolated[Symbol.asyncDispose]();
    });
    isolated.recover();
    isolated.activate();
    const pending = isolated.admit(commands(isolated), { prompt: "before checkpoint" });
    await enteredFirst.promise;
    isolated.root.kvs.resourceSnapshot = "captured module bytes";
    first.resolve();
    await enteredSecond.promise;
    expect(isolated.admissionHeld).toBe(true);
    second.resolve();
    await pending;
    const restored = SessionRuntime.restore("conversation", saved, { kind: "memory" });
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    expect({ snapshot: restored.root.kvs.resourceSnapshot, held: isolated.admissionHeld, commits }).toEqual({
      snapshot: "captured module bytes",
      held: false,
      commits: 2,
    });
  });

  it("parks a partially admitted turn when a host callback fails", async () => {
    const runtime = open();
    await expect(
      runtime.admit(
        {
          ...commands(runtime),
          applyBotNotice() {
            throw new Error("host callback failed");
          },
        },
        { prompt: "partly created" },
      ),
    ).rejects.toThrow("host callback failed");
    expect({ head: runtime.root.head?.prompt, phase: runtime.phase, stopped: runtime.signal.aborted }).toEqual({
      head: "partly created",
      phase: "parked",
      stopped: true,
    });
    await expect(runtime.admit(commands(runtime), { prompt: "must not start" })).rejects.toBeInstanceOf(
      SessionOwnershipError,
    );
  });

  it("stages cancellation while retrying an unacknowledged checkpoint and persists it before release", async () => {
    const store = stored();
    const runtime = open(store);
    store.fail("lost-ack");
    await expect(runtime.admit(commands(runtime), { prompt: "cancel me" }, "send-cancel")).rejects.toThrow("lost");
    const turn = runtime.root.head;
    if (!(turn instanceof SessionTurn)) throw new TypeError("expected admitted turn");
    store.fail("before-commit");
    await expect(runtime.cancel(commands(runtime), { turnId: turn.uuid })).rejects.toThrow("refused commit");
    expect({ cancelled: turn.cancelRequested, held: runtime.admissionHeld }).toEqual({ cancelled: true, held: true });
    await expect(runtime.admit(commands(runtime), { prompt: "must wait for cancellation" })).rejects.toBeInstanceOf(
      SessionPersistenceError,
    );
    const unacknowledged = SessionRuntime.restore("conversation", store.bytes(), { kind: "memory" });
    onTestFinished(async () => {
      await unacknowledged[Symbol.asyncDispose]();
      unacknowledged.session.destroy();
    });
    expect(unacknowledged.root.head?.cancelRequested).toBe(false);
    await runtime.cancel(commands(runtime), { turnId: turn.uuid });
    const restored = SessionRuntime.restore("conversation", store.bytes(), { kind: "memory" });
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    expect({ cancelled: restored.root.head?.cancelRequested, held: runtime.admissionHeld }).toEqual({
      cancelled: true,
      held: false,
    });
  });

  it("keeps committed command identity through a lost acknowledgement and a fresh document", async () => {
    const store = stored();
    const runtime = open(store);
    store.fail("lost-ack");
    await expect(runtime.admit(commands(runtime), { prompt: "keep this exact request" }, "send-1")).rejects.toThrow(
      "storage acknowledgement lost",
    );
    const id = runtime.root.head?.uuid;
    expect({ held: runtime.admissionHeld, turns: runtime.root.liveTurns.size }).toEqual({ held: true, turns: 1 });
    await runtime[Symbol.asyncDispose]();
    const restored = SessionRuntime.restore("conversation", store.bytes(), store.durability);
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    restored.recover({ kind: "interrupt", message: "interrupted by host policy" });
    restored.activate();
    const result = await restored.admit(commands(restored), { prompt: "keep this exact request" }, "send-1");
    expect({ result, id: restored.root.head?.uuid, prompt: restored.root.head?.prompt }).toEqual({
      result: { ok: true, action: "mint" },
      id,
      prompt: "keep this exact request",
    });
    await expect(restored.admit(commands(restored), { prompt: "different request" }, "send-1")).rejects.toThrow(
      "different input",
    );
  });

  it("does not dispatch a tool before its intent commit and keeps an unacknowledged result on restore", async () => {
    const store = stored();
    const runtime = open(store);
    const commit = Promise.withResolvers<void>();
    let commits = 0;
    let dispatches = 0;
    let saved = new Uint8Array();
    const isolated = new SessionRuntime(runtime.session, {
      kind: "durable",
      async commit(checkpoint) {
        if (++commits === 1) await commit.promise;
        saved = new Uint8Array(checkpoint.state);
        if (commits === 2) throw new Error("result committed; acknowledgement lost");
        return { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision };
      },
    });
    isolated.recover();
    isolated.activate();
    onTestFinished(async () => {
      await isolated[Symbol.asyncDispose]();
    });
    const result = isolated.effect(
      "write-1",
      "write",
      '{"value":1}',
      {
        async invoke() {
          dispatches += 1;
          return { kind: "success", payload: "written" };
        },
      },
      (outcome) => {
        if (outcome.kind === "success") isolated.root.kvs.effect = outcome.payload;
      },
    );
    expect({ dispatches, held: isolated.admissionHeld }).toEqual({ dispatches: 0, held: false });
    await Promise.resolve();
    expect(dispatches).toBe(0);
    commit.resolve();
    await expect(result).rejects.toThrow("acknowledgement lost");
    expect({ dispatches, held: isolated.admissionHeld }).toEqual({ dispatches: 1, held: true });
    await isolated[Symbol.asyncDispose]();
    const restored = SessionRuntime.restore("conversation", saved, store.durability);
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    restored.recover();
    restored.activate();
    const recovered = await restored.effect(
      "write-1",
      "write",
      '{"value":1}',
      {
        async invoke() {
          dispatches += 1;
          return { kind: "success", payload: "repeated" };
        },
      },
      () => {
        throw new Error("committed result must not be applied twice");
      },
    );
    expect({ dispatches, outcome: recovered, value: restored.root.kvs.effect }).toEqual({
      dispatches: 1,
      outcome: { kind: "success", payload: "written" },
      value: "written",
    });
  });

  it("recovers an intent committed without an acknowledgement as unknown without dispatch", async () => {
    const store = stored();
    const runtime = open(store);
    store.fail("lost-ack");
    let dispatches = 0;
    const port = {
      async invoke() {
        dispatches += 1;
        return { kind: "success" as const, payload: "changed" };
      },
    };
    await expect(runtime.effect("write-2", "write", "{}", port, () => {})).rejects.toThrow("lost");
    await runtime[Symbol.asyncDispose]();
    const restored = SessionRuntime.restore("conversation", store.bytes(), store.durability);
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    restored.recover();
    restored.activate();
    const result = await restored.effect("write-2", "write", "{}", port, (outcome) => {
      restored.root.kvs.recovery = outcome.kind;
    });
    expect({ dispatches, kind: result.kind, recovery: restored.root.kvs.recovery }).toEqual({
      dispatches: 0,
      kind: "unknown",
      recovery: "unknown",
    });
  });

  it("rejects a late effect against a replacement runtime sharing the live document", async () => {
    const runtime = open();
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<{ kind: "success"; payload: string }>();
    const running = runtime.effect(
      "late",
      "write",
      "{}",
      {
        invoke() {
          entered.resolve();
          return result.promise;
        },
      },
      () => {
        runtime.root.kvs.late = "applied";
      },
    );
    await entered.promise;
    const replacement = new SessionRuntime(runtime.session, { kind: "memory" });
    onTestFinished(async () => {
      await replacement[Symbol.asyncDispose]();
    });
    replacement.recover();
    replacement.activate();
    result.resolve({ kind: "success", payload: "late" });
    await expect(running).rejects.toBeInstanceOf(SessionOwnershipError);
    expect({ same: replacement.session === runtime.session, value: replacement.root.kvs.late }).toEqual({
      same: true,
      value: undefined,
    });
  });

  it("interrupts execution without erasing a child delivery obligation", async () => {
    const runtime = open();
    await runtime.admit(commands(runtime), { prompt: "unfinished" });
    const turn = runtime.root.head;
    if (!(turn instanceof SessionTurn)) throw new TypeError("expected admitted turn");
    runtime.root.ensureAgentCallback("request", "parent");
    const state = runtime.checkpoint().state;
    const restored = SessionRuntime.restore("conversation", state, { kind: "memory" });
    onTestFinished(async () => {
      await restored[Symbol.asyncDispose]();
      restored.session.destroy();
    });
    restored.recover({ kind: "interrupt", message: "host interrupted" });
    expect({ exited: restored.root.head?.reducerExited, callback: restored.root.agentCallbacks.request }).toEqual({
      exited: true,
      callback: "parent",
    });
  });
});
