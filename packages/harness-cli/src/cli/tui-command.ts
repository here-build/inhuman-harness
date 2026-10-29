/**
 * `--session` / `--resume` / `--continue` and `--restart-daemon` live only here —
 * daemon/mcp must not see them.
 */
import { ensure } from "@inhuman.tools/harness";
import { Command, Option } from "clipanion";

import { KernelCommand } from "./context.js";
import { importShell } from "./shell-import.js";

export class TuiCommand extends KernelCommand {
  static paths = [Command.Default];
  static usage = Command.Usage({
    description: "attach the TUI to the daemon",
  });

  session = Option.String("--session", { description: "session id" });
  resume = Option.String("--resume", { description: "session id (tab-complete)" });
  continueLast = Option.Boolean("--continue,-c", false, {
    description: "restore this tab's last session",
  });
  restartDaemon = Option.Boolean("--restart-daemon", false, {
    description: "stop a live daemon before attach",
  });

  async execute(): Promise<number> {
    if (this.continueLast && (this.session != null || this.resume != null)) {
      this.context.writeErr("cannot combine --continue with --resume or --session");
      return 2;
    }
    const tui = await importShell(
      this.context,
      { label: "TUI shell", specifier: "@inhuman.tools/harness-tui" },
      () => import("@inhuman.tools/harness-tui"),
    );
    if (tui === undefined) return 1;
    return tui.attachTui({
      kernel: this.kernelPath(),
      session: this.session ?? this.resume,
      continueLast: this.continueLast,
      restartDaemon: this.restartDaemon,
      agent: this.cliAgentFlags(),
      streams: this.context,
      ensure,
    });
  }
}
