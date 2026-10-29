import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { checkpointOf, documentImageSegments, encodeDocUpdate, receiptCoversCheckpoint } from "@/protocol/document";

import { DocumentImageStore, documentImagePath } from "../storage.js";
import { encodeLogEntry } from "../update-log.js";

const roots: string[] = [];
const modes: Array<{ path: string; mode: number }> = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-image-"));
  roots.push(root);
  return root;
}

function snapshot(doc: Y.Doc, id: string, revision: number) {
  const key = { kind: "sessions" as const, id };
  return {
    key,
    image: Y.encodeStateAsUpdate(doc),
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
    const doc = new Y.Doc();
    doc.getMap("root").set("k", "v");
    const { key, image, checkpoint } = snapshot(doc, "s1", 10);
    doc.getMap("root").set("later", true);
    const result = await store.flush({
      checkpoint,
      image,
      runtimeGeneration: 2,
      connectionEpoch: 1,
    });
    const disk = result.ok ? await store.read(key) : undefined;
    const later = Y.encodeStateAsUpdate(doc);
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
    const first = new Y.Doc();
    first.getMap("root").set("k", "v1");
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

    const next = new Y.Doc();
    next.getMap("root").set("k", "v2");
    const dirty = snapshot(next, "s1", 2);
    const failed = await store.flush({
      checkpoint: dirty.checkpoint,
      image: dirty.image,
      runtimeGeneration: 0,
      connectionEpoch: 0,
    });
    chmodSync(image, 0o600);
    const disk = await store.read(saved.key);
    expect({
      failed,
      coversDirty: failed.ok && receiptCoversCheckpoint(failed.receipt, dirty.checkpoint),
      disk: disk == null ? undefined : [...disk],
    }).toEqual({
      failed: { ok: false, reason: "storage-failed" },
      coversDirty: false,
      disk: [...saved.image],
    });
    first.destroy();
    next.destroy();
  });

  it("a first write that cannot reach disk leaves no image", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "documents"), "not a directory");
    const store = new DocumentImageStore(root);
    const doc = new Y.Doc();
    doc.getMap("root").set("k", "v");
    const { image, checkpoint } = snapshot(doc, "s1", 1);
    const result = await store.flush({
      checkpoint,
      image,
      runtimeGeneration: 0,
      connectionEpoch: 0,
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
    const first = new Y.Doc();
    first.getMap("root").set("first", 1);
    const second = new Y.Doc();
    second.getMap("root").set("second", 2);
    const a = snapshot(first, "s1", 1);
    const b = snapshot(second, "s1", 2);
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
    const restored = new Y.Doc();
    if (disk != null) Y.applyUpdate(restored, disk);
    const seen = new Set(restored.getMap("root").keys());
    expect({
      leftOk: left.ok,
      rightOk: right.ok,
      leftCovers: left.ok && receiptCoversCheckpoint(left.receipt, a.checkpoint),
      rightCovers: right.ok && receiptCoversCheckpoint(right.receipt, b.checkpoint),
      both: seen.has("first") && seen.has("second"),
    }).toEqual({
      leftOk: true,
      rightOk: true,
      leftCovers: true,
      rightCovers: true,
      both: true,
    });
    restored.destroy();
    first.destroy();
    second.destroy();
  });

  it("appends after a snapshot without rewriting the prefix", async () => {
    const store = new DocumentImageStore(tmpRoot());
    const head = new Y.Doc();
    head.getMap("root").set("head", true);
    const bare = Y.encodeStateAsUpdate(head);
    const key = { kind: "sessions" as const, id: "s1" };
    const path = store.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodeLogEntry(bare));

    const firstVector = Y.encodeStateVector(head);
    head.getMap("root").set("tail", 1);
    const firstDelta = Y.encodeStateAsUpdate(head, firstVector);
    const secondVector = Y.encodeStateVector(head);
    head.getMap("root").set("tail", 2);
    const secondDelta = Y.encodeStateAsUpdate(head, secondVector);
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
    const restored = new Y.Doc();
    if (disk != null) Y.applyUpdate(restored, disk);
    const compacted = readFileSync(path);
    expect({
      firstOk: firstResult.ok,
      secondOk: secondResult.ok,
      tail: restored.getMap("root").get("tail"),
      head: restored.getMap("root").get("head"),
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
      const doc = new Y.Doc();
      const key = { kind: "sessions" as const, id: "vacuumed" };
      doc.getMap("root").set("body", "x".repeat(200_000));
      doc.getMap("root").set("kept", "yes");
      const first = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 1).checkpoint,
        image: Y.encodeStateAsUpdate(doc),
        snapshot: () => Y.encodeStateAsUpdate(doc),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const vector = Y.encodeStateVector(doc);
      doc.getMap("root").set("body", "short");
      return { store, doc, key, first, delta: Y.encodeStateAsUpdate(doc, vector) };
    }

    it("replaces the log with one snapshot, where an ordinary flush only appends", async () => {
      const { store, doc, key, first, delta } = await logWithDeadBody();
      const path = store.pathFor(key);
      const afterFirst = statSync(path).size;
      const appended = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 2).checkpoint,
        image: delta,
        snapshot: () => Y.encodeStateAsUpdate(doc),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const afterAppend = statSync(path).size;
      const forced = await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 3).checkpoint,
        image: new Uint8Array([0, 0]),
        snapshot: () => Y.encodeStateAsUpdate(doc),
        force: true,
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const file = readFileSync(path);
      const restored = new Y.Doc();
      const disk = await store.read(key);
      if (disk != null) Y.applyUpdate(restored, disk);
      expect({
        ok: [first.ok, appended.ok, forced.ok],
        appendGrew: afterAppend > afterFirst,
        forcedShrank: file.byteLength < 1_000,
        oneEntry: file.readUInt32BE(0) + 4 === file.byteLength,
        body: restored.getMap("root").get("body"),
        kept: restored.getMap("root").get("kept"),
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
        snapshot: () => Y.encodeStateAsUpdate(doc),
        force: true,
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const snapshotBytes = statSync(path).size;
      const vector = Y.encodeStateVector(doc);
      doc.getMap("root").set("later", true);
      await store.flush({
        checkpoint: snapshot(doc, "vacuumed", 3).checkpoint,
        image: Y.encodeStateAsUpdate(doc, vector),
        snapshot: () => Y.encodeStateAsUpdate(doc),
        runtimeGeneration: 1,
        connectionEpoch: 1,
      });
      const restored = new Y.Doc();
      const disk = await store.read(key);
      if (disk != null) Y.applyUpdate(restored, disk);
      expect({
        siblings: readdirSync(dirname(path)),
        grew: statSync(path).size > snapshotBytes,
        later: restored.getMap("root").get("later"),
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
    const head = new Y.Doc();
    head.getMap("root").set("bare", true);
    const key = { kind: "sessions" as const, id: "legacy" };
    const path = store.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Y.encodeStateAsUpdate(head));
    const disk = await store.read(key);
    const restored = new Y.Doc();
    if (disk != null) Y.applyUpdate(restored, disk);
    expect(restored.getMap("root").get("bare")).toBe(true);
    restored.destroy();
    head.destroy();
  });
});
