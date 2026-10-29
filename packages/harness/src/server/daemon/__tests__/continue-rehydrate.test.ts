/**
 * `--continue` is Client.restore: the daemon opens the session and kernel
 * images from disk and the client syncs them. A snapshot with a
 * length-prefixed tail must come back whole, and the open must not rewrite
 * the file.
 */
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_DOC_GUID, KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { runInAction } from "mobx";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { documentKey, type DocumentKey } from "@/protocol/document";
import { DocumentImageStore, documentImagePath } from "@/yjs/storage";

import { HarnessDaemon } from "../server/HarnessDaemon.js";

function logEntry(update: Uint8Array): Uint8Array {
  const entry = new Uint8Array(4 + update.byteLength);
  new DataView(entry.buffer).setUint32(0, update.byteLength, false);
  entry.set(update, 4);
  return entry;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Replace a flushed image with a snapshot entry followed by a delta entry. */
async function rewriteSnapshotPlusTail(
  kernel: string,
  key: DocumentKey,
  guid: string,
  mutate: (doc: Y.Doc) => void,
): Promise<Uint8Array> {
  const merged = await new DocumentImageStore(kernel).read(key);
  if (merged == null) throw new Error(`missing ${key.kind} image`);
  const doc = new Y.Doc({ guid });
  Y.applyUpdate(doc, merged);
  const bare = Y.encodeStateAsUpdate(doc);
  const vector = Y.encodeStateVector(doc);
  mutate(doc);
  const delta = Y.encodeStateAsUpdate(doc, vector);
  if (delta.byteLength <= 2) throw new Error(`empty tail for ${key.kind}`);
  writeFileSync(documentImagePath(kernel, key), concatBytes([logEntry(bare), logEntry(delta)]));
  doc.destroy();
  return bare;
}

describe("continue rehydrate", () => {
  it("Client.restore reads a bare snapshot plus the appended tail", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-rehydrate-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-rehydrate-p-")));
    const daemon = new HarnessDaemon(kernel);
    await daemon.listen();
    const client = await Client.start(kernel, workspace);
    const sessionId = client.sessionId;
    try {
      await client.request("kv/set", { key: "head", value: "yes" });
      const host = await daemon.kernel();
      const project = await daemon.project(workspace);
      await host.flushSession(project.sessions[sessionId].plexus);
      const documents = host.runtime.documents;
      if (documents == null) throw new Error("missing documents");
      const kernelKey = documentKey("kernel", "kernel");
      const checkpoint = documents.checkpoint(kernelKey);
      if (checkpoint == null) throw new Error("missing kernel checkpoint");
      await documents.flush(kernelKey, checkpoint);
    } finally {
      await client[Symbol.asyncDispose]();
      await daemon[Symbol.asyncDispose]();
    }

    await rewriteSnapshotPlusTail(kernel, documentKey("sessions", sessionId), `harness:session:${sessionId}`, (doc) => {
      SessionPlexus.connect(doc, { undo: "stub" }).root.applyKvs([{ form: "kv-set", key: "tail", value: "yes" }]);
    });
    await rewriteSnapshotPlusTail(kernel, documentKey("kernel", "kernel"), KERNEL_DOC_GUID, (doc) => {
      const root = KernelPlexus.connect(doc, { undo: "stub" }).root;
      runInAction(() => {
        root.termContinue.desk = sessionId;
      });
    });

    const again = new HarnessDaemon(kernel);
    await again.listen();
    try {
      await using restored = await Client.restore(kernel, sessionId);
      const sessionFile = documentImagePath(kernel, documentKey("sessions", sessionId));
      const size = statSync(sessionFile).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const grew = statSync(sessionFile).size - size;
      expect({
        head: restored.sessionRoot.kvs.head,
        tail: restored.sessionRoot.kvs.tail,
        desk: restored.kernelRoot.termContinue.desk,
        settled: grew < 16_384,
      }).toEqual({
        head: "yes",
        tail: "yes",
        desk: sessionId,
        settled: true,
      });
    } finally {
      await again[Symbol.asyncDispose]();
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
