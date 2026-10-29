/**
 * How a host tool call looks to plugin guards and hooks: the guard point,
 * the paths it touches (relative to the session root when inside it), the
 * raw value, and how a narrowed value becomes the job's arguments again.
 */
import { isAbsolute, normalize, relative } from "node:path";

import { AgentCallJob, MCPToolJob, SystemToolJob, type ToolCallJob } from "@inhuman.tools/harness-model";

import {
  jsonToVal,
  outcomeValue,
  toolResultOf,
  deepEqual,
  Dict,
  toJS,
  type GuardPoint,
  type ToolOutcome,
  type Val,
} from "@/extensions";

export type GuardedCall = {
  readonly point: GuardPoint;
  readonly paths: readonly string[];
  readonly raw: Val;
  /**
   * The job's arguments for a value a guard passed on, or why it cannot be one.
   * `tools` is set when an agent guard narrowed the child's tool list.
   */
  readonly argsFor: (value: Val) =>
    | {
        readonly args: Readonly<Record<string, unknown>> | null;
        readonly tools?: readonly string[];
        readonly speech?: string;
      }
    | { readonly error: string };
};

type Args = Readonly<Record<string, unknown>>;

function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** A tool path as guard matchers see it: relative to the root when inside it. */
export function scopedPath(root: string, path: string): string {
  const trimmed = path.trim() === "" ? "." : path.trim();
  if (!isAbsolute(trimmed)) return normalize(trimmed);
  if (root === "") return trimmed;
  const inner = relative(root, trimmed);
  if (inner === "") return ".";
  return inner.startsWith("..") || isAbsolute(inner) ? trimmed : inner;
}

function narrowed(original: Val, value: Val, write: (plain: unknown) => Args | string, args: Args | null) {
  if (deepEqual(original, value)) return { args };
  const next = write(toJS(value));
  return typeof next === "string" ? { error: next } : { args: next };
}

const READ_PATH_KEY: Readonly<Record<string, readonly string[]>> = {
  read_file: ["path"],
  list_dir: ["path"],
  grep: ["path"],
  glob: ["cwd", "path"],
  fff_search: ["cwd", "path"],
};

function readCall(job: ToolCallJob, args: Args, root: string): GuardedCall {
  const keys = READ_PATH_KEY[job.name] ?? ["path"];
  const key = keys.find((name) => text(args, name) !== "") ?? keys[0];
  const raw = text(args, key) || ".";
  return {
    point: "read",
    paths: [scopedPath(root, raw)],
    raw,
    argsFor: (value) =>
      narrowed(
        raw,
        value,
        (plain) => (typeof plain === "string" ? { ...args, [key]: plain } : "a read guard must pass a path"),
        job.args,
      ),
  };
}

function systemCall(job: SystemToolJob, args: Args, root: string): GuardedCall | null {
  switch (job.name) {
    case "shell": {
      const raw = text(args, "command");
      return {
        point: "shell",
        paths: [],
        raw,
        argsFor: (value) =>
          narrowed(
            raw,
            value,
            (plain) => (typeof plain === "string" ? { ...args, command: plain } : "a shell guard must pass a command"),
            job.args,
          ),
      };
    }
    case "read_file":
    case "list_dir":
    case "grep":
    case "glob":
    case "fff_search": {
      return readCall(job, args, root);
    }
    case "write_file": {
      const path = text(args, "path");
      const raw = new Dict({ paths: [path], contents: text(args, "content") });
      return {
        point: "write",
        paths: [scopedPath(root, path)],
        raw,
        argsFor: (value) =>
          narrowed(
            raw,
            value,
            (plain) => {
              const { paths, contents } = (plain ?? {}) as {
                paths?: unknown;
                contents?: unknown;
              };
              if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== "string") {
                return "a write guard must pass exactly one path";
              }
              if (typeof contents !== "string") return "a write guard must pass string contents";
              return { ...args, path: paths[0], content: contents };
            },
            job.args,
          ),
      };
    }
    case "edit_file": {
      const raw = new Dict({
        old: text(args, "old_string"),
        new: text(args, "new_string"),
      });
      return {
        point: "edit",
        paths: [scopedPath(root, text(args, "path"))],
        raw,
        argsFor: (value) =>
          narrowed(
            raw,
            value,
            (plain) => {
              const { old, new: next } = (plain ?? {}) as {
                old?: unknown;
                new?: unknown;
              };
              if (typeof old !== "string" || typeof next !== "string") return "an edit guard must pass strings";
              return { ...args, old_string: old, new_string: next };
            },
            job.args,
          ),
      };
    }
    default: {
      return null;
    }
  }
}

function mcpCall(job: MCPToolJob, args: Args): GuardedCall {
  const server = job.connectionKey.trim();
  const tool = job.serverToolName.trim() || job.name;
  const raw = new Dict({ server, tool, opts: jsonToVal(args) });
  return {
    point: "mcp",
    paths: [`${server}/${tool}`],
    raw,
    argsFor: (value) =>
      narrowed(
        raw,
        value,
        (plain) => {
          const row = (plain ?? {}) as {
            server?: unknown;
            tool?: unknown;
            opts?: unknown;
          };
          if (row.server !== server || row.tool !== tool) return "an mcp guard may not reroute the call";
          if (row.opts == null || typeof row.opts !== "object" || Array.isArray(row.opts)) {
            return "an mcp guard must pass options as a dict";
          }
          return row.opts as Args;
        },
        job.args,
      ),
  };
}

/**
 * An agent call as `(prompt tools)`. `tools` is what the child would be
 * granted; a guard may only drop entries, and only for a child minted for
 * this call (`fresh`): a standing bot keeps the tools it was created with.
 */
export function agentGuardedCall(
  job: ToolCallJob,
  spec: string,
  tools: readonly string[],
  fresh: boolean,
): GuardedCall | null {
  const authored = job instanceof AgentCallJob && job.promptMessages.length > 0;
  const args = job.args;
  if (args == null && !authored) return null;
  const prompt = authored && job instanceof AgentCallJob ? job.speech : text(args ?? {}, "message");
  const raw = new Dict({ prompt, tools: [...tools] });
  return {
    point: "agent",
    paths: spec === "" ? [] : [spec],
    raw,
    argsFor: (value) => {
      if (deepEqual(raw, value)) return { args: job.args };
      const { prompt: nextPrompt, tools: next } = (toJS(value) ?? {}) as {
        prompt?: unknown;
        tools?: unknown;
      };
      if (typeof nextPrompt !== "string") return { error: "an agent guard must pass a string prompt" };
      if (!Array.isArray(next) || !next.every((name) => typeof name === "string" && tools.includes(name))) {
        return { error: "an agent guard may only drop tools from the list" };
      }
      const kept = [...new Set(next as string[])];
      const dropped = kept.length !== new Set(tools).size;
      if (dropped && !fresh) {
        return { error: "an agent guard cannot narrow a standing bot's tools" };
      }
      if (authored && job instanceof AgentCallJob) {
        return {
          args: job.args,
          ...(nextPrompt === prompt ? {} : { speech: nextPrompt }),
          ...(dropped ? { tools: kept } : {}),
        };
      }
      const nextArgs = { ...(args ?? {}), message: nextPrompt };
      return dropped ? { args: nextArgs, tools: kept } : { args: nextArgs };
    },
  };
}

/** Null for calls no guard point covers (pack tools, job control, side channels). */
export function guardedCallOf(job: ToolCallJob, root: string): GuardedCall | null {
  const args = job.args;
  if (args == null) return null;
  if (job instanceof MCPToolJob) return mcpCall(job, args);
  if (job instanceof SystemToolJob) return systemCall(job, args, root);
  return null;
}

type OutcomeRecord = {
  readonly ok: boolean;
  readonly text?: string;
  readonly value?: unknown;
};

function recordOf(outcomeJson: string): OutcomeRecord {
  try {
    const raw: unknown = JSON.parse(outcomeJson === "" ? "{}" : outcomeJson);
    if (raw != null && typeof raw === "object") {
      const row = raw as Record<string, unknown>;
      return { ...row, ok: row.ok !== false };
    }
  } catch {
    /* a non-JSON receipt is plain text */
  }
  return { ok: true, text: outcomeJson };
}

function recordText(record: OutcomeRecord): string {
  if (typeof record.text === "string" && record.text.trim() !== "") return record.text;
  if (typeof record.value === "string") return record.value;
  if (record.value == null) return "";
  return JSON.stringify(record.value);
}

/**
 * The receipt the model sees after the tool's guards and hooks finished:
 * a guard refusal replaces it, a guard's changed result replaces it, and
 * hook diagnostics follow its text.
 */
export function guardedOutcomeJson(outcomeJson: string, outcome: ToolOutcome): string {
  if (outcome.refusal !== "") return JSON.stringify({ ok: false, text: outcome.refusal });
  const settled = outcomeValue(outcomeJson);
  const replaced = outcome.failure === "" && settled.ok && !deepEqual(outcome.result, settled.value);
  const record = replaced ? toolResultOf(outcome.result) : recordOf(outcomeJson);
  if (outcome.diagnostics.length === 0) return replaced ? JSON.stringify(record) : outcomeJson;
  return JSON.stringify({
    ...record,
    text: [recordText(record), ...outcome.diagnostics].filter(Boolean).join("\n\n"),
  });
}

/** The receipt of a call a guard kept from running. */
export function unenteredOutcome(outcome: ToolOutcome): OutcomeRecord {
  if (outcome.refusal !== "") return { ok: false, text: outcome.refusal };
  if (outcome.failure !== "") return { ok: false, text: `plugin guard failed: ${outcome.failure}` };
  return toolResultOf(outcome.result);
}
