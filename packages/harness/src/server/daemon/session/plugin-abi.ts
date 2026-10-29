/**
 * Always-on model tools. A plugin's `abi` program is behavior, loaded when
 * the plugin is enabled. It does not wait for a bot pin, and it is not a
 * state module. Handlers call that plugin's session methods.
 *
 * File ports are inner tool calls on the invoking job, so each meets the
 * session's license: the ABI tool's own license judged only its arguments,
 * and an exam lambda the model wrote must not run a shell past the floor.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { documentRoot, SessionRoot, ToolCallJob } from "@inhuman.tools/harness-model";

import {
  callDeclaredTool,
  Dict,
  jsonToVal,
  loadProgram,
  Proc,
  resolvePackageSurface,
  toJS,
  toolResultOf,
  type PluginPackage,
  type Val,
  type BehaviorKernel,
} from "@/extensions";
import type { CatalogEntry } from "@/tool-catalog";
import { ToolCallHandler } from "@/tool-runtime";

import { reportProblem, type PluginProblems } from "./plugin-bots.js";
import { type ToolContext } from "../../toolkit/executor.js";

/** Tool ctx for exam ports. Entered around each execute so concurrent calls do not share one slot. */
const examToolCtx = new AsyncLocalStorage<ToolContext>();

/** One loaded ABI and the catalog rows it contributes. */
export type PluginAbi = {
  readonly plugin: string;
  readonly entries: readonly CatalogEntry[];
};

export async function pluginAbiCatalog(
  packages: readonly PluginPackage[],
  kernel: BehaviorKernel,
  problems: PluginProblems,
): Promise<PluginAbi[]> {
  const out: PluginAbi[] = [];
  for (const plugin of packages) {
    const loaded = await loadAbi(plugin, kernel, problems);
    if (loaded != null) out.push(loaded);
  }
  return out;
}

async function loadAbi(
  plugin: PluginPackage,
  kernel: BehaviorKernel,
  problems: PluginProblems,
): Promise<PluginAbi | null> {
  let surface;
  try {
    surface = resolvePackageSurface(plugin.root);
  } catch (error) {
    reportProblem(problems, plugin.name, messageOf(error));
    return null;
  }
  if (surface.abi == null) return null;
  const abi = surface.abi;
  let registry;
  try {
    registry = await loadProgram({
      agentId: `${plugin.name}:abi`,
      source: abi.source,
      filename: abi.path,
      revision: `${plugin.name}@abi`,
      root: plugin.root,
      read: (path) => readFileSync(path, "utf8"),
      kind: "behavior",
      environment: examEnvironment(),
    });
  } catch (error) {
    reportProblem(problems, plugin.name, messageOf(error));
    return null;
  }
  const entries: CatalogEntry[] = [];
  for (const decl of registry.tools.values()) {
    if (decl.expose === "procedure") continue;
    if (decl.description.trim() === "" || decl.input == null) {
      reportProblem(problems, plugin.name, `tool ${decl.name} requires a description and input`);
      continue;
    }
    entries.push({
      wireName: decl.name,
      description: decl.description,
      parameters: { ...decl.input.json },
      class: decl.toolClass === "" ? "effect" : decl.toolClass,
      source: { kind: "pack", pluginName: plugin.name },
      triggersReactLoop: decl.triggersReactLoop,
      isSideChannel: decl.isSideChannel,
      representation: decl.representation,
      question: decl.question,
      effect: decl.effect,
      caption: decl.caption,
      execute: async (raw, ctx) => {
        const sessionId = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
        const value = await examToolCtx.run(examContext(ctx, sessionId), () =>
          callDeclaredTool(registry, decl.name, jsonToVal(raw ?? {}), (_receiver, method, kw) =>
            kernel.callState({
              plugin: plugin.name,
              scope: "session",
              agentId: sessionId,
              projectId: "",
              method,
              args: Object.fromEntries([...kw].map(([key, item]) => [key, toJS(item)])),
              hostAuthority: true,
            }),
          ),
        );
        return toolResultOf(value);
      },
    });
  }
  return { plugin: plugin.name, entries };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FILE_PORTS = ["read_file", "list_dir", "grep", "glob", "fff_search", "shell"] as const;

const FILE_FIELD: Record<(typeof FILE_PORTS)[number], string> = {
  read_file: "path",
  list_dir: "path",
  grep: "pattern",
  glob: "pattern",
  fff_search: "query",
  shell: "command",
};

function examEnvironment(): Map<string, Proc> {
  const environment = new Map<string, Proc>();
  for (const name of FILE_PORTS) environment.set(name, filePort(name));
  environment.set(
    "tasks/write-completion-verdict",
    new Proc("tasks/write-completion-verdict", (values) => {
      const comments = values[1];
      return [values[0] === true, typeof comments === "string" ? comments : ""];
    }),
  );
  return environment;
}

function filePort(name: (typeof FILE_PORTS)[number]): Proc {
  const call = (values: readonly Val[]): Promise<string> => callCatalog(name, fileArgs(name, values));
  return new Proc(name, call as unknown as Proc["call"]);
}

function examContext(
  ctx: { root?: string; signal?: AbortSignal; sessionId?: string; catalog?: unknown; invocation?: unknown },
  sessionId: string,
): ToolContext {
  return {
    root: typeof ctx.root === "string" ? ctx.root : "",
    catalog: ctx.catalog as ToolContext["catalog"],
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    sessionId,
    invocation: ctx.invocation,
  };
}

function fileArgs(name: (typeof FILE_PORTS)[number], values: readonly Val[]): Record<string, unknown> {
  const positionals: Val[] = [];
  const options: Record<string, unknown> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value instanceof Dict) {
      for (const [key, entry] of Object.entries(value.entries)) options[key] = toJS(entry);
      continue;
    }
    if (typeof value === "string" && value.startsWith(":") && value.length > 1 && positionals.length > 0) {
      if (index + 1 >= values.length) throw new Error(`${name}: dangling keyword ${value}`);
      options[value.slice(1)] = toJS(values[index + 1]);
      index += 1;
      continue;
    }
    positionals.push(value);
  }
  const head = positionals[0];
  if (typeof head !== "string") throw new Error(`${name}: ${FILE_FIELD[name]} is required`);
  if (positionals.length > 1) throw new Error(`${name}: unexpected argument`);
  return { [FILE_FIELD[name]]: head, ...options };
}

async function callCatalog(name: string, args: Record<string, unknown>): Promise<string> {
  const slot = examToolCtx.getStore();
  if (slot == null) throw new Error(`${name}: kernel tool catalog is missing`);
  const parent = slot.invocation;
  const session = parent instanceof ToolCallJob ? documentRoot(parent) : null;
  if (!(parent instanceof ToolCallJob) || !(session instanceof SessionRoot)) {
    throw new TypeError(`${name}: runs only inside a session tool call`);
  }
  const call = { id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
  const inner = new ToolCallHandler({ catalog: slot.catalog }).admit(call, slot.catalog, { session, parent });
  // Settles on the inner receipt; a failed receipt rejects with its text.
  const value: unknown = await inner.then(undefined, (error: unknown) => {
    throw new Error(String(error));
  });
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}
