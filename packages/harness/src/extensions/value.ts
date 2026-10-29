/** Runtime values for the behavior register and callback ambients. */
import { PluginSurfaceError } from "./surface-error.js";

export class Sym {
  constructor(readonly name: string) {}
}

export class Dict {
  constructor(readonly entries: Readonly<Record<string, Val>>) {}
}

/** Arrival lambda crossed with `toJS`. Callbacks passed in are reverse-Rosetta. */
export class Lambda {
  constructor(
    readonly call: (...args: unknown[]) => Promise<unknown>,
    readonly source: string,
  ) {}
}

export class Proc {
  constructor(
    readonly name: string,
    readonly call: (args: readonly Val[], kw: ReadonlyMap<string, Val>, frame: Frame) => Val,
    /** Host function the scheme body calls. Reverse Rosetta round-trips it. */
    readonly hostFn?: (...args: unknown[]) => unknown,
  ) {}
}

export class SchemaV {
  constructor(
    /** JSON Schema the model sees for this shape. */
    readonly json: Readonly<Record<string, unknown>>,
    readonly check: (value: Val) => string | null,
    /** An object field under this schema may be absent. */
    readonly optional = false,
  ) {}
}

export class Refusal {
  constructor(readonly message: string) {}
}

export class Marked {
  constructor(
    readonly value: Val,
    readonly marks: readonly string[],
  ) {}
}

export class RetrySignal extends Error {
  constructor() {
    super("guard retry");
    this.name = "RetrySignal";
  }
}

export type Val = boolean | number | string | Sym | Dict | Lambda | Proc | SchemaV | Refusal | Marked | readonly Val[];

/** One admitted read or outbound send. `value` is what replay hands back. */
export type DeliveryRecord = {
  readonly id: string;
  readonly name: string;
  readonly payload: string;
  readonly value: Val;
};

export type NotifyBoundary = "" | "turn-start" | "turn-end" | "round-start" | "round-end";

export type Frame = {
  bindings: Map<string, Val>;
  parent: Frame | null;
  ctx: Ctx;
};

export type Mode = "register" | "run" | "pure";

export type Ctx = {
  mode: Mode;
  agentId: string;
  sourceText: string;
  file: string;
  root: string;
  read: (path: string) => string;
  config: Dict;
  proposals: Val[] | null;
  hostAuthority: boolean;
  lineage: string[];
  notify: ((mode: "ambient" | "activating" | "origin", message: string, boundary: NotifyBoundary) => void) | null;
  onMethod: ((receiver: string, method: string, kw: ReadonlyMap<string, Val>) => Val | Promise<Val>) | null;
  admit: ((id: string) => Val) | null;
  replay: boolean;
  /** Replay answers admits from these records by id. */
  recorded: ReadonlyMap<string, DeliveryRecord>;
  /** Prefix for delivery ids, so equal payloads in two invocations stay distinct. */
  invocationId: string;
  deliveries: DeliveryRecord[];
  originAtoms: string[];
  environment: ReadonlyMap<string, Proc>;
  cancelled: boolean;
  boundary: NotifyBoundary;
  /**
   * True only inside a guard that has not called `invoke` yet. Hooks and
   * guards past `invoke` cannot ask for a retry.
   */
  retryable: boolean;
  registry: Registry;
};

export type GuardPoint = "read" | "write" | "shell" | "edit" | "mcp" | "agent" | "turn" | "round";

export type ToolDecl = {
  readonly name: string;
  readonly expose: "procedure" | "tool" | "both";
  readonly description: string;
  readonly toolClass: string;
  /** Mustache lines the TUI paints. Null when `define/tool` omits the face. */
  readonly question: string | null;
  readonly effect: string | null;
  readonly caption: string | null;
  readonly triggersReactLoop: boolean;
  /** Skips the license floor. Default false. */
  readonly isSideChannel: boolean;
  /** Model face. Omitted `define/tool` rows are symbols. */
  readonly representation: "tool" | "symbol" | "both";
  readonly input: SchemaV | null;
  readonly handler: Lambda;
  readonly reentrantDepth: number;
  readonly declarationId: string;
};

export type GuardDecl = {
  readonly point: GuardPoint;
  readonly matchers: readonly string[];
  readonly guardCapability: "narrow" | "replace";
  readonly contract: "" | "redaction" | "summarize";
  readonly handler: Lambda;
  readonly reentrantDepth: number;
  /** Consent hash. Empty when the program registered no guard. */
  readonly hash: string;
  readonly program: string;
  readonly declarationId: string;
  readonly source: string;
};

export type HookDecl = {
  readonly point: GuardPoint;
  readonly matchers: readonly string[];
  readonly pre: Lambda | null;
  readonly post: Lambda | null;
  readonly postFail: Lambda | null;
  readonly reentrantDepth: number;
  readonly declarationId: string;
};

export type ReducerDecl = {
  readonly initial: Lambda;
  readonly reduce: Lambda;
  readonly hostOnly: Lambda | null;
};

export type MethodDecl = {
  readonly name: string;
  readonly kind: "query" | "mutation";
  readonly input: SchemaV;
  readonly output: SchemaV;
  readonly handler: Lambda;
  readonly reentrantDepth: number;
};

export type SubscriberDecl = {
  readonly name: string;
  readonly webhook: string;
};

export type Registry = {
  readonly agentId: string;
  readonly revision: string;
  readonly tools: Map<string, ToolDecl>;
  readonly guards: GuardDecl[];
  readonly hooks: HookDecl[];
  reducer: ReducerDecl | null;
  readonly methods: Map<string, MethodDecl>;
  readonly subscribers: SubscriberDecl[];
  /** Every module the program read, entry first: path to source text. */
  readonly loaded: Map<string, string>;
  readonly config: Dict;
  readonly environment: Map<string, Proc>;
};

export function emptyRegistry(agentId: string, revision: string, config: Dict): Registry {
  return {
    agentId,
    revision,
    tools: new Map(),
    guards: [],
    hooks: [],
    reducer: null,
    methods: new Map(),
    subscribers: [],
    loaded: new Map(),
    config,
    environment: new Map(),
  };
}

export function toJS(value: Val): unknown {
  if (value instanceof Sym) return { symbol: value.name };
  if (value instanceof Dict) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value.entries)) out[key] = toJS(entry);
    return out;
  }
  if (value instanceof Refusal) return { refusal: value.message };
  if (value instanceof Marked) return { value: toJS(value.value), marks: [...value.marks] };
  if (value instanceof Lambda || value instanceof Proc || value instanceof SchemaV)
    return { form: value.constructor.name };
  if (Array.isArray(value)) return value.map((entry) => toJS(entry));
  return value;
}

export function deepEqual(left: Val, right: Val): boolean {
  return JSON.stringify(toJS(left)) === JSON.stringify(toJS(right));
}

export function dictGet(value: Val, key: string): Val {
  PluginSurfaceError.invariant(value instanceof Dict, `expected dict for :${key}`);
  return value.entries[key] ?? false;
}

export function asString(value: Val, what: string): string {
  PluginSurfaceError.invariant(typeof value === "string", `${what} must be a string`);
  return value;
}

export function unwrap(value: Val): {
  readonly value: Val;
  readonly marks: readonly string[];
} {
  if (value instanceof Marked) return { value: value.value, marks: value.marks };
  return { value, marks: [] };
}
