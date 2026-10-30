import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  hasCliAgentFlags,
  unsupportedAgentFlagsError,
  type CliAgentFlags,
  type ShellStreams,
  type Streams,
} from "@inhuman.tools/harness-sdk/launch";
import { Command, Option, type BaseContext } from "clipanion";

export type { Streams } from "@inhuman.tools/harness-sdk/launch";

export class ShellContext implements BaseContext, ShellStreams {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly colorDepth: number;

  // Own field, not a prototype method. Clipanion's Cli.process and Cli.run
  // replace the context with `{ ...defaultContext, ...context }`, which drops
  // the prototype. A method here is undefined on `this.context` inside commands.
  readonly writeErr = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    this.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  constructor(streams: Streams) {
    this.stdin = streams.stdin;
    this.stdout = streams.stdout;
    this.stderr = streams.stderr;
    this.cwd = streams.cwd ?? process.cwd();
    this.env = process.env;
    this.colorDepth = this.#colorDepth();
  }

  #colorDepth(): number {
    if (typeof this.stdout.getColorDepth === "function") {
      try {
        return this.stdout.getColorDepth();
      } catch {
        /* NODE_COLOR_DEPTH: WriteStream.getColorDepth() throws off-TTY */
      }
    }
    return 1;
  }
}

export abstract class KernelCommand extends Command<ShellContext> {
  kernel = Option.String("--kernel", join(homedir(), ".harness"), {
    description: "system folder",
  });
  connection = Option.String("--connection", {
    description: "completion connection id",
    required: false,
  });
  model = Option.String("--model", {
    description: "model id (unique across connections unless --connection)",
    required: false,
  });

  kernelPath(): string {
    return resolve(this.kernel);
  }

  cliAgentFlags(): CliAgentFlags {
    return {
      ...(this.connection == null ? {} : { connection: this.connection }),
      ...(this.model == null ? {} : { model: this.model }),
    };
  }

  rejectUnsupportedAgentFlags(surface: string): number | undefined {
    if (!hasCliAgentFlags(this.cliAgentFlags())) return undefined;
    this.context.writeErr(unsupportedAgentFlagsError(surface));
    return 2;
  }
}
