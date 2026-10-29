/**
 * Pi `tool_call` gate. Structured output. Sage and Jev are sibling packages.
 * Pi has no ask verdict. The decide document is the command or the path, never file contents.
 * Every tool is gated: shell goes through the bash floor, write/edit through the write floor,
 * read/grep/find/ls through the read floor, and any other tool (extension, MCP bridge) is put
 * to the judge by name and arguments unless the operator lists it in `trustedTools`.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { EnvCapability } from "@here.build/arrival";
import {
  decideAnswer,
  decidePrompt,
  structuredOutputDecideCapability,
  type DecideComplete,
} from "@inhuman.tools/env-capability-decision-structured";
import {
  acknowledgeRequirement,
  authorizationProgram,
  authorize,
  checkToolPath,
  defaultPolicy,
  floorVerdictOf,
  JUDGE_DEADLINE_MS,
  mergeAcknowledge,
  requestAcknowledgement,
  withDeadline,
  type AckFlag,
  type Acknowledger,
} from "@inhuman.tools/policy";

import {
  agentDirectory,
  CONFIG_DIR_NAME,
  gateEnabled,
  PROGRAM_FILE,
  readAcknowledge,
  readEnabled,
  SETTINGS_FILE,
} from "./seat.js";

export type ToolCall = {
  readonly toolName: string;
  readonly input: unknown;
};

export type Block = {
  readonly block: true;
  readonly reason: string;
};

export type Judge = (document: string) => Promise<"allow" | "deny" | null>;

export type BackendBinding =
  | { readonly kind: "deny" }
  | {
      readonly kind: "capability";
      readonly capability: EnvCapability;
      readonly config?: Readonly<Record<string, unknown>>;
    };

export type GateOptions = {
  readonly program?: string;
  readonly judge?: Judge;
  readonly enabled?: boolean;
  readonly binding?: BackendBinding;
  /** Model completion for the default (structured) capability; ignored when a `binding` is given. */
  readonly complete?: DecideComplete;
  /** Anchor for relative and absolute tool paths. Default is the process cwd. */
  readonly cwd?: string;
  /** Judge budget in ms; expiry denies. */
  readonly deadlineMs?: number;
  /** Tool names that skip the judge (never the path floors of read/write tools). */
  readonly trustedTools?: readonly string[];
  /**
   * `needsAcknowledgement` flags (union of the user and project layers). A flagged call that would
   * otherwise run needs an acknowledgement; a block or a denial is never softened by one.
   */
  readonly acknowledgeFlags?: readonly AckFlag[];
  /** The host prompt. Absent (print/RPC mode) a flagged call blocks with "needs acknowledgement: <label>". */
  readonly acknowledge?: Acknowledger;
};

export type GateFiles = {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  remove(file: string): void;
};

/** The slice of pi's `AssistantMessage` the judge reads (`@earendil-works/pi-ai`). */
export type PiAssistantMessage = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly stopReason: string;
  readonly errorMessage?: string;
};

/** Pi's `ModelRegistry.complete(model, context, options)`: auth is resolved per request. */
export type PiModelRegistry = {
  complete(
    model: unknown,
    context: {
      readonly systemPrompt?: string;
      readonly messages: readonly { readonly role: "user"; readonly content: string; readonly timestamp: number }[];
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PiAssistantMessage>;
};

export type PiCtx = {
  readonly hasUI: boolean;
  /** Pi's current model; undefined when none is selected. */
  readonly model?: unknown;
  readonly modelRegistry?: PiModelRegistry;
  readonly cwd: string;
  isProjectTrusted(): boolean;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    /** Upstream pi's `ui.confirm`. Unverified here, so optional: `input` is the fallback. */
    confirm?(title: string, message: string): Promise<boolean>;
  };
};

export type PiHost = {
  on(
    event: "tool_call",
    handler: (event: ToolCall, ctx: PiCtx) => Promise<Block | undefined> | Block | undefined,
  ): void;
  on(event: "session_start", handler: (event: unknown, ctx: PiCtx) => void): void;
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: PiCtx) => Promise<void> },
  ): void;
};

export type Seat = {
  readonly agentDir: string;
  readonly configDirName: string;
  readonly files: GateFiles;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly judge?: Judge;
  readonly program?: string;
  readonly acknowledge?: Acknowledger;
};

export type GateHooks = {
  /** Return true when this package handled the command. */
  command?(args: string, ctx: PiCtx, seat: Seat): Promise<boolean>;
  bind?(seat: Seat): BackendBinding;
  status?(seat: Seat): string;
  warnUnconfigured?(seat: Seat): boolean;
  usage?: string;
};

export type RegisterOptions = GateOptions & {
  readonly agentDir?: string;
  readonly cwd?: string;
  readonly configDirName?: string;
  readonly files?: GateFiles;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
};

function blocked(reason: string): Block {
  return { block: true, reason };
}

/** The judge's completion on pi's current model; undefined (judged calls deny) when pi has none. */
function piComplete(ctx: PiCtx): DecideComplete | undefined {
  const { model, modelRegistry } = ctx;
  if (model === undefined || model === null || modelRegistry === undefined) return undefined;
  return async (request) => {
    const prompt = decidePrompt(request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_DEADLINE_MS);
    try {
      const reply = await modelRegistry.complete(
        model,
        { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] },
        { signal: controller.signal },
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(reply.errorMessage ?? `judge model ${reply.stopReason}`);
      }
      return decideAnswer(reply.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""));
    } finally {
      clearTimeout(timer);
    }
  };
}

function nodeFiles(): GateFiles {
  return {
    read(file) {
      try {
        return readFileSync(file, "utf8");
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    write(file, text) {
      const parent = path.dirname(file);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
      chmodSync(file, 0o600);
      if (path.basename(parent) === "secrets") chmodSync(parent, 0o700);
    },
    remove(file) {
      rmSync(file, { force: true });
    },
  };
}

/** What `decide` learned about the call, for the acknowledgement step. */
type Probe = { kind?: "bash" | "write" | "read" | "other"; document?: string };

export async function evaluateCall(call: ToolCall, judgeOrOptions?: Judge | GateOptions): Promise<Block | undefined> {
  const options: GateOptions =
    typeof judgeOrOptions === "function" ? { judge: judgeOrOptions } : (judgeOrOptions ?? {});
  if (options.enabled === false) return undefined;
  const probe: Probe = {};
  const decided = await decide(call, options, probe);
  if (decided !== undefined) return decided;
  return acknowledgeGate(call, options, probe);
}

/** The call would run. A matching flag makes it ask the host first. */
async function acknowledgeGate(call: ToolCall, options: GateOptions, probe: Probe): Promise<Block | undefined> {
  const flags = options.acknowledgeFlags ?? [];
  if (flags.length === 0) return undefined;
  const { kind, document } = probe;
  const where = options.cwd === undefined ? {} : { cwd: options.cwd };
  const verdict =
    kind === "bash" && document !== undefined
      ? floorVerdictOf({ kind, command: document })
      : (kind === "read" || kind === "write") && document !== undefined
        ? floorVerdictOf({ kind, path: document, ...where })
        : undefined;
  const requirement = acknowledgeRequirement(flags, {
    tool: call.toolName,
    ...(verdict === undefined ? {} : { verdict }),
  });
  if (requirement === null) return undefined;
  const reason = await requestAcknowledgement(
    requirement,
    call.toolName,
    document ?? describeInput(call.input),
    options.acknowledge,
  );
  return reason === undefined ? undefined : blocked(reason);
}

async function decide(call: ToolCall, options: GateOptions, probe: Probe): Promise<Block | undefined> {
  const fields: Record<string, unknown> = {};
  const rawInput = call.input;
  if (typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
    Object.assign(fields, rawInput);
  }
  let kind: "bash" | "write" | "read" | "other";
  let document: string;
  switch (call.toolName) {
    case "bash":
    case "powershell": {
      const command = fields.command;
      if (typeof command !== "string") return blocked("missing command or path");
      kind = "bash";
      document = command;
      break;
    }
    case "write":
    case "edit": {
      const file = fields.path;
      if (typeof file !== "string") return blocked("missing command or path");
      kind = "write";
      document = file;
      break;
    }
    case "read": {
      const file = fields.path;
      if (typeof file !== "string") return blocked("missing command or path");
      kind = "read";
      document = file;
      break;
    }
    case "grep":
    case "find":
    case "ls": {
      // The search root is optional and defaults to the working directory.
      const file = fields.path === undefined ? "." : fields.path;
      if (typeof file !== "string") return blocked("missing command or path");
      kind = "read";
      document = file;
      break;
    }
    default:
      probe.kind = "other";
      if (options.trustedTools?.includes(call.toolName) === true) return undefined;
      kind = "other";
      document = `${call.toolName} ${describeInput(rawInput)}`;
  }
  probe.kind = kind;
  if (kind !== "other") probe.document = document;
  const where = options.cwd === undefined ? undefined : { cwd: options.cwd };
  const disposition =
    kind === "bash" ? defaultPolicy.bash(document) : kind === "other" ? "ask" : checkToolPath(kind, document, where);
  if (disposition === "policyApprove") return undefined;
  if (disposition === "block") return blocked("blocked by policy floor");
  try {
    let verdict: "allow" | "deny" | null;
    if (options.judge !== undefined) {
      verdict = await withDeadline(Promise.resolve(options.judge(document)), options.deadlineMs);
    } else if (options.binding?.kind === "deny") {
      verdict = "deny";
    } else {
      const binding = options.binding ?? {
        kind: "capability" as const,
        capability: structuredOutputDecideCapability,
        ...(options.complete === undefined ? {} : { config: { complete: options.complete } }),
      };
      verdict = await withDeadline(
        authorize(document, {
          capability: binding.capability,
          ...(binding.config === undefined ? {} : { config: binding.config }),
          ...(options.program === undefined ? {} : { program: options.program }),
        }),
        options.deadlineMs,
      );
    }
    if (verdict === "allow") return undefined;
    return blocked("not authorized");
  } catch (error) {
    const reason = error instanceof Error && error.message !== "" ? error.message : "not authorized";
    return blocked(reason);
  }
}

function describeInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = "[unserializable arguments]";
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

const reported = new WeakMap<Seat, Set<string>>();

/** An unreadable settings file is "not present". A trusted project's file also says so, once. */
function readSetting(seat: Seat, ctx: PiCtx, file: string, report: boolean): boolean | undefined {
  try {
    return readEnabled(seat.files.read(file));
  } catch (error) {
    const seen = reported.get(seat) ?? new Set<string>();
    reported.set(seat, seen);
    if (report && !seen.has(file)) {
      seen.add(file);
      notify(
        ctx,
        `policy-pi: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    return undefined;
  }
}

function enabledNow(seat: Seat, ctx: PiCtx): boolean {
  const trusted = ctx.isProjectTrusted();
  const user = readSetting(seat, ctx, path.join(seat.agentDir, SETTINGS_FILE), true);
  // The project file is read only once the project is trusted: an untrusted repo cannot
  // even make this gate look at (or trip over) a file it ships.
  const project = trusted
    ? readSetting(seat, ctx, path.join(ctx.cwd, seat.configDirName, SETTINGS_FILE), true)
    : undefined;
  return gateEnabled(user, project, trusted);
}

function notify(ctx: PiCtx, message: string, type: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function runCommand(args: string, ctx: PiCtx, seat: Seat, hooks: GateHooks | undefined): Promise<void> {
  if (hooks?.command !== undefined && (await hooks.command(args, ctx, seat))) return;
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  const head = words[0];
  const detail = words[1];
  if (words.length === 0 || head === "status") {
    const detailText = hooks?.status?.(seat) ?? "structured output";
    const program =
      seat.files.read(path.join(seat.agentDir, PROGRAM_FILE)) === undefined ? "dist program" : "user program";
    notify(ctx, `${detailText}; ${program}; ${enabledNow(seat, ctx) ? "gate on" : "gate off"}`, "info");
    return;
  }
  if (head === "program" && detail === "edit") {
    if (!ctx.hasUI) return;
    const file = path.join(seat.agentDir, PROGRAM_FILE);
    const next = await ctx.ui.editor("Authorization program", seat.files.read(file) ?? authorizationProgram());
    if (next === undefined) return;
    if (next.trim() === "") {
      notify(ctx, "empty program not stored", "warning");
      return;
    }
    seat.files.write(file, next);
    notify(ctx, "authorization program stored", "info");
    return;
  }
  if (head === "program" && detail === "clear") {
    seat.files.remove(path.join(seat.agentDir, PROGRAM_FILE));
    notify(ctx, "dist authorization program", "info");
    return;
  }
  notify(ctx, hooks?.usage ?? "usage: status | program edit|clear", "warning");
}

/** An unreadable file is "not present", as for `enabled`; `readSetting` already reports it. */
function readQuietly(seat: Seat, file: string): string | undefined {
  try {
    return seat.files.read(file);
  } catch {
    return undefined;
  }
}

/** `ui.confirm` when the host has it, else a yes/no `ui.input`. No UI (print/RPC mode): none. */
function hostAcknowledger(ctx: PiCtx): Acknowledger | undefined {
  if (!ctx.hasUI) return undefined;
  const ui = ctx.ui;
  return async (request) => {
    const body = request.why === undefined ? request.detail : `${request.detail}\n${request.why}`;
    if (ui.confirm !== undefined) return ui.confirm(request.summary, body);
    const answer = await ui.input(`${request.summary} ${body} (yes/no)`, "no");
    return /^\s*(y|yes)\s*$/i.test(answer ?? "");
  };
}

export function register(pi: PiHost, options?: RegisterOptions, hooks?: GateHooks): void {
  const seat: Seat = {
    agentDir: options?.agentDir ?? agentDirectory(options?.env ?? process.env, options?.home ?? homedir()),
    configDirName: options?.configDirName ?? CONFIG_DIR_NAME,
    files: options?.files ?? nodeFiles(),
    env: options?.env ?? process.env,
    cwd: options?.cwd ?? process.cwd(),
    ...(options?.judge === undefined ? {} : { judge: options.judge }),
    ...(options?.program === undefined ? {} : { program: options.program }),
    ...(options?.acknowledge === undefined ? {} : { acknowledge: options.acknowledge }),
  };
  pi.on("session_start", (_event, ctx) => {
    const warn = hooks?.warnUnconfigured?.(seat) ?? piComplete(ctx) === undefined;
    if (!ctx.hasUI || !enabledNow(seat, ctx) || !warn) return;
    ctx.ui.notify(
      hooks?.warnUnconfigured === undefined
        ? "policy-pi has no model; judged calls block"
        : "policy-pi has no decision key; judged calls block",
      "warning",
    );
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!enabledNow(seat, ctx)) return undefined;
      let program = seat.program;
      if (program === undefined) {
        const text = seat.files.read(path.join(seat.agentDir, PROGRAM_FILE));
        if (text?.trim() === "") return blocked("authorization program is empty");
        if (text !== undefined) program = text;
      }
      const binding = hooks?.bind?.(seat);
      const complete = piComplete(ctx);
      // Flags only tighten, so the project file is read whether or not it is trusted. A file that does
      // not parse throws here and blocks the call with its message.
      const flags = mergeAcknowledge(
        readAcknowledge(readQuietly(seat, path.join(seat.agentDir, SETTINGS_FILE))),
        readAcknowledge(readQuietly(seat, path.join(ctx.cwd, seat.configDirName, SETTINGS_FILE))),
        options?.acknowledgeFlags,
      );
      const acknowledge = seat.acknowledge ?? hostAcknowledger(ctx);
      return await evaluateCall(event, {
        cwd: ctx.cwd,
        ...(flags.length === 0 ? {} : { acknowledgeFlags: flags }),
        ...(acknowledge === undefined ? {} : { acknowledge }),
        ...(program === undefined ? {} : { program }),
        ...(seat.judge === undefined ? {} : { judge: seat.judge }),
        ...(binding === undefined ? {} : { binding }),
        ...(complete === undefined ? {} : { complete }),
      });
    } catch (error) {
      // A handler that throws leaves pi's behaviour to pi; this gate answers for itself.
      return blocked(error instanceof Error && error.message !== "" ? error.message : "policy gate failed");
    }
  });
  pi.registerCommand("policy-pi", {
    description: "Policy gate: status, login, logout, and the authorization program",
    handler: (args, ctx) => runCommand(args, ctx, seat, hooks),
  });
}

export default register;
