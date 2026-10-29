#!/usr/bin/env node

import { join } from "node:path";

import { fail } from "@inhuman.tools/harness-diagnostics";
import { WebSocket } from "ws";

import { openDriverRegistry } from "@/connections";
import { runSupervisedProcess } from "@/hypervisor";
import type { ShutdownCutoff } from "@/protocol/schemas";
import { RuntimeServer } from "@/runtime-server";
import { connectRemoteDocument, wrapWebSocket } from "@/yjs";

import { PRODUCT_PROVIDERS } from "./composition.js";

const PEER_SOCK = join(process.cwd(), "private-peer.sock");
const PEER_CAPABILITY = "product";

try {
  process.exit(
    await runSupervisedProcess({
      start: async ({ identity }) => {
        const ws = new WebSocket(`ws+unix://${PEER_SOCK}:/`);
        await new Promise<void>((resolve, reject) => {
          const onOpen = (): void => {
            ws.off("error", onError);
            resolve();
          };
          const onError = (error: Error): void => {
            ws.off("open", onOpen);
            reject(error);
          };
          ws.once("open", onOpen);
          ws.once("error", onError);
        });
        let closing = false;
        ws.on("error", () => undefined);
        ws.on("close", () => {
          if (!closing) process.exit(1);
        });
        const connected = await connectRemoteDocument(wrapWebSocket(ws), {
          capability: PEER_CAPABILITY,
          identity,
        });
        if (!connected.ok) {
          closing = true;
          ws.close();
          throw new Error(`runtime peer ${connected.reason}`);
        }
        const server = new RuntimeServer({
          adapter: connected.adapter,
          registry: openDriverRegistry(PRODUCT_PROVIDERS),
        });
        return async (): Promise<ShutdownCutoff["flush"]> => {
          closing = true;
          let flush: ShutdownCutoff["flush"] = "ok";
          const loaded = server.documents.loaded();
          if (loaded.length > 0) {
            for (const ref of loaded) {
              const result = await server.documents.flush(ref.key);
              if (!result.ok) {
                flush = result.reason === "disconnected" ? "pending" : "failed";
                break;
              }
            }
          }
          server[Symbol.dispose]();
          ws.close();
          return flush;
        };
      },
    }),
  );
} catch (error) {
  fail("runtime-server", error);
  process.exit(1);
}
