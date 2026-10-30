import { installPlugin } from "@inhuman.tools/harness";
import { Command, Option } from "clipanion";

import { KernelCommand } from "./context.js";

export class InstallCommand extends KernelCommand {
  static paths = [["install"]];
  static usage = Command.Usage({
    category: "Plugins",
    description: "install a plugin into the kernel",
    examples: [["npm package", "$0 install @inhuman.tools/plugin-goal"]],
  });

  pkg = Option.String({ name: "package" });

  async execute(): Promise<number> {
    const blocked = this.rejectUnsupportedAgentFlags("inhuman install");
    if (blocked !== undefined) return blocked;
    try {
      return await installPlugin(this.context, this.kernelPath(), this.pkg);
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
  }
}
