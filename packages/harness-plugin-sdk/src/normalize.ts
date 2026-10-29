/**
 * Load-boundary normalize for plugin ABI v1. Produces plain records; branding
 * and instanceof are not part of the contract.
 */
import type { EnvCapability } from "@here.build/arrival";
import type { SystemPrompt } from "@inhuman.tools/harness-commons";
import { z, ZodType } from "zod";

import type { ExamAdmit, PluginProjection, PluginStorageHandles } from "./projection.js";
import {
  botCallToolDef,
  botDef,
  exclusiveSlotsDef,
  functionToolDef,
  inhumanBrand,
  inhumanShape,
  mcpServerDef,
  pluginProjectionDef,
  REASONING_EFFORTS,
  type ToolRepresentation,
  NormalizedActionDefinition,
} from "./schemas/plugin.js";

function parseNamed<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`${context}: ${issue?.message ?? "invalid"}`);
}

function declaredRepresentation(value: unknown, fallback: ToolRepresentation): ToolRepresentation {
  return value === "tool" || value === "symbol" || value === "both" ? value : fallback;
}

export type PluginCallContext = {
  readonly root?: string;
  readonly turn?: unknown;
  readonly completion?: unknown | null;
  readonly invocation?: unknown;
  readonly signal?: AbortSignal;
  /** Prefix projection for this plugin. Tool body proposes metadata via `propose`. */
  readonly storage?: PluginStorageHandles;
  readonly [key: string]: unknown;
};

export type BotMcpBinding = {
  readonly server: string;
  readonly tools: readonly string[];
  readonly approval?: "allow" | "policy";
};

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return z.enum(REASONING_EFFORTS).safeParse(value).success;
}

export type BotDefinition = {
  readonly name: string;
  readonly recipeScope: "invocation" | "session" | "workspace" | "global";
  readonly instructions: SystemPrompt;
  /** Parent-facing one-liner. Inventory speech. */
  readonly description?: string;
  readonly tools?: readonly string[];
  readonly mcp?: readonly BotMcpBinding[];
  readonly keepAlive?: boolean;
  /** Other bot names this concept may invoke. Same-plugin, resolved at load. */
  readonly invokes?: readonly string[];
  readonly reasoningEffort?: ReasoningEffort;
  /** Ordered try-list of catalog model ids. Applied at mint when a resolver exists. */
  readonly modelPreferences?: readonly string[];
  readonly skills?: readonly string[];
};

export type McpServerDefinition = {
  readonly name: string;
  readonly visibility: "private" | "public";
  readonly scope: "session" | "workspace" | "global";
  readonly transport: {
    readonly type: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: "plugin" | "workspace";
    readonly env?:
      | Record<string, string>
      | ((ctx: { readonly pluginRoot: string; readonly workspaceRoot: string }) => Record<string, string>);
  };
};

export type FunctionToolDefinition<I = unknown, O = unknown> = {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly class?: string;
  readonly representation: ToolRepresentation;
  readonly input: ZodType<I>;
  readonly output: ZodType<O>;
  readonly run: (input: I, ctx: PluginCallContext) => O | Promise<O>;
  readonly triggersReactLoop: boolean;
  readonly isSideChannel: boolean;
  readonly tapeHidden: boolean;
  readonly question: string | null;
  readonly effect: string | null;
  readonly caption: string | null;
  readonly exam?: ExamAdmit<I, unknown, unknown>;
};

export type BotCallToolDefinition<I = unknown, O = unknown> = {
  readonly type: "bot-call";
  readonly name: string;
  readonly description?: string;
  readonly class?: string;
  readonly representation: ToolRepresentation;
  readonly input: ZodType<I>;
  readonly output: ZodType<O>;
  readonly target: string;
  readonly prepare?: (input: I, ctx: PluginCallContext) => unknown;
  readonly background?: boolean;
  readonly lifetime?: "turn" | "call";
  readonly show?: "result" | "omit" | "turn";
  readonly deadlineMs?: number;
  readonly maxResultTokens?: number;
  readonly supportsNotify?: boolean;
  readonly triggersReactLoop: boolean;
  readonly isSideChannel: boolean;
  readonly tapeHidden: boolean;
  readonly question: string | null;
  readonly effect: string | null;
  readonly caption: string | null;
};

export type ToolDefinition<I = unknown, O = unknown> = FunctionToolDefinition<I, O> | BotCallToolDefinition<I, O>;

export type NormalizedPluginDefinition = {
  readonly apiVersion: 1;
  readonly tools: readonly ToolDefinition[];
  readonly bots: readonly BotDefinition[];
  readonly mcpServers: readonly McpServerDefinition[];
  readonly actions: readonly NormalizedActionDefinition[];
  readonly envCapabilities: readonly EnvCapability[];
  readonly exclusiveSlots: readonly string[];
  readonly projection?: PluginProjection<any, any>;
};

function toolRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  if ((value as { [inhumanBrand.tool]?: boolean })[inhumanBrand.tool] === true) {
    const tool = value as { toToolDefinition: () => ToolDefinition };
    return tool.toToolDefinition() as unknown as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

function actionRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  if ((value as { [inhumanBrand.action]?: boolean })[inhumanBrand.action] === true) {
    const action = value as NormalizedActionDefinition;
    return {
      name: action.name,
      description: action.description,
      seat: action.seat,
      input: action.input,
      run: action.run,
    };
  }
  return value as Record<string, unknown>;
}

function pluginBag(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown> & { default?: unknown };
  if ((value as { [inhumanBrand.plugin]?: boolean })[inhumanBrand.plugin] === true) {
    const plugin = value as {
      tools?: readonly unknown[];
      actions?: readonly unknown[];
      envCapabilities?: readonly EnvCapability[];
      bots?: readonly unknown[];
      mcpServers?: readonly unknown[];
      exclusiveSlots?: readonly string[];
      projection?: unknown;
      apiVersion?: unknown;
    };
    return {
      apiVersion: plugin.apiVersion,
      tools: plugin.tools,
      actions: plugin.actions,
      envCapabilities: plugin.envCapabilities,
      bots: plugin.bots,
      mcpServers: plugin.mcpServers,
      exclusiveSlots: plugin.exclusiveSlots,
      projection: plugin.projection,
    };
  }
  if ("default" in record && record.default != null) return pluginBag(record.default);
  return record;
}

export function validateSupportedVersion(bag: Record<string, unknown>, pluginName = ""): void {
  const version = bag.apiVersion;
  if (version === undefined) return;
  if (version === 1) return;
  throw new Error(`${pluginName}: unsupported plugin apiVersion ${String(version)}`);
}

function normalizeTool(raw: unknown, index: number, pluginName: string): ToolDefinition {
  const row = toolRecord(raw);
  if (row == null) throw new Error(`${pluginName}: tools[${index}] is not an object`);
  if (row.type === "bot-message") {
    throw new Error(`${pluginName}: tools[${index}] type bot-message is reserved in v1`);
  }
  const context = `${pluginName}: tools[${index}]`;
  const parsed =
    row.type === "bot-call"
      ? parseNamed(botCallToolDef, row, context)
      : parseNamed(functionToolDef, row.type === "function" ? row : { ...row, type: undefined }, context);
  const base = {
    name: parsed.name,
    description: parsed.description,
    class: parsed.class,
    representation: declaredRepresentation(parsed.representation, parsed.type === "bot-call" ? "tool" : "symbol"),
    input: parsed.input as ZodType,
    output: parsed.output as ZodType,
    triggersReactLoop: parsed.triggersReactLoop !== false,
    isSideChannel: parsed.isSideChannel === true,
    tapeHidden: parsed.tapeHidden === true,
    question: parsed.question,
    effect: parsed.effect,
    caption: parsed.caption,
  };
  if (parsed.type === "bot-call") {
    return {
      type: "bot-call",
      ...base,
      target: parsed.target,
      prepare: parsed.prepare as BotCallToolDefinition["prepare"],
      background: parsed.background === true,
      lifetime: parsed.lifetime,
      show: parsed.show,
      deadlineMs: parsed.deadlineMs,
      maxResultTokens: parsed.maxResultTokens,
      supportsNotify: parsed.supportsNotify === true,
    };
  }
  const exam = parsed.exam as FunctionToolDefinition["exam"];
  if (exam != null && parsed.run == null) {
    return {
      type: "function",
      ...base,
      exam,
      run: () => {
        throw new TypeError(`${pluginName}: tools[${index}] exam tools do not execute through run`);
      },
    };
  }
  return {
    type: "function",
    ...base,
    exam,
    run: parsed.run as FunctionToolDefinition["run"],
  };
}

function normalizeProjection(raw: unknown, pluginName: string): PluginProjection | undefined {
  if (raw == null) return undefined;
  return parseNamed(pluginProjectionDef, raw, `${pluginName}: projection`) as PluginProjection;
}

function parseExclusiveSlots(pluginName: string, bag: Record<string, unknown>): readonly string[] {
  const raw = Array.isArray(bag.exclusiveSlots) ? bag.exclusiveSlots : [];
  return parseNamed(exclusiveSlotsDef, raw, `${pluginName}: exclusiveSlots`);
}

export function normalizeDefinitions(exported: unknown, pluginName = ""): NormalizedPluginDefinition {
  const bag = pluginBag(exported);
  if (bag == null) throw new Error(`${pluginName}: plugin export is not an object`);
  validateSupportedVersion(bag, pluginName);
  const toolsRaw = Array.isArray(bag.tools) ? bag.tools : [];
  const actionsRaw = Array.isArray(bag.actions) ? bag.actions : [];
  const envRaw = Array.isArray(bag.envCapabilities) ? bag.envCapabilities : [];
  const botsRaw = Array.isArray(bag.bots) ? bag.bots : [];
  const serversRaw = Array.isArray(bag.mcpServers) ? bag.mcpServers : [];
  const tools = toolsRaw.map((tool, index) => normalizeTool(tool, index, pluginName));
  const toolNames = new Set<string>();
  for (const tool of tools) {
    if (toolNames.has(tool.name)) throw new Error(`${pluginName}: tool "${tool.name}" collides`);
    toolNames.add(tool.name);
  }
  const actions = actionsRaw.map((action, index) => {
    const row = actionRecord(action);
    if (row == null) throw new Error(`${pluginName}: actions[${index}] is not an object`);
    return parseNamed(inhumanShape.normalizedActionDef, row, `${pluginName}: actions[${index}]`);
  });
  const actionNames = new Set<string>();
  for (const action of actions) {
    if (actionNames.has(action.name)) throw new Error(`${pluginName}: action "${action.name}" collides`);
    actionNames.add(action.name);
  }
  const envCapabilities = envRaw.map((cap, index) => {
    try {
      return inhumanShape.envCapability.parse(cap);
    } catch {
      throw new Error(`${pluginName}: envCapabilities[${index}] is invalid`);
    }
  });
  const bots = botsRaw.map((bot, index) => parseNamed(botDef, bot, `${pluginName}: bots[${index}]`));
  const botNames = new Set<string>();
  for (const bot of bots) {
    if (botNames.has(bot.name)) throw new Error(`${pluginName}: bot "${bot.name}" collides`);
    botNames.add(bot.name);
  }
  const mcpServers = serversRaw.map((server, index) =>
    parseNamed(mcpServerDef, server, `${pluginName}: mcpServers[${index}]`),
  );
  const serverNames = new Set<string>();
  for (const server of mcpServers) {
    if (serverNames.has(server.name)) throw new Error(`${pluginName}: mcpServer "${server.name}" collides`);
    serverNames.add(server.name);
  }
  const projection = normalizeProjection(bag.projection, pluginName);
  return {
    apiVersion: 1,
    tools,
    bots,
    mcpServers,
    actions,
    envCapabilities,
    exclusiveSlots: parseExclusiveSlots(pluginName, bag),
    projection,
  };
}

export function resolveReferences(definition: NormalizedPluginDefinition, pluginName = ""): NormalizedPluginDefinition {
  const botNames = new Set(definition.bots.map((bot) => bot.name));
  const serverNames = new Set(definition.mcpServers.map((server) => server.name));
  for (const tool of definition.tools) {
    if (tool.type === "bot-call" && !botNames.has(tool.target)) {
      throw new Error(`${pluginName}: tool "${tool.name}" target "${tool.target}" is unresolved`);
    }
  }
  for (const bot of definition.bots) {
    for (const binding of bot.mcp ?? []) {
      if (!serverNames.has(binding.server)) {
        throw new Error(`${pluginName}: bot "${bot.name}" binding server "${binding.server}" is unresolved`);
      }
    }
    for (const target of bot.invokes ?? []) {
      if (!botNames.has(target)) {
        throw new Error(`${pluginName}: bot "${bot.name}" invokes unresolved "${target}"`);
      }
    }
  }
  return definition;
}
