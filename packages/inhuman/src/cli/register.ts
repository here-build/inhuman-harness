/**
 * Clipanion's Cli.run writes usage failures to stdout and exits 1.
 * Usage belongs on stderr with code 2; runtime failures stay 1.
 * Pin is 4.0.0-rc.4: 3.2.1's ESM build directory-imports `lib/platform`, which Node rejects.
 */
import { Builtins, Cli } from "clipanion";

import { BlobsCommand, BlobsVacuumCommand } from "./blobs-command.js";
import { CompleteCommand, CompletionCommand } from "./completion-command.js";
import { ShellContext, type Streams } from "./context.js";
import { DaemonCommand, DaemonRestartCommand, DaemonStartCommand, DaemonStopCommand } from "./daemon.js";
import { EvalCommand } from "./eval-command.js";
import { InstallCommand } from "./install-command.js";
import {
  McpAddCommand,
  McpCommand,
  McpDisableCommand,
  McpEnableCommand,
  McpGetCommand,
  McpListCommand,
  McpLoginCommand,
  McpLogoutCommand,
  McpRemoveCommand,
} from "./mcp-commands.js";
import { LoginCommand, LogoutCommand, RemoteCommand, RemoteStatusCommand } from "./remote-commands.js";
import { TuiCommand } from "./tui-command.js";
import { exportWebStaticDir } from "./web-static.js";
import { StartCommand, WebCommand } from "./web-commands.js";
import { WebDoorCommand } from "./web-door-command.js";

const NAMED = new Set([
  "mcp",
  "daemon",
  "blobs",
  "help",
  "eval",
  "install",
  "completion",
  "complete",
  "start",
  "web",
  "web-door",
  "login",
  "logout",
  "remote",
  "-h",
  "--help",
]);
const VALUE_FLAGS = new Set([
  "--kernel",
  "--session",
  "--resume",
  "--mode",
  "--format",
  "--agent",
  "--connection",
  "--model",
  "-e",
  "-p",
]);

/** Clipanion default path is TUI. Deleting this rewrite sends `-e` / `.scm` to attach. */
export function isEvalArgv(argv: readonly string[]): boolean {
  const head = argv[0];
  if (head != null && NAMED.has(head)) return false;
  let pendingValue = false;
  let hasInput = false;
  let hasEvalFlag = false;
  for (const arg of argv) {
    if (pendingValue) {
      pendingValue = false;
      continue;
    }
    if (arg === "-e" || arg === "-p") {
      hasInput = true;
      pendingValue = true;
      continue;
    }
    if (arg === "--mode" || arg === "--format" || arg === "--agent") {
      hasEvalFlag = true;
      pendingValue = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      pendingValue = true;
      continue;
    }
    if (!arg.startsWith("-") && arg.endsWith(".scm")) hasInput = true;
  }
  return hasInput || hasEvalFlag;
}

const COMMANDS = [
  Builtins.HelpCommand,
  TuiCommand,
  StartCommand,
  WebCommand,
  WebDoorCommand,
  CompletionCommand,
  CompleteCommand,
  EvalCommand,
  InstallCommand,
  DaemonCommand,
  DaemonStartCommand,
  DaemonStopCommand,
  DaemonRestartCommand,
  McpCommand,
  McpAddCommand,
  McpListCommand,
  McpGetCommand,
  McpRemoveCommand,
  McpLoginCommand,
  McpLogoutCommand,
  McpEnableCommand,
  McpDisableCommand,
  BlobsCommand,
  BlobsVacuumCommand,
  LoginCommand,
  LogoutCommand,
  RemoteCommand,
  RemoteStatusCommand,
];

export function makeCli(): Cli<ShellContext> {
  return Cli.from(COMMANDS, {
    binaryLabel: "Inhuman",
    binaryName: "inhuman",
    enableCapture: false,
  });
}

export async function runCli(argv: readonly string[], streams: Streams): Promise<number> {
  exportWebStaticDir();
  const cli = makeCli();
  const context = new ShellContext(streams);
  let command;
  try {
    const routed = isEvalArgv(argv) ? ["eval", ...argv] : [...argv];
    command = cli.process(routed, context);
  } catch (error) {
    streams.stderr.write(cli.error(error, { colored: context.colorDepth > 1 }));
    return 2;
  }
  return cli.run(command, context);
}
