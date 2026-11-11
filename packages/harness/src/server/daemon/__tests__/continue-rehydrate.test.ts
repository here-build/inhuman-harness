/**
 * `--continue` is Client.restore: the daemon opens the session and kernel
 * node rows from SQLite and the client syncs them. Incremental node-delta
 * commits come back whole, and cold restore does not rewrite stored rows.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_SCOPE_ID } from "@inhuman.tools/harness-contract/schema";
import { KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { HarnessDatabase } from "@inhuman.tools/scope-plane/sqlite";
import { runInAction } from "mobx";
import { describe, expect, it } from "vitest";

import { HarnessDaemon } from "../server/HarnessDaemon.js";

describe("continue rehydrate", () => {
  it("Client.restore reads base node rows plus an incremental delta commit", async () => {
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
      host.flushKernel();
    } finally {
      await client[Symbol.asyncDispose]();
      await daemon[Symbol.asyncDispose]();
    }

    const db = new HarnessDatabase(join(kernel, "harness.db"));
    try {
      const loadedSession = db.loadSessionNodes(sessionId);
      if (loadedSession === undefined) throw new Error("missing session rows");
      const sessionDoc = SessionPlexus.fromNodeRows(loadedSession.rows, {
        rootId: loadedSession.rootId,
        sessionId,
        revision: loadedSession.revision,
      });
      sessionDoc.root.applyKvs([{ form: "kv-set", key: "tail", value: "yes" }]);
      const sessionDelta = sessionDoc.doc.peekNodeDelta();
      db.commitSessionNodes(sessionId, sessionDelta);
      sessionDoc.destroy();

      const loadedKernel = db.loadScopeNodes(KERNEL_SCOPE_ID);
      if (loadedKernel === undefined) throw new Error("missing kernel rows");
      const kernelDoc = KernelPlexus.fromNodeRows(loadedKernel.rows, {
        rootId: loadedKernel.rootId,
        revision: loadedKernel.revision,
      });
      runInAction(() => {
        kernelDoc.root.termContinue.desk = sessionId;
      });
      const kernelDelta = kernelDoc.doc.peekNodeDelta();
      db.commitScopeNodes(KERNEL_SCOPE_ID, kernelDelta);
      kernelDoc.destroy();
    } finally {
      db.close();
    }

    const again = new HarnessDaemon(kernel);
    await again.listen();
    try {
      await using restored = await Client.restore(kernel, sessionId);
      const host = await again.kernel();
      const beforeBytes = host.sessionStoredBytes(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const grew = host.sessionStoredBytes(sessionId) - beforeBytes;
      expect({
        head: restored.sessionRoot.kvs.head,
        tail: restored.sessionRoot.kvs.tail,
        desk: restored.kernelRoot.termContinue.desk,
        settled: grew === 0,
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
