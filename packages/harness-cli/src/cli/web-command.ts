import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensure } from "@inhuman.tools/harness";
import { Client } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { Command, Option } from "clipanion";

import { KernelCommand } from "./context.js";
import { importShell } from "./shell-import.js";

export class WebCommand extends KernelCommand {
  static paths = [["web"]];
  static usage = Command.Usage({
    category: "Client",
    description: "open the browser client on the local daemon",
  });

  port = Option.String("--port", "8787", { description: "loopback port" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("harness web");
    if (blocked !== undefined) return blocked;
    const port = Number(this.port);
    if (!Number.isInteger(port) || port < 0) {
      this.context.writeErr("web: --port must be a whole number");
      return 1;
    }
    const web = await importShell(
      this.context,
      { label: "web shell", specifier: "@inhuman.tools/harness-web-app/server" },
      () => import("@inhuman.tools/harness-web-app/server"),
    );
    if (web === undefined) return 1;
    // The web package locates its own page; a path from this file only held while both sat in one checkout.
    const webAppRoot = dirname(fileURLToPath(import.meta.resolve("@inhuman.tools/harness-web-app/package.json")));
    try {
      await ensure(this.kernelPath());
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
    const sock = daemonSocketPath(await realpath(this.kernelPath()));
    if (!existsSync(sock)) {
      this.context.writeErr("web: daemon socket is missing");
      return 1;
    }
    const fileRoots = new Set<string>([process.cwd()]);
    try {
      await using kernel = await Client.kernel(this.kernelPath());
      for (const path of Object.keys(kernel.plexus.root.projects)) fileRoots.add(path);
    } catch {
      // /file still serves the process cwd.
    }
    let app;
    try {
      app = await web.listenWebApp({
        sockPath: sock,
        port,
        pages: "vite",
        viteRoot: webAppRoot,
        staticDir: join(webAppRoot, "dist/client"),
        fileRoots: [...fileRoots],
        extraOrigins: (process.env["HARNESS_WEB_ALLOWED_ORIGINS"] ?? "")
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin !== ""),
      });
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
    const url = `http://127.0.0.1:${app.port}/`;
    this.context.stdout.write(`${url}\n`);
    openBrowser(url);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await app.close();
    return 0;
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
