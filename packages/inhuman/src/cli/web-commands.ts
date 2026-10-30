import { daemonRunning, ensure } from "@inhuman.tools/harness";
import { Command, Option } from "clipanion";

import { openBrowser } from "./browser.js";
import { KernelCommand, type ShellContext } from "./context.js";
import { importShell } from "./shell-import.js";
import { liveDoor, startDoor, type DoorRecord } from "./web-door.js";

export type ServeDeps = {
  readonly daemonRunning: (kernel: string) => Promise<boolean>;
  readonly ensure: (kernel: string) => Promise<void>;
  readonly findDoor: (kernel: string) => Promise<DoorRecord | undefined>;
  readonly startDoor: (kernel: string, port: number) => Promise<DoorRecord>;
  readonly openBrowser: (url: string) => void;
};

export type ServeOptions = {
  readonly kernel: string;
  readonly port: number;
};

export type WebOptions = ServeOptions & {
  readonly browser: boolean;
};

export type ServeOutput = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/**
 * Daemon up and web door up, both left running in the background. Progress goes to `err`; the caller
 * decides what to print and whether to open a browser. Shared by `start`, `web` and `login`.
 */
export async function ensureServing(deps: ServeDeps, options: ServeOptions, output: ServeOutput): Promise<DoorRecord> {
  const wasRunning = await deps.daemonRunning(options.kernel);
  await deps.ensure(options.kernel);
  output.err(wasRunning ? "daemon: already running" : "daemon: started");
  const live = await deps.findDoor(options.kernel);
  if (live !== undefined) {
    output.err("web: reusing running door");
    return live;
  }
  return deps.startDoor(options.kernel, options.port);
}

/** `inhuman start`: serve in the background, print the URL, never open a browser. */
export async function runStart(deps: ServeDeps, options: ServeOptions, output: ServeOutput): Promise<number> {
  const door = await ensureServing(deps, options, output);
  output.out(door.url);
  return 0;
}

/** `inhuman web`: serve in the background, print the URL, open the browser unless told not to. */
export async function runWeb(deps: ServeDeps, options: WebOptions, output: ServeOutput): Promise<number> {
  const door = await ensureServing(deps, options, output);
  output.out(door.url);
  if (options.browser) deps.openBrowser(door.url);
  return 0;
}

export const realServeDeps: ServeDeps = {
  daemonRunning: (kernel) => daemonRunning(kernel),
  ensure: (kernel) => ensure(kernel),
  findDoor: (kernel) => liveDoor(kernel),
  startDoor,
  openBrowser,
};

export function serveOutput(context: ShellContext): ServeOutput {
  return {
    out: (line) => context.stdout.write(`${line}\n`),
    err: (line) => context.stderr.write(`${line}\n`),
  };
}

export function parsePort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 ? port : undefined;
}

/** Fails with the install hint before the daemon starts, not after. */
export async function webShellInstalled(context: ShellContext): Promise<boolean> {
  const web = await importShell(
    context,
    { label: "web shell", specifier: "@inhuman.tools/harness-web-app/server" },
    () => import("@inhuman.tools/harness-web-app/server"),
  );
  return web !== undefined;
}

abstract class ServeCommand extends KernelCommand {
  abstract readonly verb: string;
  port = Option.String("--port", "8787", { description: "preferred loopback port; a free one is picked when busy" });

  protected async serve(run: (kernel: string, port: number) => Promise<number>): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags(`inhuman ${this.verb}`);
    if (blocked !== undefined) return blocked;
    const port = parsePort(this.port);
    if (port === undefined) {
      this.context.writeErr(`${this.verb}: --port must be a whole number`);
      return 1;
    }
    if (!(await webShellInstalled(this.context))) return 1;
    try {
      return await run(this.kernelPath(), port);
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
  }
}

export class StartCommand extends ServeCommand {
  static paths = [["start"]];
  static usage = Command.Usage({
    category: "Client",
    description: "start the daemon and its web server in the background, print the URL, and return",
    details: `
      Leaves the daemon and a loopback web server running. Does not open a browser; use \`inhuman web\` for that.
    `,
  });
  readonly verb = "start";

  execute(): Promise<number> {
    return this.serve((kernel, port) => runStart(realServeDeps, { kernel, port }, serveOutput(this.context)));
  }
}

export class WebCommand extends ServeCommand {
  static paths = [["web"]];
  static usage = Command.Usage({
    category: "Client",
    description: "start the daemon and web server if needed, then open the web client in the browser",
  });
  readonly verb = "web";

  noBrowser = Option.Boolean("--no-browser", false, { description: "print the URL without opening a browser" });

  execute(): Promise<number> {
    return this.serve((kernel, port) =>
      runWeb(realServeDeps, { kernel, port, browser: !this.noBrowser }, serveOutput(this.context)),
    );
  }
}
