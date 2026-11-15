/**
 * `--continue` is Client.restore: the daemon opens the session and kernel
 * node rows from SQLite and the client syncs them. Incremental node-delta
 * commits come back whole, and cold restore does not rewrite stored rows.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_SCOPE_ID } from "@inhuman.tools/harness-contract/schema";
import { KernelDocument, SessionDocument, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { bindJsonRpc, destroyRoomConnection, RoomConnection, waitForSync } from "@inhuman.tools/harness-peer";
import { Client } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import {
  commitScopeNodesInBatch,
  commitSessionNodesInBatch,
  loadScopeNodesFromKv,
  loadSessionNodesFromKv,
} from "@inhuman.tools/scope-plane";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { runInAction, when } from "mobx";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

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
      await host.flushSession(project.sessions[sessionId].doc);
      await host.flushKernel();
    } finally {
      await client[Symbol.asyncDispose]();
      await daemon[Symbol.asyncDispose]();
    }

    const db = new SqliteKvStore(join(kernel, "harness.db"));
    try {
      const loadedSession = await loadSessionNodesFromKv(db, sessionId);
      if (loadedSession === undefined) throw new Error("missing session rows");
      const sessionDoc = SessionDocument.fromNodeRows(loadedSession.rows, {
        rootId: loadedSession.rootId,
        sessionId,
        revision: loadedSession.revision,
      });
      sessionDoc.root.applyKvs([{ form: "kv-set", key: "tail", value: "yes" }]);
      const sessionDelta = sessionDoc.peekNodeDelta();
      await db.batch((tx) => {
        commitSessionNodesInBatch(tx, sessionId, sessionDelta);
      });
      sessionDoc.destroy();

      const loadedKernel = await loadScopeNodesFromKv(db, KERNEL_SCOPE_ID);
      if (loadedKernel === undefined) throw new Error("missing kernel rows");
      const kernelDoc = KernelDocument.fromNodeRows(loadedKernel.rows, {
        rootId: loadedKernel.rootId,
        revision: loadedKernel.revision,
      });
      runInAction(() => {
        kernelDoc.root.termContinue.desk = sessionId;
      });
      const kernelDelta = kernelDoc.peekNodeDelta();
      await db.batch((tx) => {
        commitScopeNodesInBatch(tx, KERNEL_SCOPE_ID, kernelDelta);
      });
      kernelDoc.destroy();
    } finally {
      await db.close();
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

  it("turn/cancel succeeds after daemon restart via both sessionId-only WebSocket and Client.restore", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-restart-cancel-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-restart-cancel-p-")));
    let webSessionId: string;
    let webTurnId: string;
    let restoreSessionId: string;
    let restoreTurnId: string;

    {
      const daemon = new HarnessDaemon(kernel);
      await daemon.listen();
      try {
        await using webClient = await Client.start(kernel, workspace);
        await using restoreClient = await Client.start(kernel, workspace);
        webSessionId = webClient.sessionId;
        restoreSessionId = restoreClient.sessionId;

        const host = await daemon.kernel();
        const project = await daemon.project(workspace);
        const webSession = project.sessions[webSessionId];
        const restoreSession = project.sessions[restoreSessionId];
        if (webSession === undefined || restoreSession === undefined) throw new Error("missing live sessions");

        const webTurn = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          queue: [],
          reducerExited: false,
        });
        const restoreTurn = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          queue: [],
          reducerExited: false,
        });
        webTurnId = webTurn.uuid;
        restoreTurnId = restoreTurn.uuid;

        runInAction(() => {
          webSession.root.head = webTurn;
          webSession.root.tip = webTurn;
          restoreSession.root.head = restoreTurn;
          restoreSession.root.tip = restoreTurn;
        });

        await host.flushSession(webSession.doc);
        await host.flushSession(restoreSession.doc);
        await host.flushKernel();
      } finally {
        await daemon[Symbol.asyncDispose]();
      }
    }

    const restarted = new HarnessDaemon(kernel);
    await restarted.listen();
    try {
      // 1. Web reconnect pattern: `/session?sessionId=<id>` without `path` and before any `/kernel` seat.
      const socketPath = daemonSocketPath(kernel);
      const webDoc = SessionDocument.create(`harness:session:${webSessionId}`);
      const webConn = new RoomConnection(`ws+unix://${socketPath}:`, "session", webDoc, {
        WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
        params: { sessionId: webSessionId },
      });
      try {
        await waitForSync(webConn, "session", 8_000);
        const rpc = bindJsonRpc(webConn);
        await expect(rpc.request("turn/cancel", { turnId: webTurnId })).resolves.toEqual({ ok: true });
        await when(() => webDoc.root.head?.cancelled === true && webDoc.root.head.reducerExited, { timeout: 5_000 });
      } finally {
        destroyRoomConnection(webConn);
        webDoc.destroy();
      }

      // 2. SDK/TUI restore pattern: `Client.restore` opens `/session?sessionId=<id>` before `/kernel` seat.
      await using restored = await Client.restore(kernel, restoreSessionId);
      await expect(restored.request("turn/cancel", { turnId: restoreTurnId })).resolves.toEqual({ ok: true });
      await when(() => restored.sessionRoot.head?.cancelled === true && restored.sessionRoot.head.reducerExited, {
        timeout: 5_000,
      });
    } finally {
      await restarted[Symbol.asyncDispose]();
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
