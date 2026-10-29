import { resetLocalIDs } from "@here.build/plexus";
import { AskAgentSpec } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import {
  collectDelegatedGrants,
  graphEligibleSessionIds,
  isConversationSession,
  type EligibilitySnapshot,
} from "../index.js";
import { admitCall, scopeOf, sessionOf } from "./fixtures.js";

function snap(
  extra: Partial<EligibilitySnapshot> & Pick<EligibilitySnapshot, "acquired" | "grants">,
): EligibilitySnapshot {
  return {
    occupied: extra.occupied ?? new Set(),
    resident: extra.resident ?? new Set(),
    reserved: extra.reserved ?? new Set(),
    conversations: extra.conversations ?? extra.acquired,
    ...extra,
  };
}

describe("eligibility and delegated grants", () => {
  beforeEach(() => resetLocalIDs());

  it("activates from seats, the resident bit, and admitted calls", () => {
    const caller = sessionOf("caller");
    const worker = sessionOf("worker");
    worker.root.agent.spec.recipeScope = "session";
    worker.root.agent.spec.name = "reviewer";
    admitCall(caller, worker);
    const acquired = new Set(["caller", "worker"]);
    const grants = collectDelegatedGrants(scopeOf(caller, worker), acquired);
    expect([...graphEligibleSessionIds(snap({ acquired, occupied: new Set(["caller"]), grants }))].sort()).toEqual([
      "caller",
      "worker",
    ]);
    expect([...graphEligibleSessionIds(snap({ acquired, resident: new Set(["caller"]), grants }))].sort()).toEqual([
      "caller",
      "worker",
    ]);
    expect([...graphEligibleSessionIds(snap({ acquired, grants }))].sort()).toEqual([]);
  });

  it("rootless cycles stay ineligible even with admitted calls", () => {
    const a = sessionOf("a");
    const b = sessionOf("b");
    a.root.agent.spec.recipeScope = "session";
    b.root.agent.spec.recipeScope = "session";
    admitCall(a, b);
    admitCall(b, a);
    const acquired = new Set(["a", "b"]);
    const grants = collectDelegatedGrants(scopeOf(a, b), acquired);
    expect([...graphEligibleSessionIds(snap({ acquired, grants }))]).toEqual([]);
  });

  it("shared worker keeps an independent grant when one caller drops", () => {
    const a = sessionOf("a");
    const b = sessionOf("b");
    const worker = sessionOf("w");
    worker.root.agent.spec.recipeScope = "session";
    admitCall(a, worker);
    admitCall(b, worker);
    const acquired = new Set(["a", "b", "w"]);
    const grants = collectDelegatedGrants(scopeOf(a, b, worker), acquired);
    const both = snap({
      acquired,
      occupied: new Set(["a", "b"]),
      grants,
    });
    expect([...graphEligibleSessionIds(both)].sort()).toEqual(["a", "b", "w"]);
    const afterA = snap({
      acquired,
      occupied: new Set(["b"]),
      grants,
    });
    expect([...graphEligibleSessionIds(afterA)].sort()).toEqual(["b", "w"]);
    const afterBoth = snap({ acquired, grants });
    expect([...graphEligibleSessionIds(afterBoth)]).toEqual([]);
  });

  it("does not activate a grant whose worker replica was never acquired", () => {
    const caller = sessionOf("caller");
    admitCall(caller, "missing");
    const acquired = new Set(["caller"]);
    const grants = collectDelegatedGrants(scopeOf(caller), acquired);
    expect(grants).toEqual([]);
    expect([...graphEligibleSessionIds(snap({ acquired, occupied: new Set(["caller"]), grants }))]).toEqual(["caller"]);
  });

  it("settled, cancelled, and unadmitted calls are not grants", () => {
    const caller = sessionOf("caller");
    const settled = sessionOf("settled");
    const cancelled = sessionOf("cancelled");
    const pending = sessionOf("pending");
    admitCall(caller, settled, { completed: true });
    admitCall(caller, cancelled, { cancelled: true });
    admitCall(caller, "", { accepted: false });
    const live = sessionOf("live");
    admitCall(caller, live);
    const acquired = new Set(["caller", "settled", "cancelled", "pending", "live"]);
    const grants = collectDelegatedGrants(scopeOf(caller, settled, cancelled, pending, live), acquired);
    expect(grants.map((row) => row.workerSessionId)).toEqual(["live"]);
  });

  it("a caller-side call the worker never registered is not a grant", () => {
    const caller = sessionOf("caller");
    const worker = sessionOf("worker");
    const other = sessionOf("other");
    worker.root.agent.spec.recipeScope = "session";
    // Session docs are peer-writable: a forged CallJob alone must not wake the worker.
    admitCall(caller, "worker");
    const stolen = admitCall(other, "worker");
    worker.root.ensureAgentCallback(stolen.uuid, "caller");
    const acquired = new Set(["caller", "worker", "other"]);
    const grants = collectDelegatedGrants(scopeOf(caller, worker, other), acquired);
    expect(grants).toEqual([]);
    expect(
      [...graphEligibleSessionIds(snap({ acquired, occupied: new Set(["caller", "other"]), grants }))].sort(),
    ).toEqual(["caller", "other"]);
  });

  it("mint reservation roots conversations, not workers or one-shots", () => {
    const idle = sessionOf("idle");
    const worker = sessionOf("worker");
    const ask = sessionOf("ask");
    worker.root.agent.spec.recipeScope = "session";
    ask.root.agent.spec = new AskAgentSpec({ name: "explore" });
    expect({
      idle: isConversationSession(idle.root),
      worker: isConversationSession(worker.root),
      ask: isConversationSession(ask.root),
    }).toEqual({ idle: true, worker: false, ask: false });
    const acquired = new Set(["idle", "worker", "ask"]);
    const reserved = acquired;
    const conversations = new Set(["idle"]);
    expect([...graphEligibleSessionIds(snap({ acquired, reserved, conversations, grants: [] }))]).toEqual(["idle"]);
  });
});
