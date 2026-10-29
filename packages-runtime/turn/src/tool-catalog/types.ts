/**
 * Catalog row identity. wireName is a model-edge projection — never durable
 * routing. Connection tools route by connectionKey + serverToolName.
 */
import type { RuleInput } from "../context/retention/schema.js";

export type CatalogSource =
  | { readonly kind: "pack"; readonly pluginName: string }
  | {
      readonly kind: "connection";
      /** Kernel `connections` map key (slug). Lawful cross-doc pointer to ConnectionSpec. */
      readonly connectionKey: string;
      readonly serverToolName: string;
    };

export type CatalogExecute = (
  raw: unknown,
  ctx: {
    root?: string;
    signal?: AbortSignal;
    sessionId?: string;
    background?: unknown;
    catalog?: unknown;
    onPriorContent?: (text: string | null) => void;
    invocation?: unknown;
    shellTailBytes?: number;
    onTail?: (frame: { readonly text: string; readonly totalBytes: number }) => void;
  },
) => Promise<unknown>;

/** `tool` is completions tools[]. `symbol` is a scheme_repl name. `both` is both. */
export type ToolRepresentation = "tool" | "symbol" | "both";

export type PackToolMeta =
  | { readonly kind: "function" }
  | {
      readonly kind: "bot-call";
      readonly pluginName: string;
      readonly target: string;
      readonly background: boolean;
      readonly lifetime: "turn" | "call";
      readonly show: "result" | "omit" | "turn";
      readonly deadlineMs?: number;
      readonly supportsNotify: boolean;
    };

export type CatalogEntry = {
  readonly wireName: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Catalog class: `read` | `write` | `effect` | `meta`. Missing / unknown → `effect`. */
  readonly class: string;
  /**
   * Model face. Omitted is a scheme symbol and stays off completions tools[].
   * Native tools set this on `InhumanTool`; the catalog row copies it.
   */
  readonly representation?: ToolRepresentation;
  readonly source: CatalogSource;
  /**
   * Pack / host plugins carry execute (InhumanTool.execute).
   * Connection tools are projection-only — BODY is MCP PEW on the connection.
   */
  readonly execute?: CatalogExecute;
  readonly packMeta?: PackToolMeta;
  readonly triggersReactLoop?: boolean;
  /** Skips the license floor. Copied from the tool that declared it. */
  readonly isSideChannel?: boolean;
  readonly tapeHidden?: boolean;
  /**
   * Self-declared retention hint (e.g. ephemeral output). Narrowing only, and
   * only for this tool's own key: it can shorten what the policy says, never lengthen it.
   */
  readonly retention?: RuleInput;
  /** Mustache the TUI paints while the call is open, after it seals, and as a caption. */
  readonly question?: string | null;
  readonly effect?: string | null;
  readonly caption?: string | null;
  /**
   * Exam admit bag. Structural so this package does not import plugin-sdk.
   * Plugin ExamAdmit is assignable.
   */
  readonly exam?: {
    readonly program: (state: any, input: any) => string | { readonly error: string };
    readonly admit: (state: any, input: any) => any;
    readonly settle?: (state: any, input: any, result: any) => any;
  };
};

/** What a recipe needs to grant a wire beyond its plain tool list. */
export type RecipeGrantSpec = {
  readonly recipeScope: "session" | "project" | "global";
  readonly mcpJson: string;
  readonly tools: readonly string[];
};

/**
 * Host-owned parts of the worker tool ceiling (bot-granted MCP, private plugin MCP). The ceiling
 * itself lives in one place, `workerToolAllowed`; the host only answers these two questions.
 */
export type WorkerToolHost = {
  /** Does the recipe grant this wire through its tool list or its `mcpJson` grants? */
  readonly recipeGrantsWire: (catalog: object, spec: RecipeGrantSpec, wire: string, projectPath: string) => boolean;
  /** Is this wire one of the recipe's private plugin MCP tools, not (yet) in the catalog view? */
  readonly privateWireAllowed: (recipeName: string, wire: string, sessionRoot: object | undefined) => boolean;
};

export const PLAIN_WORKER_HOST: WorkerToolHost = {
  recipeGrantsWire: (_catalog, spec, wire) => spec.tools.includes(wire),
  privateWireAllowed: () => false,
};
