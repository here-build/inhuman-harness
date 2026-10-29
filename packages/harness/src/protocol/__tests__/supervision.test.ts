import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ownerEvidenceSchema,
  publishedHealthSchema,
  publishedReadiness,
  serverDescriptorSchema,
  serverRosterSchema,
  shutdownCutoffSchema,
  SUPERVISION_PROTOCOL_VERSION,
  supervisionIdentitySchema,
  supervisionMessageSchema,
  topologyHealthSchema,
  type ReadinessKind,
  type ServerDescriptor,
  type SupervisionIdentity,
  type SupervisionMessage,
  type TopologyHealth,
} from "../schemas/index.js";
import {
  decodeSupervisionMessage,
  encodeSupervisionMessage,
  isExecutionReady,
  isReconnect,
  isSameExecutionOwner,
  isStaleSupervisionIdentity,
  isSyncReady,
  mayReplaceExecutionOwner,
  mayStartExecutionOwnerAfterYjsLoss,
  replacementDecision,
  shutdownFlushFailed,
  shutdownIsComplete,
} from "../supervision/index.js";

const restart = { mode: "on-failure" as const, maxAttempts: 3, backoffMs: 250 };

const yjsDescriptor = {
  id: "yjs",
  role: "yjs" as const,
  executable: "/usr/bin/harness-yjs-server",
  args: ["--root", "/tmp/harness"],
  requires: [] as string[],
  restart,
};

const runtimeDescriptor = {
  id: "runtime",
  role: "runtime" as const,
  executable: "/usr/bin/harness-runtime-server",
  requires: ["yjs"],
  restart,
};

const identity: SupervisionIdentity = {
  hypervisor: { kind: "hypervisor", id: "hv-1" },
  process: { kind: "runtime", id: "rt-1" },
  serverEpoch: 1,
  runtimeGeneration: 4,
  connectionEpoch: 2,
};

const starting: TopologyHealth = {
  sync: { state: "ready" },
  storage: { state: "ready" },
  execution: { state: "starting" },
};

const runtimeHealth = { execution: { state: "starting" as const } };

describe("server descriptors", () => {
  it("parses executable, role, readiness dependencies, and restart policy as data", () => {
    const parsed = serverDescriptorSchema.parse(runtimeDescriptor);
    expect(parsed.executable).toBe("/usr/bin/harness-runtime-server");
    expect(parsed.role).toBe("runtime");
    expect(parsed.requires).toEqual(["yjs"]);
    expect(parsed.restart).toEqual(restart);
    expect(parsed.args).toEqual([]);
    expect(parsed).not.toHaveProperty("publishes");
    expectTypeOf(parsed).toEqualTypeOf<ServerDescriptor>();
    expectTypeOf(parsed.executable).toEqualTypeOf<string>();
  });

  it("fills omitted args rather than requiring an implementation import", () => {
    expect(serverDescriptorSchema.parse(yjsDescriptor).args).toEqual(["--root", "/tmp/harness"]);
    expect(
      serverDescriptorSchema.safeParse({
        ...runtimeDescriptor,
        executable: "",
      }).success,
    ).toBe(false);
    expect(
      serverDescriptorSchema.safeParse({
        ...runtimeDescriptor,
        role: "hypervisor",
      }).success,
    ).toBe(false);
  });

  it("derives published readiness from role", () => {
    expect(publishedReadiness("yjs")).toEqual(["sync", "storage"]);
    expect(publishedReadiness("runtime")).toEqual(["execution"]);
  });

  it("rejects unknown, duplicate, and cyclic readiness dependencies", () => {
    expect(serverRosterSchema.parse({ servers: [yjsDescriptor, runtimeDescriptor] }).servers).toHaveLength(2);
    expect(
      serverRosterSchema.safeParse({
        servers: [yjsDescriptor, { ...runtimeDescriptor, requires: ["missing"] }],
      }).success,
    ).toBe(false);
    expect(
      serverRosterSchema.safeParse({
        servers: [yjsDescriptor, { ...runtimeDescriptor, id: "yjs" }],
      }).success,
    ).toBe(false);
    expect(
      serverRosterSchema.safeParse({
        servers: [{ ...yjsDescriptor, requires: ["runtime"] }, runtimeDescriptor],
      }).success,
    ).toBe(false);
  });
});

describe("health planes", () => {
  it("treats sync ready as independent of execution ready", () => {
    const health = topologyHealthSchema.parse(starting);
    expect(isSyncReady(health)).toBe(true);
    expect(isExecutionReady(health)).toBe(false);
    expectTypeOf<ReadinessKind>().toEqualTypeOf<"sync" | "storage" | "execution">();
    expectTypeOf<ReadinessKind>().not.toMatchTypeOf<"socket">();
  });

  it("allows disconnected execution while sync stays ready", () => {
    const health = topologyHealthSchema.parse({
      sync: { state: "ready" },
      storage: { state: "degraded", reason: "write admission stopped" },
      execution: { state: "disconnected" },
    });
    expect(isSyncReady(health)).toBe(true);
    expect(isExecutionReady(health)).toBe(false);
    expect(health.storage.state).toBe("degraded");
  });

  it("requires a reason for degraded and failed planes", () => {
    expect(
      topologyHealthSchema.safeParse({
        ...starting,
        storage: { state: "failed" },
      }).success,
    ).toBe(false);
    expect(
      topologyHealthSchema.safeParse({
        ...starting,
        execution: { state: "failed", reason: "boot retries exhausted" },
      }).success,
    ).toBe(true);
  });

  it("lets a child report only the planes its role publishes", () => {
    expect(publishedHealthSchema.parse({ execution: { state: "starting" } })).toEqual({
      execution: { state: "starting" },
    });
    expect(isExecutionReady({ execution: { state: "ready" } })).toBe(true);
    expect(isSyncReady({ execution: { state: "ready" } })).toBe(false);
    expect(
      supervisionMessageSchema.safeParse({
        v: SUPERVISION_PROTOCOL_VERSION,
        op: "health",
        identity,
        health: starting,
      }).success,
    ).toBe(false);
    expect(
      supervisionMessageSchema.safeParse({
        v: SUPERVISION_PROTOCOL_VERSION,
        op: "health",
        identity,
        health: runtimeHealth,
      }).success,
    ).toBe(true);
    expect(
      supervisionMessageSchema.safeParse({
        v: SUPERVISION_PROTOCOL_VERSION,
        op: "health",
        identity: { ...identity, process: { kind: "yjs", id: "yjs-1" } },
        health: { sync: { state: "ready" } },
      }).success,
    ).toBe(true);
  });
});

describe("owner identity", () => {
  it("identifies process, epoch, and generation without a pid field", () => {
    const parsed = supervisionIdentitySchema.parse(identity);
    expect(parsed.process.id).toBe("rt-1");
    expect(parsed).not.toHaveProperty("pid");
    expect(parsed.hypervisor.kind).toBe("hypervisor");
    expect(
      supervisionIdentitySchema.safeParse({
        ...identity,
        hypervisor: { kind: "runtime", id: "hv-1" },
      }).success,
    ).toBe(false);
  });

  it("treats a newer connection epoch as reconnect, not stale", () => {
    const reconnected = { ...identity, connectionEpoch: 3 };
    expect(isSameExecutionOwner(identity, reconnected)).toBe(true);
    expect(isReconnect(identity, reconnected)).toBe(true);
    expect(isStaleSupervisionIdentity(identity, reconnected)).toBe(false);
    expect(isReconnect(identity, { ...identity, connectionEpoch: 1 })).toBe(false);
    expect(isStaleSupervisionIdentity(identity, { ...identity, connectionEpoch: 1 })).toBe(true);
    expect(isSameExecutionOwner(identity, { ...identity, runtimeGeneration: 5 })).toBe(false);
  });

  it("fences older clocks as stale and never treats newer clocks as stale", () => {
    expect(
      isStaleSupervisionIdentity(identity, {
        ...identity,
        runtimeGeneration: 3,
      }),
    ).toBe(true);
    expect(isStaleSupervisionIdentity(identity, { ...identity, serverEpoch: 0 })).toBe(true);
    expect(
      isStaleSupervisionIdentity(identity, {
        ...identity,
        runtimeGeneration: 5,
      }),
    ).toBe(false);
    expect(isStaleSupervisionIdentity(identity, identity)).toBe(false);
  });

  it("treats hypervisor mismatch as neither reconnect nor current", () => {
    const otherParent = {
      ...identity,
      hypervisor: { kind: "hypervisor" as const, id: "hv-2" },
    };
    expect(isSameExecutionOwner(identity, otherParent)).toBe(false);
    expect(isReconnect(identity, otherParent)).toBe(false);
    expect(isReconnect(identity, { ...otherParent, connectionEpoch: 9 })).toBe(false);
    expect(isStaleSupervisionIdentity(identity, otherParent)).toBe(false);
  });
});

describe("loss and replacement", () => {
  const live = {
    exitConfirmed: false,
    lockReleased: false,
    parentLost: false,
    dataDisconnected: false,
    heartbeatMissing: false,
  };

  it("requires confirmed exit and lock release before replacement", () => {
    expect(mayReplaceExecutionOwner(ownerEvidenceSchema.parse(live))).toBe(false);
    expect(replacementDecision({ ...live, exitConfirmed: true })).toEqual({
      action: "refuse",
      reason: "lock-held",
    });
    expect(
      mayReplaceExecutionOwner({
        ...live,
        exitConfirmed: true,
        lockReleased: true,
      }),
    ).toBe(true);
  });

  it("does not treat missing heartbeat or data disconnect as death", () => {
    expect(replacementDecision({ ...live, heartbeatMissing: true })).toEqual({
      action: "refuse",
      reason: "heartbeat-is-not-death",
    });
    expect(replacementDecision({ ...live, dataDisconnected: true })).toEqual({
      action: "refuse",
      reason: "disconnect-is-not-death",
    });
  });

  it("does not free a live runtime lock when the parent is lost", () => {
    expect(replacementDecision({ ...live, parentLost: true })).toEqual({
      action: "refuse",
      reason: "parent-loss-holds-runtime-lock",
    });
    expect(
      mayStartExecutionOwnerAfterYjsLoss({
        ...live,
        parentLost: true,
        exitConfirmed: true,
        lockReleased: true,
      }),
    ).toBe(true);
    expect(
      mayStartExecutionOwnerAfterYjsLoss({
        ...live,
        exitConfirmed: true,
      }),
    ).toBe(false);
  });
});

describe("shutdown cutoff", () => {
  it("refuses new admission and completes only after drain plus flush report", () => {
    const draining = shutdownCutoffSchema.parse({
      admission: "refused",
      drain: "pending",
      flush: "pending",
      forced: false,
    });
    expect(draining.admission).toBe("refused");
    expect(shutdownIsComplete(draining)).toBe(false);
    expect(shutdownCutoffSchema.safeParse({ ...draining, admission: "open" }).success).toBe(false);

    const flushed = shutdownCutoffSchema.parse({
      admission: "refused",
      drain: "complete",
      flush: "ok",
      forced: false,
    });
    expect(shutdownIsComplete(flushed)).toBe(true);
    expect(shutdownFlushFailed(flushed)).toBe(false);
  });

  it("keeps failed and forced-pending flush observable", () => {
    const failed = shutdownCutoffSchema.parse({
      admission: "refused",
      drain: "complete",
      flush: "failed",
      forced: false,
    });
    expect(shutdownIsComplete(failed)).toBe(true);
    expect(shutdownFlushFailed(failed)).toBe(true);
    expect(
      shutdownFlushFailed(
        shutdownCutoffSchema.parse({
          admission: "refused",
          drain: "pending",
          flush: "pending",
          forced: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("supervision codecs", () => {
  const messages: SupervisionMessage[] = [
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "ready",
      identity,
      health: runtimeHealth,
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "failed",
      identity,
      health: { execution: { state: "failed", reason: "boot" } },
      reason: "boot",
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "health",
      identity,
      health: runtimeHealth,
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "shutdown",
      identity,
      deadlineMs: 5_000,
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "stopped",
      identity,
      cutoff: {
        admission: "refused",
        drain: "complete",
        flush: "ok",
        forced: false,
      },
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "loss",
      identity,
      kind: "data-disconnected",
    },
    {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "loss",
      identity,
      kind: "lock-released",
      lock: "runtime",
    },
  ];

  it("round-trips every control op", () => {
    for (const message of messages) {
      const decoded = decodeSupervisionMessage(encodeSupervisionMessage(message));
      expect(decoded).toEqual(supervisionMessageSchema.parse(message));
    }
  });

  it("treats unknown op and version mismatch as fatal", () => {
    expect(() => decodeSupervisionMessage(JSON.stringify({ ...messages[0], op: "rpc" }))).toThrow();
    expect(() => decodeSupervisionMessage(JSON.stringify({ ...messages[0], v: 2 }))).toThrow();
    expect(() => decodeSupervisionMessage(JSON.stringify({ ...messages[0], extra: true }))).toThrow();
    expect(() =>
      decodeSupervisionMessage(
        JSON.stringify({
          v: SUPERVISION_PROTOCOL_VERSION,
          op: "loss",
          identity,
          kind: "parent-lost",
          lock: "runtime",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeSupervisionMessage(
        JSON.stringify({
          v: SUPERVISION_PROTOCOL_VERSION,
          op: "loss",
          identity,
          kind: "lock-released",
        }),
      ),
    ).toThrow();
  });
});
