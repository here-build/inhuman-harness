import { mkdir, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";

import { fail, step } from "@inhuman.tools/harness-diagnostics";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { WebSocketServer } from "ws";

import { classifyPublicUpgrade, UPGRADE_NOT_FOUND, UPGRADE_ROUTE_FAILED } from "@/yjs";

import type { HarnessDaemon } from "./HarnessDaemon.js";
import { type RequestHost } from "../../contract.js";
import { errnoCode } from "../../util/errno.js";

export class HTTPServer implements AsyncDisposable {
  private readonly server = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  });
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Fresh server is not listening. listen() opens; dispose closes. Starting open skips the bind. */
  #closed = true;

  constructor(private readonly harnessDaemon: HarnessDaemon) {
    this.server.on("upgrade", async (request, socket, head) => {
      const url = request.url ?? "/";
      let gone = false;
      socket.on("error", () => {
        gone = true;
      });
      socket.once("close", () => {
        gone = true;
      });

      const refuse = (status: number, reason: string): void => {
        if (gone || socket.destroyed) return;
        socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
        socket.destroy();
      };

      try {
        const classified = classifyPublicUpgrade(url);
        switch (classified.action) {
          case "refuse":
            refuse(classified.status, classified.reason);
            break;
          case "open": {
            // Existing identity: this process still attaches the runtime host.
            const key = classified.key;
            let host: RequestHost | undefined;
            if (key.kind === "kernel") host = await this.harnessDaemon.kernel();
            else if (key.kind === "projects") host = await this.harnessDaemon.project(key.id);
            else host = await this.harnessDaemon.attachSession(key.id);
            if (host == null) {
              refuse(UPGRADE_NOT_FOUND, "not found");
              break;
            }
            if (gone || socket.destroyed) break;
            host.accept(socket, request, head, this.wss);
            break;
          }
          case "create": {
            if (classified.path == null || classified.path === "") {
              refuse(400, "missing path");
              break;
            }
            const project = await this.harnessDaemon.project(classified.path);
            const host = await project.session(classified.sessionId);
            if (gone || socket.destroyed) break;
            host.accept(socket, request, head, this.wss);
            break;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "route failed";
        step(`upgrade failed ${url} ${reason}`);
        refuse(UPGRADE_ROUTE_FAILED, reason);
      }
    });
  }

  /** Bound unix path. An address object would mean TCP, which this server does not bind. */
  endpoint(): string | null {
    const address = this.server.address();
    return typeof address === "string" ? address : null;
  }

  async listen(): Promise<void> {
    if (!this.#closed) {
      return;
    }
    this.#closed = false;
    await mkdir(this.harnessDaemon.root, { recursive: true });
    const path = daemonSocketPath(await realpath(this.harnessDaemon.root));
    try {
      await unlink(path);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }

    step(`sock bind ${path}`);
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error): void => {
        reject(error);
      };
      this.server.once("error", onListenError);
      this.server.listen(path, () => {
        this.server.off("error", onListenError);
        resolve();
      });
    });
    step(`sock ready ${path}`);

    this.server.on("error", (error) => {
      fail("sock", error);
      void this[Symbol.asyncDispose]();
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => this.server.close(() => resolve()));
    });
  }
}
