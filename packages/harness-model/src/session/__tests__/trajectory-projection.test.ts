/**
 * Invocation sees the prefix before its own metadata. Compact wire is not the log.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import { describe, expect, it } from "vitest";

import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { bindSessionProjections, PluginProjectionRegistry } from "../projection-registry.js";
import { SessionRoot } from "../SessionRoot.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { storageBefore, writePluginMeta, type PluginStorageMap } from "../trajectory-projection.js";
import { SessionTurn } from "../turn/session-turn.js";

const PROBE = "probe-fold";

type Probe = { readonly n: number };
type ProbeAction = { readonly add: number };

const probeProjection = {
  initial: () => ({ n: 0 }),
  reduce: (state: Probe, action: ProbeAction) => ({ n: state.n + action.add }),
};

function probeOf(storage: PluginStorageMap): Probe {
  const raw = storage[PROBE];
  if (typeof raw === "object" && raw != null && "n" in raw && typeof raw.n === "number") return { n: raw.n };
  return { n: 0 };
}

function ensureHead(root: SessionRoot): SessionTurn {
  if (root.head instanceof SessionTurn) return root.head;
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`t`, queue: [] });
  root.head = turn;
  return turn;
}

function attached(sessionId: string): SessionRoot {
  const root = new SessionRoot({ sessionId, path: "/tmp/proj" });
  const registry = new PluginProjectionRegistry();
  registry.install([{ pluginName: PROBE, projection: probeProjection }]);
  bindSessionProjections(root, registry);
  return root;
}

describe("trajectory projection", () => {
  it("prefix excludes this job; bag inners count; compact stamp is not the log", () => {
    const prefixRoot = attached("s-prefix");
    const prefixTurn = ensureHead(prefixRoot);
    const first = new SystemToolJob({
      toolCallId: "a",
      name: "probe",
      argsJson: "{}",
      completed: true,
      outcomeJson: JSON.stringify({ ok: true }),
    });
    writePluginMeta(first, PROBE, { add: 1 });
    prefixTurn.enqueue(first);
    prefixTurn.doneWork.push(prefixTurn.queue.shift()!);
    const second = new SystemToolJob({
      toolCallId: "b",
      name: "probe",
      argsJson: "{}",
    });
    writePluginMeta(second, PROBE, { add: 1 });
    prefixTurn.enqueue(second);

    const innerRoot = attached("s-inner");
    const innerTurn = ensureHead(innerRoot);
    const bag = new ProgrammaticJob({ toolCallId: "bag", argsJson: "{}" });
    const inner = new SystemToolJob({
      toolCallId: "c1",
      name: "probe",
      argsJson: "{}",
    });
    writePluginMeta(inner, PROBE, { add: 3 });
    bag.pushInvocation(inner);
    innerTurn.doneWork.push(bag);
    innerTurn.pushChild(bag);

    const wireRoot = attached("s-wire");
    const wireTurn = ensureHead(wireRoot);
    const job = new SystemToolJob({
      toolCallId: "a",
      name: "probe",
      argsJson: "{}",
      completed: true,
      outcomeJson: JSON.stringify({ ok: true }),
    });
    writePluginMeta(job, PROBE, { add: 4 });
    wireTurn.enqueue(job);
    wireTurn.doneWork.push(wireTurn.queue.shift()!);
    const beforeReload = probeOf(wireRoot.storageAfter).n;
    wireTurn.reloadTools = true;
    expect({
      prefix: { before: probeOf(storageBefore(prefixRoot, second)).n, after: probeOf(prefixRoot.storageAfter).n },
      inner: probeOf(innerRoot.storageAfter).n,
      wire: {
        before: beforeReload,
        after: probeOf(wireRoot.storageAfter).n,
        turnTail: wireTurn.turnTail instanceof SessionSystemPrompt,
      },
    }).toEqual({
      prefix: { before: 1, after: 2 },
      inner: 3,
      wire: { before: 4, after: 4, turnTail: true },
    });
  });

  it("unbound root leaves stamped metadata out of the projection", () => {
    const root = new SessionRoot({ sessionId: "s-unbound", path: "/tmp/proj" });
    const turn = ensureHead(root);
    const job = new SystemToolJob({
      toolCallId: "a",
      name: "probe",
      argsJson: "{}",
      completed: true,
      outcomeJson: JSON.stringify({ ok: true }),
    });
    writePluginMeta(job, PROBE, { add: 9 });
    turn.enqueue(job);
    turn.doneWork.push(turn.queue.shift()!);
    expect(probeOf(root.storageAfter).n).toBe(0);
  });

  it("two registries do not leak", () => {
    const left = attached("s-left");
    const rightRoot = new SessionRoot({ sessionId: "s-right", path: "/tmp/proj" });
    const right = new PluginProjectionRegistry();
    right.install([
      {
        pluginName: PROBE,
        projection: {
          initial: () => ({ n: 100 }),
          reduce: (state: Probe, action: ProbeAction) => ({ n: state.n + action.add }),
        },
      },
    ]);
    bindSessionProjections(rightRoot, right);
    const leftTurn = ensureHead(left);
    const rightTurn = ensureHead(rightRoot);
    const leftJob = new SystemToolJob({ toolCallId: "l", name: "probe", argsJson: "{}" });
    writePluginMeta(leftJob, PROBE, { add: 1 });
    leftTurn.enqueue(leftJob);
    leftTurn.doneWork.push(leftTurn.queue.shift()!);
    const rightJob = new SystemToolJob({ toolCallId: "r", name: "probe", argsJson: "{}" });
    writePluginMeta(rightJob, PROBE, { add: 1 });
    rightTurn.enqueue(rightJob);
    rightTurn.doneWork.push(rightTurn.queue.shift()!);
    expect({ left: probeOf(left.storageAfter).n, right: probeOf(rightRoot.storageAfter).n }).toEqual({
      left: 1,
      right: 101,
    });
  });

  it("folds a deep spine oldest first and stops at a turnTail cycle", () => {
    const root = attached("s-deep");
    const stamped = (add: number): SessionTurn => {
      const job = new SystemToolJob({ toolCallId: `j${add}`, name: "probe", argsJson: "{}", completed: true });
      writePluginMeta(job, PROBE, { add });
      return new SessionTurn({ turnTail: new SessionSystemPrompt(), doneWork: [job], queue: [] });
    };
    const first = stamped(1);
    let head = first;
    for (let index = 0; index < 10_000; index += 1) head = new SessionTurn({ turnTail: head, queue: [] });
    const last = stamped(2);
    last.turnTail = head;
    root.head = last;
    const deep = probeOf(root.storageAfter).n;
    first.turnTail = last;
    expect({ deep, cycle: probeOf(root.storageAfter).n }).toEqual({ deep: 3, cycle: 3 });
  });
});
