import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_SCOPE_ID, type ShapeDeltaFrame } from "@inhuman.tools/harness-contract";
import { grantLabel, type GrantRow } from "@inhuman.tools/harness-model";
import { readBlob, readVisual } from "@inhuman.tools/harness-provider-sdk";
import { CommitDiffShapeSource, MemoryKvStore, UpdateLaneHub } from "@inhuman.tools/scope-plane";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { runInAction } from "mobx";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { DbStateStore, jsonToVal, type OwnerParts } from "@/extensions";

import { MemoryBlobBucket } from "../blobs/memory-bucket.js";
import { vacuumDatabaseBlobs } from "../blobs/vacuum.js";
import { RpcInvalidParams } from "../contract.js";
import { MultiKernelRegistry } from "../multi-kernel-registry.js";

function makeGlobalCommandGrant(id: string, argv0: string): GrantRow {
  const subject = { kind: "command" as const, argv0, spine: [argv0], args: [] };
  return {
    id,
    scope: "global",
    scopeKey: "",
    subject,
    createdAtMs: 1_700_000_000_000,
    expiresAtMs: null,
    source: "settings",
    label: grantLabel(subject),
  };
}

describe("MultiKernelRegistry & server-contour KernelDaemon", () => {
  it("isolates config, grants, kvs, secrets, virtual projects, sessions, and UpdateLaneHub deltas across tenants with zero FS", async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), "harness-multi-kernel-nofs-"));
    const db = new SqliteKvStore(":memory:");
    const laneHub = new UpdateLaneHub(db);
    const registry = new MultiKernelRegistry({
      db,
      ownsDb: false,
      laneHub,
      ownsLaneHub: false,
    });
    onTestFinished(async () => {
      await registry[Symbol.asyncDispose]();
      laneHub.dispose();
      await db.close();
    });

    const tenantADeltas: ShapeDeltaFrame[] = [];
    const tenantBDeltas: ShapeDeltaFrame[] = [];
    const tenantASessionDeltas: ShapeDeltaFrame[] = [];
    const tenantBSessionDeltas: ShapeDeltaFrame[] = [];
    const unsubA = laneHub.subscribe(
      {
        kind: "shape/subscribe",
        subscriptionId: "sub-a",
        lane: "scope_nodes",
        params: { kernelId: "tenant-a", scopeId: KERNEL_SCOPE_ID },
      },
      (frame) => tenantADeltas.push(frame),
      "client-a",
    );
    const unsubB = laneHub.subscribe(
      {
        kind: "shape/subscribe",
        subscriptionId: "sub-b",
        lane: "scope_nodes",
        params: { kernelId: "tenant-b", scopeId: KERNEL_SCOPE_ID },
      },
      (frame) => tenantBDeltas.push(frame),
      "client-b",
    );
    const unsubRecentA = laneHub.subscribe(
      {
        kind: "shape/subscribe",
        subscriptionId: "sub-recent-a",
        lane: "recent_sessions",
        params: { kernelId: "tenant-a", limit: 20 },
      },
      (frame) => tenantASessionDeltas.push(frame),
      "client-a",
    );
    const unsubRecentB = laneHub.subscribe(
      {
        kind: "shape/subscribe",
        subscriptionId: "sub-recent-b",
        lane: "recent_sessions",
        params: { kernelId: "tenant-b", limit: 20 },
      },
      (frame) => tenantBSessionDeltas.push(frame),
      "client-b",
    );
    onTestFinished(() => {
      unsubA();
      unsubB();
      unsubRecentA();
      unsubRecentB();
    });

    const [leaseA, leaseB] = await Promise.all([registry.acquire("tenant-a"), registry.acquire("tenant-b")]);
    const kernelA = leaseA.kernel;
    const kernelB = leaseB.kernel;

    expect(kernelA.contour).toBe("server");
    expect(kernelB.contour).toBe("server");
    expect(kernelA.doc.root.kernelId).toBe("tenant-a");
    expect(kernelB.doc.root.kernelId).toBe("tenant-b");
    expect(existsSync(join(tmpBase, "server:"))).toBe(false);
    expect(existsSync(kernelA.root)).toBe(false);
    expect(existsSync(kernelB.root)).toBe(false);

    // Server contour blocks local FS install/remove while keeping config/set live.
    await expect(kernelA.handleRequest("plugin/install", { spec: "left-pad" })).rejects.toBeInstanceOf(
      RpcInvalidParams,
    );
    await expect(kernelA.handleRequest("plugin/remove", { name: "toolkit", confirm: true })).rejects.toBeInstanceOf(
      RpcInvalidParams,
    );

    await kernelA.handleRequest("config/set", { defaultPermissionMode: "yolo" });
    await kernelB.handleRequest("config/set", { defaultPermissionMode: "manual" });
    kernelA.addPersistentGrant(makeGlobalCommandGrant("g-a", "git"));
    kernelB.addPersistentGrant(makeGlobalCommandGrant("g-b", "rg"));
    kernelA.writeKvs([{ form: "kv-set", key: "model", value: "model-alpha" }]);
    kernelB.writeKvs([{ form: "kv-set", key: "model", value: "model-beta" }]);

    expect(kernelA.doc.root.defaultPermissionMode).toBe("yolo");
    expect(kernelB.doc.root.defaultPermissionMode).toBe("manual");
    expect(kernelA.persistentGrants().map((g) => g.id)).toEqual(["g-a"]);
    expect(kernelB.persistentGrants().map((g) => g.id)).toEqual(["g-b"]);
    expect(kernelA.doc.root.kvs.model).toBe("model-alpha");
    expect(kernelB.doc.root.kvs.model).toBe("model-beta");

    // Secrets vault isolation
    kernelA.secrets.writeConnectionSecrets("conn-1", { apiKey: "secret-a" });
    kernelB.secrets.writeConnectionSecrets("conn-1", { apiKey: "secret-b" });
    expect(kernelA.secrets.readConnectionSecrets("conn-1")).toEqual({ apiKey: "secret-a" });
    expect(kernelB.secrets.readConnectionSecrets("conn-1")).toEqual({ apiKey: "secret-b" });
    kernelA.secrets.deleteConnectionSecrets("conn-1");
    expect(kernelA.secrets.readConnectionSecrets("conn-1")).toEqual({});
    expect(kernelB.secrets.readConnectionSecrets("conn-1")).toEqual({ apiKey: "secret-b" });

    // Virtual projects + sessions + cross-tenant guards
    const projA = kernelA.project("kley://team-alpha");
    const projB = kernelB.project("kley://team-beta");
    await Promise.all([projA.ready, projB.ready]);

    expect(kernelA.hasProject("kley://team-alpha")).toBe(true);
    expect(kernelA.hasProject("kley://team-beta")).toBe(false);
    expect(kernelB.hasProject("kley://team-beta")).toBe(true);

    const sessionA = await projA.session("sess-tenant-a");
    const sessionB = await projB.session("sess-tenant-b");
    runInAction(() => {
      sessionA.root.projectId = "proj-alpha";
      sessionB.root.projectId = "proj-beta";
    });
    await Promise.all([
      kernelA.flushSession(sessionA.doc, { force: true }),
      kernelB.flushSession(sessionB.doc, { force: true }),
    ]);

    expect(kernelA.hasStoredSession("sess-tenant-a")).toBe(true);
    expect(kernelA.hasStoredSession("sess-tenant-b")).toBe(false);
    expect(kernelB.hasStoredSession("sess-tenant-b")).toBe(true);
    expect(kernelB.hasStoredSession("sess-tenant-a")).toBe(false);
    expect(await kernelB.acquireSession("sess-tenant-a")).toBeUndefined();
    await expect(kernelB.mintSessionDocument("sess-tenant-a", "kley://team-beta")).rejects.toThrow(
      /belongs to another kernel/,
    );

    const dbRowA = await db.get("sessions", "sess-tenant-a");
    const dbRowB = await db.get("sessions", "sess-tenant-b");
    expect(dbRowA).toMatchObject({ kernelId: "tenant-a", projectId: "proj-alpha" });
    expect(dbRowB).toMatchObject({ kernelId: "tenant-b", projectId: "proj-beta" });

    // Flush kernels so kernel_state and scope_nodes reflect latest changes
    await kernelA.flushKernel();
    await kernelB.flushKernel();

    // UpdateLaneHub live deltas for tenant-a must never include tenant-b rows
    const scopeARows = await db.scan("scope_nodes", { where: { kernelId: "tenant-a", scopeId: KERNEL_SCOPE_ID } });
    const scopeBRows = await db.scan("scope_nodes", { where: { kernelId: "tenant-b", scopeId: KERNEL_SCOPE_ID } });
    expect(scopeARows.length).toBeGreaterThan(0);
    expect(scopeBRows.length).toBeGreaterThan(0);

    const aRowIds = new Set(scopeARows.map((r) => r.id));
    const bRowIds = new Set(scopeBRows.map((r) => r.id));
    for (const delta of tenantADeltas) {
      for (const upsert of delta.upserts) {
        const id = String(upsert["id"]);
        expect(aRowIds.has(id)).toBe(true);
        expect(bRowIds.has(id)).toBe(false);
      }
    }
    for (const delta of tenantBDeltas) {
      for (const upsert of delta.upserts) {
        const id = String(upsert["id"]);
        expect(bRowIds.has(id)).toBe(true);
        expect(aRowIds.has(id)).toBe(false);
      }
    }
    const recentAIds = tenantASessionDeltas.flatMap((d) => d.upserts.map((u) => String(u["sessionId"])));
    const recentBIds = tenantBSessionDeltas.flatMap((d) => d.upserts.map((u) => String(u["sessionId"])));
    expect(recentAIds).toContain("sess-tenant-a");
    expect(recentAIds).not.toContain("sess-tenant-b");
    expect(recentBIds).toContain("sess-tenant-b");
    expect(recentBIds).not.toContain("sess-tenant-a");

    leaseA[Symbol.dispose]();
    leaseB[Symbol.dispose]();
  });

  it("isolates AsyncLocalStorage blob/visual contexts, DbStateStore logs, and per-kernel blob vacuuming", async () => {
    const db = new SqliteKvStore(":memory:");
    const bucketA = new MemoryBlobBucket();
    const bucketB = new MemoryBlobBucket();
    const registry = new MultiKernelRegistry({
      db,
      ownsDb: false,
      createBlobBucket: (kernelId) => (kernelId === "tenant-a" ? bucketA : bucketB),
    });
    onTestFinished(async () => {
      await registry[Symbol.asyncDispose]();
      await db.close();
    });

    const [leaseA, leaseB] = await Promise.all([registry.acquire("tenant-a"), registry.acquire("tenant-b")]);
    const kernelA = leaseA.kernel;
    const kernelB = leaseB.kernel;

    const projA = kernelA.project("kley://ws-a");
    const projB = kernelB.project("kley://ws-b");
    await Promise.all([projA.ready, projB.ready]);
    const sessA = await projA.session("sess-a");
    const sessB = await projB.session("sess-b");

    const bytesA = Buffer.from("tenant-a-secret-payload");
    const bytesB = Buffer.from("tenant-b-secret-payload");
    const refA = kernelA.blobs.write(bytesA, "text/plain");
    const refB = kernelB.blobs.write(bytesB, "text/plain");

    // SessionDaemon RPC `blob/get` reads exclusively from its own kernel's BlobStore
    await expect(sessA.handleRequest("blob/get", { sha256: refA.sha256 })).resolves.toMatchObject({
      sha256: refA.sha256,
      text: "tenant-a-secret-payload",
    });
    await expect(sessA.handleRequest("blob/get", { sha256: refB.sha256 })).rejects.toBeInstanceOf(RpcInvalidParams);
    await expect(sessB.handleRequest("blob/get", { sha256: refB.sha256 })).resolves.toMatchObject({
      sha256: refB.sha256,
      text: "tenant-b-secret-payload",
    });

    kernelA.visuals.write("sess-a", "vis-shared", Buffer.from("png-a"));
    kernelB.visuals.write("sess-b", "vis-shared", Buffer.from("png-b"));

    // Concurrent AsyncLocalStorage execution never leaks across kernels
    const [resA, resB] = await Promise.all([
      kernelA.runInStoreContext(async () => {
        await Promise.resolve();
        return {
          blobOwn: Buffer.from(readBlob(refA.sha256) ?? []).toString("utf8"),
          blobOther: readBlob(refB.sha256),
          visOwn: Buffer.from(readVisual("sess-a", "vis-shared") ?? []).toString("utf8"),
          visOther: readVisual("sess-b", "vis-shared"),
        };
      }),
      kernelB.runInStoreContext(async () => {
        await Promise.resolve();
        return {
          blobOwn: Buffer.from(readBlob(refB.sha256) ?? []).toString("utf8"),
          blobOther: readBlob(refA.sha256),
          visOwn: Buffer.from(readVisual("sess-b", "vis-shared") ?? []).toString("utf8"),
          visOther: readVisual("sess-a", "vis-shared"),
        };
      }),
    ]);

    expect(resA).toEqual({
      blobOwn: "tenant-a-secret-payload",
      blobOther: null,
      visOwn: "png-a",
      visOther: null,
    });
    expect(resB).toEqual({
      blobOwn: "tenant-b-secret-payload",
      blobOther: null,
      visOwn: "png-b",
      visOther: null,
    });

    // Vacuum scoped by kernelId only retains referenced blobs of that kernel
    kernelA.recordSessionBlob("sess-a", refA.sha256, bytesA.byteLength);
    const orphanA = kernelA.blobs.write(Buffer.from("orphan-a"), "text/plain");
    const deleted = await vacuumDatabaseBlobs(
      db,
      {
        list: () => bucketA.listHashes(),
        delete: (sha256) => bucketA.deleteHash(sha256),
      },
      "tenant-a",
    );
    expect(deleted).toBe(1);
    expect(bucketA.getSync(`sha256/${refA.sha256}`)).not.toBeNull();
    expect(bucketA.getSync(`sha256/${orphanA.sha256}`)).toBeNull();
    expect(bucketB.getSync(`sha256/${refB.sha256}`)).not.toBeNull();

    // DbStateStore isolates plugin_state_logs rows per kernelId
    const owner: OwnerParts = {
      plugin: "notes-plugin",
      scope: "global",
      scopeId: "kernel",
      namespace: "prefs",
    };
    const storeA = new DbStateStore({ db, kernelId: "tenant-a", sessionRoot: () => undefined });
    const storeB = new DbStateStore({ db, kernelId: "tenant-b", sessionRoot: () => undefined });
    storeA.save(owner, [jsonToVal(["alpha"])]);
    storeB.save(owner, [jsonToVal(["beta"])]);
    await Promise.all([storeA.flush(), storeB.flush()]);
    expect(storeA.load(owner)).not.toEqual(storeB.load(owner));
    expect(await db.scan("plugin_state_logs", { where: { kernelId: "tenant-a" } })).toHaveLength(1);
    expect(await db.scan("plugin_state_logs", { where: { kernelId: "tenant-b" } })).toHaveLength(1);

    leaseA[Symbol.dispose]();
    leaseB[Symbol.dispose]();
  });

  it("handles idle eviction, TTL auto-eviction, coalesced acquire-during-evict, and cold re-hydration from shared DB", async () => {
    const db = new SqliteKvStore(":memory:");
    const laneHub = new UpdateLaneHub(db);
    const registry = new MultiKernelRegistry({
      db,
      ownsDb: false,
      laneHub,
      ownsLaneHub: false,
      idleEvictMs: 25,
    });
    onTestFinished(async () => {
      await registry[Symbol.asyncDispose]();
      laneHub.dispose();
      await db.close();
    });

    const leaseA1 = await registry.acquire("tenant-a");
    const leaseB = await registry.acquire("tenant-b");
    const firstKernelA = leaseA1.kernel;

    await firstKernelA.handleRequest("config/set", { defaultPermissionMode: "yolo" });
    firstKernelA.addPersistentGrant(makeGlobalCommandGrant("grant-cold", "npm"));
    firstKernelA.writeKvs([{ form: "kv-set", key: "model", value: "cold-model" }]);

    const projA = firstKernelA.project("kley://persisted-ws");
    await projA.ready;
    const sessA = await projA.session("sess-cold-1");
    runInAction(() => {
      sessA.root.manualTitle = "Survives Eviction";
      sessA.root.projectId = "proj-cold";
    });
    await firstKernelA.flushSession(sessA.doc, { force: true });
    await firstKernelA.flushKernel({ force: true });

    // Park session and verify active lease blocks eviction
    await sessA.park();
    expect(await registry.evict("tenant-a")).toBe(false);
    expect(registry.has("tenant-a")).toBe(true);

    // Release lease -> TTL idle timer automatically evicts tenant-a while tenant-b stays alive
    leaseA1[Symbol.dispose]();
    await vi.waitFor(() => {
      expect(registry.has("tenant-a")).toBe(false);
    });
    expect(firstKernelA.disposed).toBe(true);
    expect(leaseB.kernel.disposed).toBe(false);
    await expect(db.count("sessions")).resolves.toBeGreaterThanOrEqual(0);

    // Re-acquire tenant-a -> cold re-hydrates full state from SQLite
    const leaseA2 = await registry.acquire("tenant-a");
    const restoredKernelA = leaseA2.kernel;
    expect(restoredKernelA).not.toBe(firstKernelA);
    expect(restoredKernelA.doc.root.defaultPermissionMode).toBe("yolo");
    expect(restoredKernelA.persistentGrants().map((g) => g.id)).toEqual(["grant-cold"]);
    expect(restoredKernelA.doc.root.kvs.model).toBe("cold-model");
    expect(restoredKernelA.hasProject("kley://persisted-ws")).toBe(true);

    const restoredDoc = await restoredKernelA.acquireSession("sess-cold-1");
    expect(restoredDoc?.root.title).toBe("Survives Eviction");
    expect(restoredDoc?.root.projectId).toBe("proj-cold");

    // Coalesce concurrent acquire() while evict() is in-flight
    leaseA2[Symbol.dispose]();
    const evicting = registry.evict("tenant-a");
    const reacquired = registry.acquire("tenant-a");
    const [evicted, leaseA3] = await Promise.all([evicting, reacquired]);
    expect(evicted).toBe(true);
    expect(leaseA3.kernel.disposed).toBe(false);
    expect(leaseA3.kernel).not.toBe(restoredKernelA);

    await leaseA3[Symbol.asyncDispose]();
    await leaseB[Symbol.asyncDispose]();
  });

  it("cascades Symbol.asyncDispose idempotently and respects ownsDb", async () => {
    const sharedDb = new SqliteKvStore(":memory:");
    const regNoOwn = new MultiKernelRegistry({ db: sharedDb, ownsDb: false });
    const lease1 = await regNoOwn.acquire("t-1");
    const kernel1 = lease1.kernel;
    lease1[Symbol.dispose]();

    await Promise.all([regNoOwn[Symbol.asyncDispose](), regNoOwn[Symbol.asyncDispose]()]);
    expect(regNoOwn.disposed).toBe(true);
    expect(kernel1.disposed).toBe(true);
    await expect(sharedDb.count("sessions")).resolves.toBeGreaterThanOrEqual(0);
    await expect(regNoOwn.acquire("t-2")).rejects.toThrow(/disposed/);

    const regOwn = new MultiKernelRegistry({ db: sharedDb, ownsDb: true });
    const lease2 = await regOwn.acquire("t-2");
    const kernel2 = lease2.kernel;
    lease2[Symbol.dispose]();

    await regOwn[Symbol.asyncDispose]();
    expect(kernel2.disposed).toBe(true);
    await expect(sharedDb.count("sessions")).rejects.toThrow(/closed/);
  });

  it("isolates per-kernel stores with resolveStore, deduplicates concurrent acquires, and closes owned stores on eviction", async () => {
    const storeA = new MemoryKvStore();
    const storeB = new MemoryKvStore();
    const resolveStore = vi.fn(async (kernelId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return kernelId.startsWith("tenant-a:")
        ? { db: storeA, laneHub: new CommitDiffShapeSource(storeA), ownsDb: true, ownsLaneHub: true }
        : { db: storeB, laneHub: new CommitDiffShapeSource(storeB), ownsDb: false, ownsLaneHub: true };
    });

    const registry = new MultiKernelRegistry({ resolveStore });
    onTestFinished(async () => {
      await registry[Symbol.asyncDispose]();
      await storeB.close();
    });

    const [leaseA1, leaseA2, leaseB] = await Promise.all([
      registry.acquire("tenant-a:user-1"),
      registry.acquire("tenant-a:user-1"),
      registry.acquire("tenant-b:user-2"),
    ]);

    expect(leaseA1.kernel).toBe(leaseA2.kernel);
    expect(resolveStore).toHaveBeenCalledTimes(2);
    expect(leaseA1.kernel.db).toBe(storeA);
    expect(leaseB.kernel.db).toBe(storeB);

    const projA = leaseA1.kernel.project("/virtual/tenant-a/ws");
    await projA.ready;
    const sessA = await projA.session("sess-iso-a");
    await leaseA1.kernel.flushSession(sessA.doc, { force: true });

    expect((await storeA.scan("sessions")).length).toBe(1);
    expect((await storeB.scan("sessions")).length).toBe(0);

    await sessA.park();
    leaseA1[Symbol.dispose]();
    leaseA2[Symbol.dispose]();
    expect(await registry.evict("tenant-a:user-1")).toBe(true);
    await expect(storeA.scan("sessions")).rejects.toThrow(/closed/);
    await expect(storeB.scan("sessions")).resolves.toEqual([]);

    leaseB[Symbol.dispose]();
  });
});
