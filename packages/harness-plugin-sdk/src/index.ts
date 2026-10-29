/**
 * @inhuman.tools/plugin-sdk — tools, actions, envCapabilities.
 *
 * `export default new InhumanPlugin({ tools, actions, envCapabilities? })`.
 * plugin.json extension format is the daemon's. This package does not parse it.
 * `envCapabilities` is optional and rare: Arrival `EnvCapability` instances
 * (`@here.build/arrival`, optional peer).
 */

import type { EnvCapability } from "@here.build/arrival";
import { z } from "zod";

import {
  normalizeDefinitions,
  resolveReferences,
  type BotDefinition,
  type McpServerDefinition,
  type NormalizedPluginDefinition,
  type PluginCallContext,
  type ToolDefinition,
} from "./normalize.js";
import { type ExamAdmit, type PluginProjection } from "./projection.js";
import { inhumanBrand, inhumanShape, NormalizedActionDefinition, type ToolRepresentation } from "./schemas/plugin.js";

export * from "./schemas/index.js";
export {
  normalizeDefinitions as normalizeDefinitions,
  resolveReferences as resolveReferences,
  type BotCallToolDefinition as BotCallToolDefinition,
  type BotDefinition as BotDefinition,
  isReasoningEffort as isReasoningEffort,
  type ReasoningEffort as ReasoningEffort,
  type NormalizedPluginDefinition as NormalizedPluginDefinition,
  type PluginCallContext as PluginCallContext,
  type ToolDefinition as ToolDefinition,
} from "./normalize.js";
export {
  type ExamAdmit as ExamAdmit,
  type PluginProjection as PluginProjection,
  type PluginStorageHandles as PluginStorageHandles,
} from "./projection.js";

/** Coarse class for hooks / tolerance axes (open string for packs). */
export type ToolClass = "read" | "write" | "effect" | (string & {});

/** Host-provided membrane — not freestyle process ambient. */
export type ToolContext = PluginCallContext;

export type InhumanToolDef<TIn, TOut> = {
  readonly name: string;
  readonly description?: string;
  /** Catalog class (`read` | `write` | `effect` | …). Missing → `effect`. */
  readonly class?: ToolClass;
  /**
   * `tool` is a JSON function in completions tools[]. `symbol` is a scheme_repl
   * name and stays off tools[]. `both` is both. Omitted function tools are
   * symbols. Omitted bot-calls are tools.
   */
  readonly representation?: ToolRepresentation;
  readonly input: z.ZodType<TIn>;
  readonly output: z.ZodType<TOut>;
  readonly type?: "function" | "bot-call";
  readonly run?: (input: TIn, ctx: ToolContext) => Promise<TOut> | TOut;
  readonly target?: string;
  readonly prepare?: (input: TIn, ctx: ToolContext) => unknown;
  readonly background?: boolean;
  readonly lifetime?: "turn" | "call";
  readonly show?: "result" | "omit" | "turn";
  readonly deadlineMs?: number;
  readonly maxResultTokens?: number;
  readonly supportsNotify?: boolean;
  /**
   * When false the call is not a ReACT continuer by itself. Default true.
   * Not `class`. License skip is `isSideChannel`.
   */
  readonly triggersReactLoop?: boolean;
  /** Skips the license floor. Default false. */
  readonly isSideChannel?: boolean;
  /** Off the tape. Separate from `triggersReactLoop`. Default false. */
  readonly tapeHidden?: boolean;
  /**
   * Mustache tape faces. Null or omitted is uncovered — the TUI falls
   * through. Kernel projects these onto `PluginSpec`. pretty-mcp grain:
   * `question` while live/ask, `effect` when sealed, `caption` the
   * collapsed token.
   */
  readonly question?: string | null;
  readonly effect?: string | null;
  readonly caption?: string | null;
  /** Admit as a frozen exam bag. Host stamps `admit` sealed on that job. */
  readonly exam?: ExamAdmit<TIn, unknown, unknown>;
};

export class InhumanTool<TIn = unknown, TOut = unknown> {
  readonly [inhumanBrand.tool] = true as const;

  readonly name: string;
  readonly description: string | undefined;
  readonly class: ToolClass;
  readonly representation: ToolRepresentation;
  readonly input: z.ZodType<TIn>;
  readonly output: z.ZodType<TOut>;
  readonly type: "function" | "bot-call";
  readonly target?: string;
  readonly prepare?: (input: TIn, ctx: ToolContext) => unknown;
  readonly background?: boolean;
  readonly lifetime?: "turn" | "call";
  readonly show?: "result" | "omit" | "turn";
  readonly deadlineMs?: number;
  readonly maxResultTokens?: number;
  readonly supportsNotify?: boolean;
  readonly triggersReactLoop: boolean;
  readonly tapeHidden: boolean;
  private readonly sideChannel: boolean;
  readonly question: string | null;
  readonly effect: string | null;
  readonly caption: string | null;
  readonly exam?: ExamAdmit<TIn, unknown, unknown>;
  private readonly _run?: (input: TIn, ctx: ToolContext) => Promise<TOut> | TOut;

  constructor(def: InhumanToolDef<TIn, TOut>) {
    const normalized = normalizeDefinitions({ tools: [def], actions: [], envCapabilities: [] }, "InhumanTool")
      .tools[0]!;
    this.name = normalized.name;
    this.description = normalized.description;
    this.class = normalized.class ?? "effect";
    this.representation = normalized.representation;
    this.input = normalized.input as z.ZodType<TIn>;
    this.output = normalized.output as z.ZodType<TOut>;
    this.type = normalized.type;
    if (normalized.type === "function") {
      this._run = normalized.run as (input: TIn, ctx: ToolContext) => Promise<TOut> | TOut;
    } else {
      this.target = normalized.target;
      this.prepare = normalized.prepare as (input: TIn, ctx: ToolContext) => unknown;
      this.background = normalized.background;
      this.lifetime = normalized.lifetime;
      this.show = normalized.show;
      this.deadlineMs = normalized.deadlineMs;
      this.maxResultTokens = normalized.maxResultTokens;
      this.supportsNotify = normalized.supportsNotify;
    }
    this.triggersReactLoop = normalized.triggersReactLoop;
    this.sideChannel = normalized.isSideChannel;
    this.tapeHidden = normalized.tapeHidden;
    this.question = normalized.question;
    this.effect = normalized.effect;
    this.caption = normalized.caption;
    this.exam = normalized.type === "function" ? normalized.exam : undefined;
  }

  /** Host side channel. Skips the license floor. */
  get isSideChannel(): boolean {
    return this.sideChannel;
  }

  /** Normalized ABI record for load-boundary comparisons. */
  toToolDefinition(): ToolDefinition<TIn, TOut> {
    const face = {
      question: this.question,
      effect: this.effect,
      caption: this.caption,
    };
    if (this.type === "bot-call") {
      return {
        type: "bot-call",
        name: this.name,
        description: this.description,
        class: this.class,
        representation: this.representation,
        input: this.input,
        output: this.output,
        target: this.target!,
        prepare: this.prepare,
        background: this.background,
        lifetime: this.lifetime,
        show: this.show,
        deadlineMs: this.deadlineMs,
        maxResultTokens: this.maxResultTokens,
        supportsNotify: this.supportsNotify,
        triggersReactLoop: this.triggersReactLoop,
        isSideChannel: this.isSideChannel,
        tapeHidden: this.tapeHidden,
        ...face,
      };
    }
    return {
      type: "function",
      name: this.name,
      description: this.description,
      class: this.class,
      representation: this.representation,
      input: this.input,
      output: this.output,
      run: this._run!,
      triggersReactLoop: this.triggersReactLoop,
      isSideChannel: this.isSideChannel,
      tapeHidden: this.tapeHidden,
      exam: this.exam,
      ...face,
    };
  }

  /** Parse raw args → run → parse output. Host admit path uses this. */
  async execute(raw: unknown, ctx: ToolContext = {}): Promise<TOut> {
    if (this.type === "bot-call") {
      throw new TypeError(`InhumanTool(${this.name}): bot-call tools do not execute through run`);
    }
    if (this.exam != null && this._run == null) {
      throw new TypeError(`InhumanTool(${this.name}): exam tools do not execute through run`);
    }
    const parsedCtx = inhumanShape.toolContext.parse(ctx);
    if ((this.class === "read" || this.class === "write") && (parsedCtx.root == null || parsedCtx.root === "")) {
      throw new TypeError(`InhumanTool(${this.name}): ctx.root string required for class ${this.class}`);
    }
    const input = this.input.parse(raw);
    const out = await this._run!(input, parsedCtx as ToolContext);
    return this.output.parse(out);
  }
}

export function defineTool<TIn, TOut>(def: InhumanToolDef<TIn, TOut>): InhumanTool<TIn, TOut> {
  return new InhumanTool(def);
}

/** Host membrane for a JS action. Not a completion door. */
export type ActionContext = {
  readonly signal?: AbortSignal;
  readonly [key: string]: unknown;
};

export type ActionFn<TArgs = unknown, TOut = unknown> = (args: TArgs, ctx: ActionContext) => TOut | Promise<TOut>;

export type ActionSeat = "session" | "harness";

const actionBrand = inhumanBrand.action;

export type InhumanActionDef<TArgs = unknown, TOut = unknown> = {
  readonly name: string;
  readonly description?: string;
  readonly seat?: ActionSeat;
  readonly input?: z.ZodType<TArgs>;
  readonly run: ActionFn<TArgs, TOut>;
};

export class InhumanAction<TArgs = unknown, TOut = unknown> {
  readonly [actionBrand] = true as const;

  readonly name: string;
  readonly description: string | undefined;
  readonly seat: ActionSeat;
  readonly input: z.ZodType<TArgs> | undefined;
  readonly run: ActionFn<TArgs, TOut>;

  constructor(def: InhumanActionDef<TArgs, TOut>) {
    const parsed = inhumanShape.normalizedActionDef.parse(def);
    this.name = parsed.name;
    this.description = parsed.description;
    this.seat = parsed.seat;
    this.input = parsed.input as z.ZodType<TArgs> | undefined;
    this.run = parsed.run as ActionFn<TArgs, TOut>;
  }
}

export function defineAction<TArgs, TOut>(def: InhumanActionDef<TArgs, TOut>): InhumanAction<TArgs, TOut> {
  return new InhumanAction(def);
}

/** Plugin bag accepts any tool arity; the constructor normalizes to erased instances. */
export type AnyInhumanTool = InhumanTool<any, any>;

export type InhumanPluginDef = {
  readonly apiVersion?: 1;
  readonly tools?: readonly AnyInhumanTool[];
  readonly actions?: readonly (InhumanAction | NormalizedActionDefinition)[];
  readonly envCapabilities?: readonly EnvCapability[];
  readonly bots?: readonly BotDefinition[];
  readonly mcpServers?: readonly McpServerDefinition[];
  readonly exclusiveSlots?: readonly string[];
  /** Pack projection over trajectory metadata plus wire stamps from the head projection. */
  readonly projection?: PluginProjection<any, any>;
};

const pluginBrand = inhumanBrand.plugin;

export class InhumanPlugin {
  readonly [pluginBrand] = true as const;

  readonly apiVersion: 1;
  readonly tools: readonly InhumanTool[];
  readonly actions: readonly InhumanAction[];
  readonly envCapabilities: readonly EnvCapability[];
  readonly bots: readonly BotDefinition[];
  readonly mcpServers: readonly McpServerDefinition[];
  readonly exclusiveSlots: readonly string[];
  readonly projection?: PluginProjection<any, any>;
  readonly definition: NormalizedPluginDefinition;

  constructor(def: InhumanPluginDef = {}) {
    this.definition = resolveReferences(normalizeDefinitions(def, "InhumanPlugin"), "InhumanPlugin");
    this.apiVersion = this.definition.apiVersion;
    this.tools = Object.freeze(
      this.definition.tools.map((tool) => new InhumanTool(tool as InhumanToolDef<unknown, unknown>)),
    ) as readonly InhumanTool[];
    this.actions = Object.freeze(
      this.definition.actions.map((action) => new InhumanAction(action as InhumanActionDef)),
    ) as readonly InhumanAction[];
    this.envCapabilities = Object.freeze([...this.definition.envCapabilities]);
    this.bots = Object.freeze([...this.definition.bots]);
    this.mcpServers = Object.freeze([...this.definition.mcpServers]);
    this.exclusiveSlots = Object.freeze([...this.definition.exclusiveSlots]);
    this.projection = this.definition.projection;
  }

  static isInhumanPlugin(value: unknown): value is InhumanPlugin {
    return typeof value === "object" && value !== null && (value as { [pluginBrand]?: boolean })[pluginBrand] === true;
  }
}

export { z as z } from "zod";
