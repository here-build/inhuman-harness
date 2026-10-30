import { ensure, stop } from "@inhuman.tools/harness";
import { Command } from "clipanion";

import { KernelCommand } from "./context.js";

export class DaemonCommand extends KernelCommand {
  static paths = [["daemon"]];
  static usage = Command.Usage({
    category: "Daemon",
    description: "start or stop the daemon",
  });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman daemon");
    if (blocked !== undefined) return blocked;
    this.context.stderr.write("Specify a daemon command: start, stop, restart\n");
    return 2;
  }
}

export class DaemonStartCommand extends KernelCommand {
  static paths = [["daemon", "start"]];
  static usage = Command.Usage({
    category: "Daemon",
    description: "start the daemon",
  });

  async execute(): Promise<number> {
    return runDaemon(this, "inhuman daemon start", () => ensure(this.kernelPath()));
  }
}

export class DaemonStopCommand extends KernelCommand {
  static paths = [["daemon", "stop"]];
  static usage = Command.Usage({
    category: "Daemon",
    description: "stop the daemon",
  });

  async execute(): Promise<number> {
    return runDaemon(this, "inhuman daemon stop", () => stop(this.kernelPath()));
  }
}

export class DaemonRestartCommand extends KernelCommand {
  static paths = [["daemon", "restart"]];
  static usage = Command.Usage({
    category: "Daemon",
    description: "restart the daemon",
  });

  async execute(): Promise<number> {
    return runDaemon(this, "inhuman daemon restart", () => ensure(this.kernelPath(), { restart: true }));
  }
}

async function runDaemon(cmd: KernelCommand, surface: string, run: () => Promise<void>): Promise<number> {
  const blocked = cmd.rejectUnsupportedAgentFlags(surface);
  if (blocked !== undefined) return blocked;
  try {
    await run();
    return 0;
  } catch (error) {
    cmd.context.writeErr(error);
    return 1;
  }
}
