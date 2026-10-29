import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

import { KERNEL_DOC_GUID, SessionPlexus } from "@inhuman.tools/harness-model";
import { Client, RestoreNotFound, openUnixRoom } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath, projectSessionsDir } from "@inhuman.tools/harness-sdk/paths";
import { pathExists, readJson } from "fs-extra";
import { when } from "mobx";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { HarnessDaemon } from "../daemon/server/HarnessDaemon.js";
import { listenCompat } from "../testkit/compat-server.js";
import { sequenceReply } from "../testkit/sequence-provider.js";

const REPLICA_MS = 5_000;

describe("Client", () => {
  it("Client lifecycle: three roots, reconnect, session door, replica, restore, catalog, restart", async () => {
    const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-client-kernel-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-client-workspace-")));
    const other = realpathSync(mkdtempSync(join(tmpdir(), "harness-client-restore-o-")));
    const here = process.cwd();
    const compat = await listenCompat({ models: [{ id: "m1" }], reply: sequenceReply });
    const daemon = new HarnessDaemon(kernel);
    await daemon.listen();
    const started = await Client.start(kernel, workspace);
    try {
      expect({
        sessionPath: started.sessionRoot.path,
        sessionRootId: started.sessionRoot.sessionId,
        projectPath: started.projectPlexus.root.path,
        kernelGuid: started.kernelPlexus.doc.guid,
        minted: started.sessionId.length > 0,
      }).toEqual({
        sessionPath: workspace,
        sessionRootId: started.sessionId,
        projectPath: workspace,
        kernelGuid: KERNEL_DOC_GUID,
        minted: true,
      });

      const project = await daemon.project(workspace);
      const session = project.sessions[started.sessionId];
      if (session === undefined) throw new Error("missing session");
      expect({
        viaProject: session.project === project,
        viaKernel: session.kernel === (await daemon.kernel()),
        sessionsDir: await pathExists(projectSessionsDir(workspace)),
        guid: started.sessionPlexus.doc.guid,
        uuid: started.sessionPlexus.root.uuid,
      }).toEqual({
        viaProject: true,
        viaKernel: true,
        sessionsDir: true,
        guid: session.plexus.doc.guid,
        uuid: session.plexus.root.uuid,
      });

      {
        await using connected = await Client.connect(kernel, workspace, started.sessionId);
        expect({ id: connected.sessionId, path: connected.sessionRoot.path }).toEqual({
          id: started.sessionId,
          path: workspace,
        });

        const provider = started.sessionProvider;
        if (provider === null) throw new Error("missing session provider");
        expect({
          sessionId: provider.params.sessionId,
          stockAwareness: provider.awareness.getLocalState(),
          sessions: Object.keys(project.sessions),
        }).toEqual({
          sessionId: started.sessionId,
          stockAwareness: null,
          sessions: [started.sessionId],
        });

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("reconnect sync timeout")), 10_000);
          const onSync = (state: boolean): void => {
            if (!state) return;
            provider.off("sync", onSync);
            clearTimeout(timer);
            resolve();
          };
          provider.on("sync", onSync);
          provider.disconnect();
          provider.connect();
        });
        expect({ sessions: Object.keys(project.sessions) }).toEqual({ sessions: [started.sessionId] });

        await expect(started.request("kv/set", { key: "after", value: "1" })).resolves.toEqual({ ok: true });
        await when(() => started.sessionRoot.kvs.after === "1" && started.kernelRoot.kvs.after === "1", {
          timeout: REPLICA_MS,
        });
        expect({
          owner: session.root.kvs.after,
          replica: started.sessionRoot.kvs.after,
          kernel: started.kernelRoot.kvs.after,
        }).toEqual({ owner: "1", replica: "1", kernel: "1" });

        session.root.applyKvs([{ form: "kv-set", key: "from-owner", value: "yes" }]);
        await when(() => started.sessionRoot.kvs["from-owner"] === "yes", { timeout: REPLICA_MS });
        expect({ replica: started.sessionRoot.kvs["from-owner"] }).toEqual({ replica: "yes" });

        await expect(started.request("nope")).rejects.toThrow(/Method not found/);
        const adopted = (await started.request("connect/adopt", {
          driver: "openai-compat",
          name: "Work",
          settings: { baseUrl: "http://127.0.0.1:1234/v1" },
        })) as { id: string };
        await using kernelRpc = await Client.kernel(kernel);
        const listed = (await kernelRpc.request("connect/list")) as {
          connections: Array<{ id: string; name: string }>;
        };
        expect({
          adopted,
          file: await readJson(join(kernel, "config.json")),
          listed: listed.connections,
          replicaName: kernelRpc.plexus.root.connections.work?.name,
        }).toMatchObject({
          adopted: { id: "work" },
          file: { connections: { work: { driver: "openai-compat", name: "Work" } } },
          listed: expect.arrayContaining([expect.objectContaining({ id: "work", name: "Work" })]),
          replicaName: "Work",
        });

        await started.kernelRequest("term-continue/set", { key: "emu=test", sessionId: started.sessionId });
        await when(() => kernelRpc.plexus.root.termContinue["emu=test"] === started.sessionId, {
          timeout: REPLICA_MS,
        });
        await when(() => kernelRpc.plexus.root.sessions[started.sessionId] != null, { timeout: REPLICA_MS });
        expect({
          termContinue: kernelRpc.plexus.root.termContinue["emu=test"],
          glanced: kernelRpc.plexus.root.sessions[started.sessionId] != null,
        }).toEqual({ termContinue: started.sessionId, glanced: true });

        const socketPath = daemonSocketPath(kernel);
        const sessionId = started.sessionId;
        const unknownId = randomUUID();
        const attachedDoc = new Y.Doc({ guid: `harness:session:${sessionId}` });
        const attachedProvider = await openUnixRoom(socketPath, "session", { sessionId }, attachedDoc, {
          reconnect: false,
        });
        try {
          const ghost = new WebSocket(`ws+unix://${socketPath}:/session?sessionId=${unknownId}`);
          await expect(
            new Promise<void>((resolve, reject) => {
              ghost.once("open", () => resolve());
              ghost.once("error", (error) => reject(error));
            }),
          ).rejects.toThrow();
          ghost.close();
          const replica = SessionPlexus.connect(attachedDoc);
          const host = await daemon.kernel();
          expect({
            path: replica.root.path,
            id: replica.root.sessionId,
            guid: replica.doc.guid,
            restored: (await daemon.attachSession(sessionId))?.sessionId,
            unknownLive: host.sessionPlexus(unknownId) != null,
            sessions: Object.keys(project.sessions),
            membership: unknownId in project.root.sessions,
          }).toEqual({
            path: workspace,
            id: sessionId,
            guid: `harness:session:${sessionId}`,
            restored: sessionId,
            unknownLive: false,
            sessions: [sessionId],
            membership: false,
          });
        } finally {
          attachedProvider.destroy();
          attachedDoc.destroy();
        }

        expect({
          known: await Client.sessionExists(kernel, sessionId),
          unknown: await Client.sessionExists(kernel, randomUUID()),
        }).toEqual({ known: true, unknown: false });

        chdir(other);
        try {
          await using restored = await Client.restore(kernel, sessionId);
          expect({
            id: restored.sessionId,
            path: restored.sessionRoot.path,
            project: restored.projectPath,
          }).toEqual({
            id: sessionId,
            path: workspace,
            project: workspace,
          });

          const ghost = randomUUID();
          await expect(Client.restore(kernel, ghost)).rejects.toBeInstanceOf(RestoreNotFound);
          expect({ exists: await Client.sessionExists(kernel, ghost) }).toEqual({ exists: false });

          await using minted = await Client.connect(kernel, workspace, ghost);
          expect({
            id: minted.sessionId,
            membership: ghost in project.root.sessions,
          }).toEqual({ id: ghost, membership: true });
        } finally {
          chdir(here);
        }

        await using b = await Client.start(kernel, workspace);
        await started.request("connect/adopt", {
          driver: "openai-compat",
          name: "Catalog",
          settings: { baseUrl: compat.baseUrl },
        });
        const catalogSession = project.sessions[started.sessionId];
        if (catalogSession === undefined) throw new Error("missing session");
        void catalogSession.orchestrator.ensure("catalog");
        const owner = await daemon.kernel();
        await when(() => owner.plexus.root.connections.catalog?.live.models?.[0] === "m1", { timeout: REPLICA_MS });
        await when(() => started.kernelRoot.connections.catalog?.live.models?.[0] === "m1", { timeout: REPLICA_MS });
        await when(() => b.kernelRoot.connections.catalog?.live.models?.[0] === "m1", { timeout: REPLICA_MS });
        expect({
          a: started.kernelRoot.connections.catalog?.live.models,
          b: b.kernelRoot.connections.catalog?.live.models,
        }).toEqual({ a: ["m1"], b: ["m1"] });
      }

      await daemon[Symbol.asyncDispose]();
      const again = new HarnessDaemon(kernel);
      await again.listen();
      try {
        await expect(started.request("kv/set", { key: "restart", value: "2" })).resolves.toEqual({ ok: true });
        await when(() => started.sessionRoot.kvs.restart === "2", { timeout: 10_000 });
        expect({ after: started.sessionRoot.kvs.restart }).toEqual({ after: "2" });
      } finally {
        await again[Symbol.asyncDispose]();
      }
    } finally {
      await started[Symbol.asyncDispose]();
      await compat.close();
      chdir(here);
      rmSync(kernel, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  }, 60_000);
});
