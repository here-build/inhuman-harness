import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentKey } from "@/protocol/document";

import { DocumentRegistry } from "../registry/document-registry.js";
import { documentImagePath, SESSION_ROOT_TYPE } from "../registry/identity.js";
import { encodeLogEntry } from "../update-log.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-inventory-"));
  temps.push(root);
  return root;
}

function encodeSession(sessionId: string): Uint8Array {
  const doc = new Y.Doc();
  const typeMap = new Y.Map();
  doc.getMap("types").set(SESSION_ROOT_TYPE, typeMap);
  const node = new Y.XmlElement(SESSION_ROOT_TYPE);
  typeMap.set("extract-root", node);
  node.setAttribute("sessionId", sessionId);
  doc.getMap("meta").set("root", "extract-root");
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function writeSession(root: string, sessionId: string): string {
  const path = documentImagePath(root, "sessions", sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeLogEntry(encodeSession(sessionId)));
  return path;
}

describe("inventory cuts", () => {
  it("lists hashed images and keeps a cut stable while files appear", async () => {
    const root = tempRoot();
    writeSession(root, "a");
    writeSession(root, "b");
    const registry = new DocumentRegistry({ root, pageSize: 1 });
    const first = await registry.list({ kind: "sessions", cursor: null });
    writeSession(root, "c");
    const rest = await registry.list({
      kind: "sessions",
      cursor: first.cursor,
    });
    const freshIds: string[] = [];
    let cursor: string | null = null;
    let freshCut = 0;
    do {
      const page = await registry.list({ kind: "sessions", cursor });
      freshIds.push(...page.entries.map((row) => row.key.id));
      freshCut = page.checkpoint.cut;
      cursor = page.cursor;
    } while (cursor != null);
    expect({
      first: first.entries.map((row) => row.key.id),
      rest: rest.entries.map((row) => row.key.id),
      firstCursor: first.cursor != null,
      restCursor: rest.cursor,
      cut: first.checkpoint.cut === rest.checkpoint.cut,
      fresh: freshIds,
      newCut: freshCut !== first.checkpoint.cut,
    }).toEqual({
      first: ["a"],
      rest: ["b"],
      firstCursor: true,
      restCursor: null,
      cut: true,
      fresh: ["a", "b", "c"],
      newCut: true,
    });
  });

  it("includes dirty live docs without a file and does not intern extracts", async () => {
    const root = tempRoot();
    writeSession(root, "disk");
    const registry = new DocumentRegistry({ root, pageSize: 10 });
    const live = new Y.Doc({ guid: "harness:session:live" });
    const key = documentKey("sessions", "live");
    const handle = registry.intern(key, live);
    const page = await registry.list({ kind: "sessions", cursor: null });
    expect({
      ids: page.entries.map((row) => row.key.id),
      livePath: page.entries.find((row) => row.key.id === "live")?.storagePath,
      diskLoaded: registry.getLoaded(documentKey("sessions", "disk")),
      liveDoc: registry.getLoaded(key)?.doc === live,
      pins: handle.revision,
    }).toEqual({
      ids: ["disk", "live"],
      livePath: documentImagePath(root, "sessions", "live"),
      diskLoaded: undefined,
      liveDoc: true,
      pins: 0,
    });
    registry.release(key);
    expect(registry.getLoaded(key)).toBeUndefined();
    live.destroy();
  });

  it("re-identifies cataloged files on later cuts", async () => {
    const root = tempRoot();
    const path = writeSession(root, "s1");
    const registry = new DocumentRegistry({ root, pageSize: 10 });
    const first = await registry.list({ kind: "sessions", cursor: null });
    writeFileSync(path, encodeLogEntry(encodeSession("s2")));
    const mismatched = await registry.list({ kind: "sessions", cursor: null });
    const mismatchError = errorReason(registry, path);
    writeFileSync(path, Buffer.from([0, 1, 2, 3]));
    const corrupt = await registry.list({ kind: "sessions", cursor: null });
    const corruptError = errorReason(registry, path);
    writeFileSync(path, new Uint8Array());
    const empty = await registry.list({ kind: "sessions", cursor: null });
    const emptyError = errorReason(registry, path);
    unlinkSync(path);
    const missing = await registry.list({ kind: "sessions", cursor: null });
    const missingError = errorReason(registry, path);
    writeSession(root, "s1");
    const restored = await registry.list({ kind: "sessions", cursor: null });
    expect({
      first: first.entries.map((row) => row.key.id),
      mismatched: mismatched.entries.map((row) => row.key.id),
      mismatchError,
      corrupt: corrupt.entries.map((row) => row.key.id),
      corruptError,
      empty: empty.entries.map((row) => row.key.id),
      emptyError,
      missing: missing.entries.map((row) => row.key.id),
      missingError,
      restored: restored.entries.map((row) => row.key.id),
      restoredError: errorReason(registry, path),
    }).toEqual({
      first: ["s1"],
      mismatched: [],
      mismatchError: "mismatch",
      corrupt: [],
      corruptError: "corrupt",
      empty: [],
      emptyError: "empty",
      missing: [],
      missingError: "empty",
      restored: ["s1"],
      restoredError: undefined,
    });
  });

  it("does not page a cursor against a different kind", async () => {
    const root = tempRoot();
    writeSession(root, "a");
    writeSession(root, "b");
    const registry = new DocumentRegistry({ root, pageSize: 1 });
    const first = await registry.list({ kind: "sessions", cursor: null });
    const wrongKind = await registry.list({
      kind: "projects",
      cursor: first.cursor,
    });
    const rest = await registry.list({
      kind: "sessions",
      cursor: first.cursor,
    });
    expect({
      first: first.entries.map((row) => row.key.id),
      wrongKind: wrongKind.entries.map((row) => row.key.id),
      rest: rest.entries.map((row) => row.key.id),
    }).toEqual({
      first: ["a"],
      wrongKind: [],
      rest: ["b"],
    });
  });
});

function errorReason(registry: DocumentRegistry, storagePath: string): string | undefined {
  return registry.inventoryErrors().find((row) => row.storagePath === storagePath)?.reason;
}

describe("invalidation gaps", () => {
  it("emits change events from a cut and gaps on overflow, missing cut, and epoch", async () => {
    const root = tempRoot();
    writeSession(root, "a");
    const registry = new DocumentRegistry({
      root,
      pageSize: 10,
      watchBound: 1,
    });
    const page = await registry.list({ kind: "sessions", cursor: null });
    const watch = registry.watchChanges("sessions", page.checkpoint);
    const live = new Y.Doc();
    const extra = new Y.Doc();
    const overflowDoc = new Y.Doc();
    registry.intern(documentKey("sessions", "b"), live);
    const changes = watch.pull();
    registry.intern(documentKey("sessions", "c"), extra);
    registry.intern(documentKey("sessions", "d"), overflowDoc);
    const overflow = watch.pull();
    const missing = registry.watchChanges("sessions", {
      serverEpoch: page.checkpoint.serverEpoch,
      cut: page.checkpoint.cut + 99,
    });
    const missingEvents = missing.pull();
    registry.bumpServerEpoch();
    const epoch = watch.pull();
    expect({
      changes,
      overflow,
      missing: missingEvents,
      epoch,
    }).toEqual({
      changes: [{ type: "change", key: { kind: "sessions", id: "b" }, revision: 0 }],
      overflow: [
        {
          type: "gap",
          reason: "overflow",
          serverEpoch: page.checkpoint.serverEpoch,
        },
      ],
      missing: [
        {
          type: "gap",
          reason: "missing-checkpoint",
          serverEpoch: page.checkpoint.serverEpoch,
        },
      ],
      epoch: [
        {
          type: "gap",
          reason: "epoch-change",
          serverEpoch: page.checkpoint.serverEpoch + 1,
        },
      ],
    });
    watch.close();
    missing.close();
    live.destroy();
    extra.destroy();
    overflowDoc.destroy();
  });

  it("records hash-mismatched and corrupt files as inventory errors", async () => {
    const root = tempRoot();
    const mismatch = documentImagePath(root, "sessions", "other");
    mkdirSync(dirname(mismatch), { recursive: true });
    writeFileSync(mismatch, encodeLogEntry(encodeSession("s1")));
    const corrupt = documentImagePath(root, "sessions", "bad");
    writeFileSync(corrupt, Buffer.from([0, 1, 2, 3]));
    const registry = new DocumentRegistry({ root });
    const page = await registry.list({ kind: "sessions", cursor: null });
    const errors = registry
      .inventoryErrors()
      .map((row) => row.reason)
      .sort();
    expect({ ids: page.entries.map((row) => row.key.id), errors }).toEqual({
      ids: [],
      errors: ["corrupt", "mismatch"],
    });
  });
});
