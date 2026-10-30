/**
 * Unattended program entry. Source is loaded before the session exists.
 * `--resume` / `--session` / `--continue` belong to the TUI attach path.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";

import { ensure } from "@inhuman.tools/harness";
import { isEvalPermissionMode, type EvalPermissionMode } from "@inhuman.tools/harness-model";
import { Command, Option } from "clipanion";
import { isEnum, makeValidator } from "typanion";

import { KernelCommand } from "./context.js";
import { runEval } from "../eval/run.js";

const isEvalMode = makeValidator<unknown, EvalPermissionMode>({
  test: (value, state): value is EvalPermissionMode => {
    const id = value === "always-approve" ? "yolo" : value;
    if (typeof id === "string" && isEvalPermissionMode(id)) {
      if (id !== value && state?.coercions != null) {
        if (state.coercion == null) return false;
        state.coercions.push([state.p ?? ".", state.coercion.bind(null, id)]);
      }
      return true;
    }
    state?.errors?.push(`Expected one of "auto", "yolo", or "always-approve" (got ${JSON.stringify(value)})`);
    return false;
  },
});

export class EvalCommand extends KernelCommand {
  static paths = [["eval"]];
  static usage = Command.Usage({
    description: "run a program once and print its result",
  });

  expression = Option.String("-e", { description: "Scheme expression", required: false });
  prompt = Option.String("-p", { description: "prompt text for bot/send", required: false });
  file = Option.String({ required: false, name: "file" });
  mode = Option.String("--mode", "auto", {
    description: "authorization policy: auto, yolo, always-approve",
    validator: isEvalMode,
  });
  format = Option.String("--format", "scheme", {
    description: "stdout encoding: scheme, json",
    validator: isEnum(["scheme", "json"] as const),
  });
  agent = Option.String("--agent", { description: "bot/send target", required: false });
  resume = Option.String("--resume", { description: "TUI attach; illegal with eval", required: false });
  session = Option.String("--session", { description: "TUI attach; illegal with eval", required: false });
  continueLast = Option.Boolean("--continue,-c", false, {
    description: "TUI attach; illegal with eval",
  });

  async execute(): Promise<number> {
    if (this.resume != null || this.session != null || this.continueLast) {
      this.context.writeErr("eval cannot attach with --resume, --session, or --continue");
      return 2;
    }
    if (this.prompt != null && (this.expression != null || this.file != null)) {
      this.context.writeErr("-p cannot combine with -e or a .scm file");
      return 2;
    }
    if (this.prompt == null && this.expression == null && this.file == null) {
      this.context.writeErr("eval requires -e, -p, or a .scm file");
      return 2;
    }
    let expr: string;
    let source: string | undefined;
    let sourcePath: string | undefined;
    try {
      if (this.file == null) {
        const raw = this.expression ?? this.prompt ?? "";
        const body = raw === "-" ? await text(this.context.stdin) : raw;
        if (this.prompt == null) {
          expr = body;
        } else if (this.agent == null || this.agent.trim() === "") {
          this.context.writeErr("-p requires --agent");
          return 2;
        } else {
          const atom = /^[a-z][\w/!?+.-]*$/i.test(this.agent) ? `'${this.agent}` : JSON.stringify(this.agent);
          expr = `(bot/send ${atom} ${JSON.stringify(body)})`;
        }
      } else {
        sourcePath = resolve(this.context.cwd, this.file);
        const fileText = await readFile(sourcePath, "utf8");
        if (this.expression == null) {
          expr = fileText;
        } else {
          source = fileText;
          const raw = this.expression;
          expr = raw === "-" ? await text(this.context.stdin) : raw;
        }
      }
    } catch (error) {
      this.context.writeErr(error);
      return 1;
    }
    return runEval({
      kernel: this.kernelPath(),
      project: this.context.cwd,
      expr,
      source,
      sourcePath,
      policy: this.mode,
      format: this.format,
      agent: this.cliAgentFlags(),
      streams: this.context,
      ensure,
    });
  }
}
