import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { daemonRunning } from "@inhuman.tools/harness";
import { Client } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { Option } from "clipanion";

import { KernelCommand } from "./context.js";
import { importShell } from "./shell-import.js";
import { clearDoorRecord, DOOR_MISSES_TO_LEAVE, DOOR_PROBE_MS, writeDoorRecord } from "./web-door.js";

/**
 * Internal: the detached process `inhuman open` starts. Serves the built client until the daemon is gone.
 * It has no `usage`, so help does not list it.
 */
export class WebDoorCommand extends KernelCommand {
  static paths = [["web-door"]];

  port = Option.String("--port", "8787");

  async execute(): Promise<number> {
    const port = Number(this.port);
    const web = await importShell(
      this.context,
      { label: "web shell", specifier: "@inhuman.tools/harness-web-app/server" },
      () => import("@inhuman.tools/harness-web-app/server"),
    );
    if (web === undefined) return 1;
    const webAppRoot = dirname(fileURLToPath(import.meta.resolve("@inhuman.tools/harness-web-app/package.json")));
    const kernel = await realpath(this.kernelPath());
    const sock = daemonSocketPath(kernel);
    if (!existsSync(sock)) {
      this.context.writeErr("web-door: daemon socket is missing");
      return 1;
    }
    const fileRoots = new Set<string>([process.cwd()]);
    try {
      await using client = await Client.kernel(kernel);
      for (const path of Object.keys(client.plexus.root.projects)) fileRoots.add(path);
    } catch {
      // /file still serves the process cwd.
    }
    const options = {
      sockPath: sock,
      pages: "static" as const,
      staticDir: join(webAppRoot, "dist/client"),
      fileRoots: [...fileRoots],
      extraOrigins: (process.env["HARNESS_WEB_ALLOWED_ORIGINS"] ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ""),
    };
    let app;
    try {
      app = await web.listenWebApp({ ...options, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        this.context.writeErr(error);
        return 1;
      }
      app = await web.listenWebApp({ ...options, port: 0 });
    }
    const url = `http://127.0.0.1:${app.port}/`;
    await writeDoorRecord(kernel, { pid: process.pid, port: app.port, url });
    this.context.stdout.write(`web-door ${process.pid} ${url}\n`);

    await new Promise<void>((resolve) => {
      let misses = 0;
      const timer = setInterval(() => {
        void (async () => {
          const alive = await daemonRunning(kernel);
          misses = alive ? 0 : misses + 1;
          if (misses >= DOOR_MISSES_TO_LEAVE) resolve();
        })();
      }, DOOR_PROBE_MS);
      const leave = (): void => {
        clearInterval(timer);
        resolve();
      };
      process.once("SIGINT", leave);
      process.once("SIGTERM", leave);
    });
    this.context.stdout.write("web-door leaving\n");
    await clearDoorRecord(kernel, process.pid);
    await app.close();
    return 0;
  }
}
