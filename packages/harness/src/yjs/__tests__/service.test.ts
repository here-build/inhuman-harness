import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { afterEach, describe, expect, it } from "vitest";

import { documentKey, receiptCoversCheckpoint } from "@/protocol/document";

import { DocumentService } from "../document-service.js";
import { documentGuid, documentImagePath } from "../registry/identity.js";
import { DocumentImageStore } from "../storage.js";
import { encodeLogEntry } from "../update-log.js";

@model("test:service:root")
class ServiceTestRoot extends Model {
  @state accessor sessionId: string = "";
  @state accessor extra: string = "";
  @state accessor body: string = "";
  @state accessor tail: number = 0;
  @state accessor k: string = "";
  @state accessor later: boolean = false;
  @state accessor live: boolean = false;
  @state accessor blob: string = "";
  @state accessor tick: number = 0;
  @state.list accessor churn: string[] = [];
  @state accessor overflow: string = "";
  @state accessor more: string = "";
}

const temps: string[] = [];
const modes: Array<{ path: string; mode: number }> = [];

afterEach(() => {
  for (const entry of modes.splice(0)) {
    try {
      chmodSync(entry.path, entry.mode);
    } catch {}
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-service-"));
  temps.push(root);
  return root;
}

function encodeSession(sessionId: string, extra?: string): Uint8Array {
  const root = new ServiceTestRoot();
  root.sessionId = sessionId;
  if (extra != null) root.extra = extra;
  const doc = new DocumentContainer(root);
  const bytes = doc.encodeStateAsUpdate();
  doc.destroy();
  return bytes;
}

function writeSession(root: string, sessionId: string): string {
  const path = documentImagePath(root, "sessions", sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeLogEntry(encodeSession(sessionId)));
  return path;
}

function blobUpdate(name: string, size: number): Uint8Array {
  const root = new ServiceTestRoot();
  (root as any)[name] = "x".repeat(size);
  const doc = new DocumentContainer(root);
  const bytes = doc.encodeStateAsUpdate();
  doc.destroy();
  return bytes;
}

describe("document service", () => {
  it("a forced flush replaces the image with a snapshot, with updates pending and with none", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const key = documentKey("sessions", "s-forced");
    const created = await service.create(key, encodeSession("s-forced"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const path = documentImagePath(root, "sessions", "s-forced");
    const map = created.ref.doc.root as ServiceTestRoot;
    map.body = "x".repeat(300_000);
    const ordinary = await service.flush(key, service.checkpoint(key)!);
    const withBody = statSync(path).size;
    // The body is replaced; the update that does it is small and an ordinary flush appends it.
    map.body = "short";
    const appended = await service.flush(key, service.checkpoint(key)!);
    const afterAppend = statSync(path).size;
    // Nothing is pending, so an ordinary flush writes nothing. A forced one still writes the snapshot.
    const idle = await service.flush(key, service.checkpoint(key)!);
    const afterIdle = statSync(path).size;
    const forced = await service.flush(key, service.checkpoint(key)!, { force: true });
    const afterForced = statSync(path).size;
    const restored = new DocumentContainer(new ServiceTestRoot());
    const disk = await new DocumentImageStore(root).read(key);
    if (disk != null) restored.applyUpdate(disk);
    expect({
      ok: [ordinary.ok, appended.ok, idle.ok, forced.ok],
      grew: afterAppend > withBody,
      idleLeftFileAlone: afterIdle === afterAppend,
      forcedShrank: afterForced < 10_000,
      body: restored.root.body,
    }).toEqual({
      ok: [true, true, true, true],
      grew: true,
      idleLeftFileAlone: true,
      forcedShrank: true,
      body: "short",
    });
    restored.destroy();
    service.release(key);
  });

  it("a forced flush with updates still pending covers them", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const key = documentKey("sessions", "s-forced-pending");
    const created = await service.create(key, encodeSession("s-forced-pending"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const map = created.ref.doc.root as ServiceTestRoot;
    map.body = "x".repeat(300_000);
    await service.flush(key, service.checkpoint(key)!);
    map.body = "short";
    map.tail = 1;
    const checkpoint = service.checkpoint(key)!;
    const forced = await service.flush(key, checkpoint, { force: true });
    const restored = new DocumentContainer(new ServiceTestRoot());
    const disk = await new DocumentImageStore(root).read(key);
    if (disk != null) restored.applyUpdate(disk);
    expect({
      ok: forced.ok,
      covers: forced.ok && receiptCoversCheckpoint(forced.receipt, checkpoint),
      size: statSync(documentImagePath(root, "sessions", "s-forced-pending")).size < 10_000,
      body: restored.root.body,
      tail: restored.root.tail,
      dirty: service.memory().dirtyBytes,
    }).toEqual({ ok: true, covers: true, size: true, body: "short", tail: 1, dirty: 0 });
    restored.destroy();
    service.release(key);
  });

  it("flush receipt covers the captured prefix, not a later mutation", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const key = documentKey("sessions", "s1");
    const created = await service.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.ref.doc.guid).toBe(documentGuid(key));
    const applied = service.applyUpdate(key, blobUpdate("k", 8));
    const checkpoint = service.checkpoint(key)!;
    const flushP = service.flush(key, checkpoint);
    (created.ref.doc.root as ServiceTestRoot).later = true;
    const result = await flushP;
    const store = new DocumentImageStore(root);
    const disk = result.ok ? await store.read(key) : undefined;
    const restored = new DocumentContainer(new ServiceTestRoot());
    if (disk != null) restored.applyUpdate(disk);
    expect({
      applied: applied.ok,
      ok: result.ok,
      covers: result.ok && result.receipt.revision === checkpoint.revision,
      kept: restored.root.k.length > 0,
      later: restored.root.later,
    }).toEqual({ applied: true, ok: true, covers: true, kept: true, later: false });
    restored.destroy();
    service.release(key);
  });

  it("list cut stays stable while create publishes another identity", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root, pageSize: 1 });
    await service.create(documentKey("sessions", "a"), encodeSession("a"));
    await service.create(documentKey("sessions", "b"), encodeSession("b"));
    const first = await service.list({ kind: "sessions", cursor: null });
    await service.create(documentKey("sessions", "c"), encodeSession("c"));
    const rest = await service.list({
      kind: "sessions",
      cursor: first.cursor,
    });
    expect({
      first: first.entries.map((row) => row.key.id),
      rest: rest.entries.map((row) => row.key.id),
      cut: first.checkpoint.cut === rest.checkpoint.cut,
    }).toEqual({
      first: ["a"],
      rest: ["b"],
      cut: true,
    });
  });

  it("reports corrupt and empty files as inventory errors", async () => {
    const root = tempRoot();
    const path = writeSession(root, "s1");
    writeFileSync(path, Buffer.from([0, 1, 2, 3]));
    const service = new DocumentService({ root });
    const page = await service.list({ kind: "sessions", cursor: null });
    expect({
      entries: page.entries.map((row) => row.key.id),
      errors: service.inventoryErrors().map((row) => row.reason),
    }).toEqual({
      entries: [],
      errors: ["corrupt"],
    });
  });

  it("failed flush preserves dirty bytes, keeps the loaded ref, and does not claim success", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const store = new DocumentImageStore(root);
    const key = documentKey("sessions", "s1");
    const created = await service.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    service.applyUpdate(key, blobUpdate("k", 8));
    const firstFlush = await service.flush(key, service.checkpoint(key)!);
    expect(firstFlush.ok).toBe(true);
    const saved = await store.read(key);

    service.applyUpdate(key, blobUpdate("k", 16));
    const image = store.pathFor(key);
    modes.push({ path: image, mode: 0o600 });
    chmodSync(image, 0o400);
    const checkpoint = service.checkpoint(key)!;
    const failed = await service.flush(key, checkpoint);
    chmodSync(image, 0o600);
    const disk = await store.read(key);
    expect({
      failed,
      coversDirty: failed.ok && receiptCoversCheckpoint(failed.receipt, checkpoint),
      disk: disk == null ? undefined : [...disk],
      live: (created.ref.doc.root as ServiceTestRoot).k.length > 0,
      loaded: service.getLoaded(key)?.doc === created.ref.doc,
      dirty: service.memory().dirtyBytes > 0,
    }).toEqual({
      failed: { ok: false, reason: "storage-failed" },
      coversDirty: false,
      disk: saved == null ? undefined : [...saved],
      live: true,
      loaded: true,
      dirty: true,
    });
    service.release(key);
    expect(service.getLoaded(key)?.doc).toBe(created.ref.doc);
  });

  it("a flush after heavy churn appends its delta, not the whole delete set, and compacts past the bound", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const store = new DocumentImageStore(root);
    const key = documentKey("sessions", "s1");
    const created = await service.create(key, encodeSession("s1"));
    if (!created.ok) throw new Error("create failed");
    const targetRoot = created.ref.doc.root as ServiceTestRoot;
    for (let round = 0; round < 2000; round += 1) {
      created.ref.doc.transact(() => {
        targetRoot.churn.push(`gone-${round}`, `kept-${round}`);
        targetRoot.churn.splice(targetRoot.churn.length - 2, 1);
      });
      if (round % 50 === 0) await service.flush(key, service.checkpoint(key)!);
    }
    await service.flush(key, service.checkpoint(key)!);
    const path = store.pathFor(key);
    const churned = statSync(path).size;
    const deleteSetBytes = created.ref.doc.encodeStateAsUpdate().byteLength;
    created.ref.doc.transact(() => {
      targetRoot.tick = 1;
    });
    await service.flush(key, service.checkpoint(key)!);
    const tickEntry = statSync(path).size - churned;

    for (let round = 0; round < 400; round += 1) {
      created.ref.doc.transact(() => {
        targetRoot.blob = "x".repeat(8192) + round;
      });
      await service.flush(key, service.checkpoint(key)!);
    }
    const bounded = statSync(path).size;
    const merged = created.ref.doc.encodeStateAsUpdate().byteLength;
    const restored = new DocumentContainer(new ServiceTestRoot());
    restored.applyUpdate((await store.read(key))!);
    expect({
      tickSmall: tickEntry < 200,
      deleteSetLarge: deleteSetBytes > 2000,
      withinBound: bounded <= Math.max(2 * merged, 1 << 20) + 16_384,
      tick: restored.root.tick,
      churnRows: restored.root.churn.length,
    }).toEqual({ tickSmall: true, deleteSetLarge: true, withinBound: true, tick: 1, churnRows: 2000 });
    restored.destroy();
    service.release(key);
  });

  it("create is idempotent and does not overwrite a restored image", async () => {
    const root = tempRoot();
    const service = new DocumentService({ root });
    const key = documentKey("sessions", "s1");
    const first = await service.create(key, encodeSession("s1", "keep"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    (first.ref.doc.root as ServiceTestRoot).live = true;
    const second = await service.create(key, encodeSession("s1", "other"));
    expect({
      same: second.ok && second.ref.doc === first.ref.doc,
      live: (first.ref.doc.root as ServiceTestRoot).live,
      extra: (first.ref.doc.root as ServiceTestRoot).extra,
    }).toEqual({
      same: true,
      live: true,
      extra: "keep",
    });
    service.release(key);
    service.release(key);
  });

  it("openExisting of a missing identity is not-found", async () => {
    const service = new DocumentService({ root: tempRoot() });
    expect(await service.openExisting(documentKey("sessions", "missing"))).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("memory budgets", () => {
  it("rejects an overflowing apply and keeps the admitted prefix", async () => {
    const root = tempRoot();
    const service = new DocumentService({
      root,
      budgets: { perDocumentDirty: 800, aggregateDirty: 50_000 },
    });
    const key = documentKey("sessions", "s1");
    const created = await service.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = service.applyUpdate(key, blobUpdate("blob", 200));
    const second = service.applyUpdate(key, blobUpdate("overflow", 4000));
    expect({
      first: first.ok,
      second,
      blob: (created.ref.doc.root as ServiceTestRoot).blob.length > 0,
      overflow: (created.ref.doc.root as ServiceTestRoot).overflow.length > 0,
      dirty: service.memory().dirtyBytes > 0,
    }).toEqual({
      first: true,
      second: { ok: false, reason: "overload" },
      blob: true,
      overflow: false,
      dirty: true,
    });
    service.release(key);
  });

  it("stops create and further writes once aggregate dirty is at the cap", async () => {
    const root = tempRoot();
    const service = new DocumentService({
      root,
      budgets: { perDocumentDirty: 50_000, aggregateDirty: 400 },
    });
    const key = documentKey("sessions", "a");
    const created = await service.create(key, encodeSession("a"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    (created.ref.doc.root as ServiceTestRoot).blob = "x".repeat(2000);
    const other = await service.create(documentKey("sessions", "b"), encodeSession("b"));
    const write = service.applyUpdate(key, blobUpdate("more", 8));
    expect({
      admission: service.memory().writeAdmission,
      other,
      write,
      kept: (created.ref.doc.root as ServiceTestRoot).blob,
      loaded: service.getLoaded(key)?.doc === created.ref.doc,
    }).toEqual({
      admission: "stopped",
      other: { ok: false, reason: "overload" },
      write: { ok: false, reason: "overload" },
      kept: "x".repeat(2000),
      loaded: true,
    });
    service.release(key);
  });

  it("refuses a new pin at the identity cap without dropping the resident", async () => {
    const root = tempRoot();
    const service = new DocumentService({
      root,
      budgets: { pinCount: 1, aggregateResident: 50_000 },
    });
    const a = documentKey("sessions", "a");
    const created = await service.create(a, encodeSession("a"));
    const extra = await service.create(documentKey("sessions", "b"), encodeSession("b"));
    const again = await service.openExisting(a);
    expect({
      created: created.ok,
      extra,
      again: again.ok && created.ok && again.ref.doc === created.ref.doc,
      pins: service.memory().pinCount,
    }).toEqual({
      created: true,
      extra: { ok: false, reason: "overload" },
      again: true,
      pins: 1,
    });
    if (created.ok) {
      service.release(a);
      service.release(a);
    }
  });

  it("refuses a cold open that would exceed resident bytes", async () => {
    const root = tempRoot();
    writeSession(root, "tiny");
    const hugePath = documentImagePath(root, "sessions", "huge");
    mkdirSync(dirname(hugePath), { recursive: true });
    writeFileSync(hugePath, encodeLogEntry(encodeSession("huge", "x".repeat(8000))));
    const service = new DocumentService({
      root,
      budgets: { aggregateResident: 600, pinCount: 8 },
    });
    const tiny = await service.openExisting(documentKey("sessions", "tiny"));
    const huge = await service.openExisting(documentKey("sessions", "huge"));
    expect({
      tiny: tiny.ok,
      huge,
      pins: service.memory().pinCount,
    }).toEqual({
      tiny: true,
      huge: { ok: false, reason: "overload" },
      pins: 1,
    });
    if (tiny.ok) service.release(tiny.ref.key);
  });

  it("flushes, releases a clean replica, then admits another identity at pinCount 1", async () => {
    const root = tempRoot();
    const service = new DocumentService({
      root,
      budgets: { pinCount: 1, aggregateResident: 50_000 },
    });
    const a = documentKey("sessions", "a");
    const created = await service.create(a, encodeSession("a"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const flushed = await service.flush(a, service.checkpoint(a)!);
    service.release(a);
    const second = await service.create(documentKey("sessions", "b"), encodeSession("b"));
    expect({
      flushed: flushed.ok,
      afterRelease: service.getLoaded(a),
      second: second.ok,
      pins: service.memory().pinCount,
      dirty: service.memory().dirtyBytes,
    }).toEqual({
      flushed: true,
      afterRelease: undefined,
      second: true,
      pins: 1,
      dirty: 0,
    });
    if (second.ok) service.release(second.ref.key);
  });

  it("concurrent create and openExisting honor pinCount 1", async () => {
    const root = tempRoot();
    writeSession(root, "x");
    writeSession(root, "y");
    const createService = new DocumentService({
      root: tempRoot(),
      budgets: { pinCount: 1, aggregateResident: 50_000 },
    });
    const createLeft = createService.create(documentKey("sessions", "a"), encodeSession("a"));
    const createRight = createService.create(documentKey("sessions", "b"), encodeSession("b"));
    const created = [await createLeft, await createRight];
    const openService = new DocumentService({
      root,
      budgets: { pinCount: 1, aggregateResident: 50_000 },
    });
    const openLeft = openService.openExisting(documentKey("sessions", "x"));
    const openRight = openService.openExisting(documentKey("sessions", "y"));
    const opened = [await openLeft, await openRight];
    const createdOk = created.filter((row) => row.ok);
    const createdFail = created.filter((row) => !row.ok);
    const openedOk = opened.filter((row) => row.ok);
    const openedFail = opened.filter((row) => !row.ok);
    expect({
      createdOk: createdOk.length,
      createdFail,
      createdPins: createService.memory().pinCount,
      openedOk: openedOk.length,
      openedFail,
      openedPins: openService.memory().pinCount,
    }).toEqual({
      createdOk: 1,
      createdFail: [{ ok: false, reason: "overload" }],
      createdPins: 1,
      openedOk: 1,
      openedFail: [{ ok: false, reason: "overload" }],
      openedPins: 1,
    });
    for (const row of created) {
      if (row.ok) createService.release(row.ref.key);
    }
    for (const row of opened) {
      if (row.ok) openService.release(row.ref.key);
    }
  });
});
