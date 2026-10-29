#!/usr/bin/env node
import { unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { fail } from "@inhuman.tools/harness-diagnostics";
import { WebSocketServer } from "ws";

import { runSupervisedProcess } from "@/hypervisor";
import type { ShutdownCutoff } from "@/protocol/schemas";

import { PrivatePeerHub } from "./private-peer.js";
import { YjsServer } from "./rooms.js";
import { wrapWebSocket } from "./websocket.js";

const PEER_SOCK = join(process.cwd(), "private-peer.sock");
const PEER_CAPABILITY = "product";

try {
  process.exit(
    await runSupervisedProcess({
      start: async ({ identity }) => {
        const server = new YjsServer({
          root: process.cwd(),
          serverEpoch: identity.serverEpoch,
        });
        const hub = new PrivatePeerHub(server, {
          capability: PEER_CAPABILITY,
          identity,
        });
        try {
          await unlink(PEER_SOCK);
        } catch {
          /* leftover or missing */
        }
        const http = createServer((_request, response) => {
          response.writeHead(426);
          response.end();
        });
        const wss = new WebSocketServer({ noServer: true });
        wss.on("connection", (ws) => {
          hub.accept(wrapWebSocket(ws));
        });
        http.on("upgrade", (request, socket, head) => {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
          });
        });
        await new Promise<void>((resolve, reject) => {
          http.once("error", reject);
          http.listen(PEER_SOCK, () => resolve());
        });
        return async (): Promise<ShutdownCutoff["flush"]> => {
          let flush: ShutdownCutoff["flush"] = "ok";
          if (server.documents.memory().dirtyBytes > 0) {
            for (const ref of server.documents.loaded()) {
              const checkpoint = server.documents.checkpoint(ref.key);
              if (checkpoint == null) continue;
              const result = await server.documents.flush(ref.key, checkpoint);
              if (!result.ok) flush = "failed";
            }
            if (server.documents.memory().dirtyBytes > 0) flush = "failed";
          }
          await new Promise<void>((resolve) => {
            wss.close(() => {
              http.close(() => resolve());
            });
          });
          hub[Symbol.dispose]();
          server[Symbol.dispose]();
          return flush;
        };
      },
    }),
  );
} catch (error) {
  fail("yjs-server", error);
  process.exit(1);
}
