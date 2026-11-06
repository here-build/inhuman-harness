import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { afterEach, describe, expect, it } from "vitest";

import { checkpointOf, documentImageSegments, encodeDocUpdate, receiptCoversCheckpoint } from "@/protocol/document";

import { DocumentImageStore, documentImagePath } from "../storage.js";
import { encodeLogEntry } from "../update-log.js";

@model("test:storage:root")
class StorageTestRoot extends Model {
  @state accessor k: string = "";
  @state accessor later: boolean = false;
  @state accessor first: number = 0;
  @state accessor second: number = 0;
  @state accessor head: boolean = false;
  @state accessor tail: number = 0;
  @state accessor body: string = "";
  @state accessor kept: string = "";
  @state accessor bare: boolean = false;
}

const roots: string[] = [];
const modes: Array<{ path: string; mode: number }> = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-image-"));
  roots.push(root);
  return root;
}

function snapshot(doc: DocumentContainer<StorageTestRoot>, id: string, revision: number) {
  const key = { kind: "sessions" as const, id };
  return {
    key,
    image: doc.encodeStateAsUpdate(),
    checkpoint: checkpointOf(doc, key, 3, revision),
  };
}

afterEach(() => {
  for (const entry of modes.splice(0)) {
    try {
      chmodSync(entry.path, entry.mode);
    } catch {}
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("document image store", () => {
  it("flush success returns a receipt covering the exact captured prefix", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const doc = new DocumentContainer(new StorageTestRoot());
    doc.root.k = "v";
    const { key, image, checkpoint } = snapshot(doc, "s1", 10);
    doc.root.later = true;
    const result = await store.flush({
      checkpoint,
      image,
      runtimeGeneration: 2,
      connectionEpoch: 1,
    });
    const disk = result.ok ? await store.read(key) : undefined;
    const later = doc.encodeStateAsUpdate();
    expect({
      path: documentImagePath(store.root, key),
      ok: result.ok,
      covers: result.ok && receiptCoversCheckpoint(result.receipt, checkpoint),
      prefix: result.ok ? [...result.receipt.prefix] : [],
      disk: disk == null ? undefined : [...disk],
    }).toEqual({
      path: join(store.root, ...documentImageSegments("sessions", "s1")),
      ok: true,
      covers: true,
      prefix: [...encodeDocUpdate(image)],
      disk: [...image],
    });
    expect(disk == null ? undefined : [...disk]).not.toEqual([...later]);
    doc.destroy();
  });

  it("failed write does not claim success from a local mutation", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const first = new DocumentContainer(new StorageTestRoot());
    first.root.k = "v1";
    const saved = snapshot(first, "s1", 1);
    const savedResult = await store.flush({
      checkpoint: saved.checkpoint,
      image: saved.image,
      runtimeGeneration: 0,
      connectionEpoch: 0,
    });
    expect(savedResult.ok).toBe(true);

    const image = store.pathFor(saved.key);
    modes.push({ path: image, mode: 0o600 });
    chmodSync(image, 0o400);

    const next = new DocumentContainer(new StorageTestRoot());
    next.root.k = "v2";
    const dirty = snapshot(next, "s1", 2);
    const failed = await store.flush({
      checkpoint: dirty.checkpoint,
      image: dirty.image,
      runtimeGeneration: 0,
      connectionEpoch: 0,
    });
    chmodSync(image, 0o600);
    const after = store.pathFor(saved.key);
    const disk = await store.read(saved.key);
    expect({
      path: after,
      ok: failed.ok,
      disk: disk == null ? undefined : [...disk],
    }).toEqual({
      path: image,
      ok: false,
      disk: [...saved.image],
    });
    first.destroy();
    next.destroy();
  });

  it("reports failure when the directory cannot be made", async () => {
    const root = tmpRoot();
    const blocker = join(root, "documents");
    writeFileSync(blocker, "i-am-a-file");
    const store = new DocumentImageStore(root);
    const doc = new DocumentContainer(new StorageTestRoot());
    const { image, checkpoint } = snapshot(doc, "s1", 1);
    const result = await store.flush({
      checkpoint,
      image,
      runtimeGeneration: 1,
      connectionEpoch: 1,
    });
    expect({
      result,
      parentIsFile: statSync(join(root, "documents")).isFile(),
      covers: result.ok && receiptCoversCheckpoint(result.receipt, checkpoint),
    }).toEqual({
      result: { ok: false, reason: "storage-failed" },
      parentIsFile: true,
      covers: false,
    });
    doc.destroy();
  });

  it("serializes flushes of the same key and keeps the later durable image", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const first = new DocumentContainer(new StorageTestRoot());
    first.root.first = 1;
    const a = snapshot(first, "s1", 1);
    let delta: Uint8Array = new Uint8Array([0, 0]);
    first.on("update", (u) => {
      delta = u;
    });
    first.root.second = 2;
    const b = {
      key: a.key,
      image: delta,
      checkpoint: checkpointOf(first, a.key, 3, 2),
    };
    const leftP = store.flush({
      checkpoint: a.checkpoint,
      image: a.image,
      runtimeGeneration: 1,
      connectionEpoch: 1,
    });
    const rightP = store.flush({
      checkpoint: b.checkpoint,
      image: b.image,
      runtimeGeneration: 1,
      connectionEpoch: 1,
    });
    const left = await leftP;
    const right = await rightP;
    const disk = await store.read(a.key);
    const restored = new DocumentContainer(new StorageTestRoot());
    if (disk != null) restored.applyUpdate(disk);
    expect({
      leftOk: left.ok,
      rightOk: right.ok,
      leftCovers: left.ok && receiptCoversCheckpoint(left.receipt, a.checkpoint),
      rightCovers: right.ok && receiptCoversCheckpoint(right.receipt, b.checkpoint),
      both: restored.root.first === 1 && restored.root.second === 2,
    }).toEqual({
      leftOk: true,
      rightOk: true,
      leftCovers: true,
      rightCovers: true,
      both: true,
    });
    restored.destroy();
    first.destroy();
  });

  it("appends after a snapshot without rewriting the prefix", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const head = new DocumentContainer(new StorageTestRoot());
    head.root.head = true;
    const bare = head.encodeStateAsUpdate();
    const key = { kind: "sessions" as const, id: "s1" };
    const path = store.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodeLogEntry(bare));

    let firstDelta: Uint8Array = new Uint8Array([0, 0]);
    head.on("update", (u) => {
      firstDelta = u;
    });
    head.root.tail = 1;
    let secondDelta: Uint8Array = new Uint8Array([0, 0]);
    head.on("update", (u) => {
      secondDelta = u;
    });
    head.root.tail = 2;
    const firstFlush = store.flush({
      checkpoint: snapshot(head, "s1", 2).checkpoint,
      image: firstDelta,
      runtimeGeneration: 1,
      connectionEpoch: 1,
    });
    const secondFlush = store.flush({
      checkpoint: snapshot(head, "s1", 3).checkpoint,
      image: secondDelta,
      runtimeGeneration: 1,
      connectionEpoch: 1,
    });
    const [firstResult, secondResult] = await Promise.all([firstFlush, secondFlush]);
    const appended = readFileSync(path);
    const disk = await store.read(key);
    const restored = new DocumentContainer(new StorageTestRoot());
    if (disk != null) restored.applyUpdate(disk);
    const compacted = readFileSync(path);
    expect({
      firstOk: firstResult.ok,
      secondOk: secondResult.ok,
      tail: restored.root.tail,
      head: restored.root.head,
      prefixKept:
        Buffer.compare(appended.subarray(0, encodeLogEntry(bare).byteLength), Buffer.from(encodeLogEntry(bare))) === 0,
      grew: appended.byteLength > bare.byteLength,
      oneEntry: compacted.readUInt32BE(0) + 4 === compacted.byteLength,
    }).toEqual({
      firstOk: true,
      secondOk: true,
      tail: 2,
      head: true,
      prefixKept: true,
      grew: true,
      oneEntry: true,
    });
    restored.destroy();
    head.destroy();
  });

  describe("a forced flush", () => {
    /** A document whose log holds a 200 KB body, then a short replacement: the log still carries the body. */
    async function logWithDeadBody() {
      const store = new DocumentImageStore(tmpRoot());
      const doc = new DocumentContainer(new StorageTestRoot());
      const key = { kind: "sessions" as const, id: "vacuumed" };
      doc.root.body = "x".repeat(200_000);
      doc.root.kept = "yes";
      const first = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 1).checkpoint,
        image: doc.encodeStateAsUpdate(),
        snapshot: () => doc.encodeStateAsUpdate(),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      let delta: Uint8Array = new Uint8Array([0, 0]);
      doc.on("update", (u) => {
        delta = u;
      });
      doc.root.body = "short";
      return { store, doc, key, first, delta };
    }

    it("replaces the log with one snapshot, where an ordinary flush only appends", async () => {
      const { store, doc, key, first, delta } = await logWithDeadBody();
      const path = store.pathFor(key);
      const afterFirst = statSync(path).size;
      const appended = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 2).checkpoint,
        image: delta,
        snapshot: () => doc.encodeStateAsUpdate(),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const afterAppend = statSync(path).size;
      const forced = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 3).checkpoint,
        image: new Uint8Array([0, 0]),
        snapshot: () => doc.encodeStateAsUpdate(),
        force: true,
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const file = readFileSync(path);
      const restored = new DocumentContainer(new StorageTestRoot());
      const disk = await store.read(key);
      if (disk != null) restored.applyUpdate(disk);
      expect({
        ok: [first.ok, appended.ok, forced.ok],
        appendGrew: afterAppend > afterFirst,
        forcedShrank: file.byteLength < 1_000,
        oneEntry: file.readUInt32BE(0) + 4 === file.byteLength,
        body: restored.root.body,
        kept: restored.root.kept,
      }).toEqual({
        ok: [true, true, true],
        appendGrew: true,
        forcedShrank: true,
        oneEntry: true,
        body: "short",
        kept: "yes",
      });
      restored.destroy();
      doc.destroy();
    });

    it("leaves no temp file behind, and appends again afterwards", async () => {
      const { store, doc, key } = await logWithDeadBody();
      const path = store.pathFor(key);
      await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 2).checkpoint,
        image: new Uint8Array([0, 0]),
        snapshot: () => doc.encodeStateAsUpdate(),
        force: true,
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const snapshotBytes = statSync(path).size;
      let laterDelta: Uint8Array = new Uint8Array([0, 0]);
      doc.on("update", (u) => {
        laterDelta = u;
      });
      doc.root.later = true;
      await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 3).checkpoint,
        image: laterDelta,
        snapshot: () => doc.encodeStateAsUpdate(),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const afterAppendBytes = statSync(path).size;
      const restored = new DocumentContainer(new StorageTestRoot());
      const disk = await store.read(key);
      if (disk != null) restored.applyUpdate(disk);
      expect({
        siblings: readdirSync(dirname(path)),
        grew: afterAppendBytes > snapshotBytes,
        later: restored.root.later,
      }).toEqual({ siblings: [basename(path)], grew: true, later: true });
      restored.destroy();
      doc.destroy();
    });

    it("is honored only with a snapshot to write: without one the image is appended", async () => {
      const { store, doc, key, delta } = await logWithDeadBody();
      const path = store.pathFor(key);
      const before = statSync(path).size;
      const result = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 2).checkpoint,
        image: delta,
        force: true,
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      expect({ ok: result.ok, grew: statSync(path).size > before }).toEqual({ ok: true, grew: true });
      doc.destroy();
    });
  });

  it("reads a bare snapshot that has no length prefix", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const head = new DocumentContainer(new StorageTestRoot());
    head.root.bare = true;
    const key = { kind: "sessions" as const, id: "legacy" };
    const path = store.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, head.encodeStateAsUpdate());
    const disk = await store.read(key);
    const restored = new DocumentContainer(new StorageTestRoot());
    if (disk != null) restored.applyUpdate(disk);
    expect(restored.root.bare).toBe(true);
    restored.destroy();
    head.destroy();
  });
});
