import { daemonRunning, ensure } from "@inhuman.tools/harness";
import { Command, Option } from "clipanion";

import { openBrowser } from "./browser.js";
import { KernelCommand } from "./context.js";
import { importShell } from "./shell-import.js";
import { liveDoor, startDoor, type DoorRecord } from "./web-door.js";

export type OpenDeps = {
  readonly daemonRunning: (kernel: string) => Promise<boolean>;
  readonly ensure: (kernel: string) => Promise<void>;
  readonly findDoor: (kernel: string) => Promise<DoorRecord | undefined>;
  readonly startDoor: (kernel: string, port: number) => Promise<DoorRecord>;
  readonly openBrowser: (url: string) => void;
};

export type OpenOptions = {
  readonly kernel: string;
  readonly port: number;
  readonly browser: boolean;
};

export type OpenOutput = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/**
 * Daemon up, web door up, URL printed. The browser opens only when this call started the daemon: a
 * daemon that was already running means the user already has the client open somewhere.
 */
export async function runOpen(deps: OpenDeps, options: OpenOptions, output: OpenOutput): Promise<number> {
  const wasRunning = await deps.daemonRunning(options.kernel);
  await deps.ensure(options.kernel);
  output.err(wasRunning ? "daemon: already running" : "daemon: started");
  let door = await deps.findDoor(options.kernel);
  if (door === undefined) door = await deps.startDoor(options.kernel, options.port);
  else output.err("web: reusing running door");
  output.out(door.url);
  if (!wasRunning && options.browser) deps.openBrowser(door.url);
  return 0;
}

const realDeps: OpenDeps = {
  daemonRunning: (kernel) => daemonRunning(kernel),
  ensure: (kernel) => ensure(kernel),
  findDoor: (kernel) => liveDoor(kernel),
  startDoor,
  openBrowser,
};

export class OpenCommand extends KernelCommand {
  static paths = [["open"]];
  static usage = Command.Usage({
    category: "Client",
    description:
      "start the daemon and a background web server if needed, print the URL, open the browser on first start",
  });

  port = Option.String("--port", "8787", { description: "preferred loopback port; a free one is picked when busy" });
  noBrowser = Option.Boolean("--no-browser", false, { description: "print the URL without opening a browser" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("harness open");
    if (blocked !== undefined) return blocked;
    const port = Number(this.port);
    if (!Number.isInteger(port) || port < 0) {
      this.context.writeErr("open: --port must be a whole number");
      return 1;
    }
    // Fail with the install hint before the daemon starts, not after.
    const web = await importShell(
      this.context,
      { label: "web shell", specifier: "@inhuman.tools/harness-web-app/server" },
      () => import("@inhuman.tools/harness-web-app/server"),
    );
    if (web === undefined) return 1;
    try {
      return await runOpen(
        realDeps,
        { kernel: this.kernelPath(), port, browser: !this.noBrowser },
        {
          out: (line) => this.context.stdout.write(`${line}\n`),
          err: (line) => this.context.stderr.write(`${line}\n`),
        },
      );
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
  }
}
