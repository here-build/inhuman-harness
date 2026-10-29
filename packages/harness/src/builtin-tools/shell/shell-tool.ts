/**
 * Host-registered `shell` tool. Same catalog path as the FS tools; catalog
 * class is `effect`. Permission is name-keyed — not workspace auto-classes.
 *
 * Runs `/bin/sh -c`. Spill the pipes to a temp file; keep a last-N tail
 * for the model and the live peek. Do not keep a 256 KiB head.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  cancelOutcomeText,
  DEFAULT_SHELL_TAIL_BYTES,
  isTimeoutAbortReason,
  parseShellTailBytes,
} from "@inhuman.tools/harness-model";
import { optionalDescription } from "@inhuman.tools/harness-model/schemas";
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import { toolResultSchema } from "../schemas/tool-result.js";
import { resolveInRoot, ToolError } from "../toolkit/dist-tools.js";

/** Wire name. Catalog class is `effect`. */
const SHELL_TOOL_NAME = "shell";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export type ShellTailFrame = {
  readonly text: string;
  readonly totalBytes: number;
};

export type ShellResult = {
  readonly ok: boolean;
  readonly text?: string;
  readonly value: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated?: boolean;
    readonly totalBytes?: number;
  };
};

function requireRoot(ctx: { readonly root?: string }): string {
  const root = ctx.root;
  if (root == null || root === "") throw new TypeError("ctx.root string required");
  return root;
}

class TailBuffer {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  total = 0;

  constructor(readonly max: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.max <= 0 || chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#chunks.length > 1 && this.#size - (this.#chunks[0]?.length ?? 0) >= this.max) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) this.#size -= dropped.length;
    }
  }

  text(): string {
    if (this.max <= 0 || this.#size === 0) return "";
    const combined = Buffer.concat(this.#chunks);
    const slice = combined.length <= this.max ? combined : combined.subarray(combined.length - this.max);
    return slice.toString("utf8");
  }
}

function tailComment(kept: number, total: number, extra?: string): string | undefined {
  if (total <= kept && extra === undefined) return undefined;
  const cutoff =
    total > kept
      ? `tailed last ${kept} of ${total} bytes; earlier output not in context`
      : extra === undefined
        ? undefined
        : `${total} bytes`;
  const bits = [extra, cutoff].filter((part) => part !== undefined && part !== "");
  if (bits.length === 0) return undefined;
  return `…[${bits.join("; ")}]`;
}

function spillStream(sessionId: string | undefined, toolCallId: string | undefined): WriteStream | undefined {
  const session = sessionId !== undefined && sessionId !== "" ? sessionId : "anon";
  const id = toolCallId !== undefined && toolCallId !== "" ? toolCallId : `${process.pid}-${Date.now()}`;
  const file = path.join(tmpdir(), "harness-shell", session, `${id}.log`);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    return createWriteStream(file, { flags: "a" });
  } catch {
    return undefined;
  }
}

function shellAbortText(reason: unknown, timeoutMs: number): string {
  const text = cancelOutcomeText(reason);
  if (text === "cancelled") return "cancelled";
  if (isTimeoutAbortReason(reason) && (text === "timed out" || /TimeoutError/i.test(text))) {
    return `timed out after ${timeoutMs}ms`;
  }
  return text;
}

type ShellCtx = {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly tailBytes?: number;
  readonly onTail?: (frame: ShellTailFrame) => void;
};

async function runShell(
  input: {
    readonly command: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
  },
  ctx: ShellCtx,
): Promise<ShellResult> {
  const cwd = input.cwd === undefined ? ctx.root : await resolveInRoot(ctx.root, input.cwd);
  const st = await stat(cwd).catch((error: NodeJS.ErrnoException) => {
    ToolError.invariant(
      error.code !== "ENOENT",
      `shell cwd does not exist: ${input.cwd ?? "."} — drop cwd or pass a directory that exists`,
    );
    throw error;
  });
  ToolError.invariant(
    st.isDirectory(),
    `shell cwd is not a directory: ${input.cwd ?? "."} — pass a directory, or drop cwd`,
  );

  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout]);
  const tailBytes = parseShellTailBytes(ctx.tailBytes ?? DEFAULT_SHELL_TAIL_BYTES);
  const tail = new TailBuffer(tailBytes);
  const spill = spillStream(ctx.sessionId, ctx.toolCallId);

  const publish = (): void => {
    ctx.onTail?.({ text: tail.text(), totalBytes: tail.total });
  };

  return await new Promise<ShellResult>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      spill?.end();
      publish();
      const extra = signal.aborted ? shellAbortText(signal.reason, timeoutMs) : undefined;
      const cancelled = extra === "cancelled";
      const timedOut = extra !== undefined && extra !== "cancelled";
      const text = tail.text();
      const kept = Buffer.byteLength(text, "utf8");
      const comment = tailComment(kept, tail.total, extra);
      resolve({
        ok: !signal.aborted && exitCode === 0,
        ...(cancelled || timedOut ? { text: extra } : {}),
        value: {
          exitCode: signal.aborted ? null : exitCode,
          stdout: comment === undefined ? text : text === "" ? comment : `${text}\n${comment}`,
          stderr: "",
          truncated: tail.total > kept,
          totalBytes: tail.total,
          ...(ctx.toolCallId !== undefined && ctx.toolCallId !== "" ? { job_id: ctx.toolCallId } : {}),
        },
      });
    };
    const ingest = (chunk: Buffer): void => {
      tail.push(chunk);
      spill?.write(chunk);
      publish();
    };
    child.stdout?.on("data", ingest);
    child.stderr?.on("data", ingest);
    child.on("error", (error) => {
      if (signal.aborted) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => finish(exitCode));
    signal.addEventListener(
      "abort",
      () => {
        child.kill("SIGKILL");
      },
      { once: true },
    );
  }).catch((error: unknown) => {
    spill?.end();
    const extra = signal.aborted ? shellAbortText(signal.reason, timeoutMs) : "";
    ToolError.invariant(!signal.aborted, extra === "cancelled" ? "shell call cancelled" : `shell ${extra}`);
    throw error;
  });
}

function toolCallIdOf(ctx: { readonly invocation?: unknown }): string | undefined {
  const invocation = ctx.invocation;
  if (invocation === null || typeof invocation !== "object") return undefined;
  const id = (invocation as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export const shellTool = new InhumanTool({
  name: SHELL_TOOL_NAME,
  description:
    "Run a command through /bin/sh. Each call is a fresh shell — cwd and env do not persist. Prefer cwd over `cd dest && cmd`. Independent work: parallel shell calls. Sequential fail-fast: one call with &&. Requires confirmation, separately from file writes.",
  class: "effect",
  representation: "both",
  input: z.object({
    command: z.string().min(1).describe("The shell command to run."),
    cwd: z
      .preprocess((value) => (value === "" || value === null ? undefined : value), z.string().optional())
      .describe(
        "Working directory for this call. Relative to the project root (`./scripts`, `../bin`) or absolute (`/etc`). Prefer this over `cd dest &&`. Omitted or `.` is the project root.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional per-call timeout in milliseconds. Defaults to 30000; capped at 600000."),
    description: optionalDescription("command"),
  }),
  output: toolResultSchema,
  run: (input, ctx) =>
    runShell(input, {
      root: requireRoot(ctx),
      signal: ctx.signal,
      sessionId: typeof ctx.sessionId === "string" ? ctx.sessionId : undefined,
      toolCallId: toolCallIdOf(ctx),
      tailBytes: typeof ctx.shellTailBytes === "number" ? ctx.shellTailBytes : undefined,
      onTail: typeof ctx.onTail === "function" ? (ctx.onTail as ShellCtx["onTail"]) : undefined,
    }),
});
