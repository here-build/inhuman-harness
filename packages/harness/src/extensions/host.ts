import { readFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";

import { programDigest } from "./consent.js";
import {
  type BoundaryOutcome,
  callDeclaredTool,
  dispatchBoundary,
  dispatchTool,
  selectsCall,
  type ToolOutcome,
} from "./dispatch.js";
import { jsonToVal, loadProgram } from "./eval.js";
import { type ResolvedBot, resolvePackageSurface } from "./manifest.js";
import { behaviorNoteLog, type NoteLog } from "./notes.js";
import { type BehaviorPin, pinSources } from "./pin.js";
import { type BoundReceiver, CallerLedger, callMethod, StateDirectory, type StateStore } from "./state.js";
import { PluginSurfaceError } from "./surface-error.js";
import { type Ctx, Dict, type GuardPoint, Refusal, type Registry, toJS, type ToolDecl, type Val } from "./value.js";

/** An enabled installed plugin: `plugin.json` name and package root. */
export type PluginPackage = {
  readonly name: string;
  readonly root: string;
  /** False when the host config keeps this plugin's foreground bot off the foreground agent. */
  readonly foreground?: boolean;
};

/** Paths are relative to `root`, so a pin names modules, not files on disk. */
export type PinnedBehavior = BehaviorPin & {
  readonly bot: string;
  readonly root: string;
};

export type AgentPin = {
  readonly version: 1;
  readonly behaviors: readonly PinnedBehavior[];
};

export const EMPTY_PIN: AgentPin = { version: 1, behaviors: [] };

export type BotChoice = {
  readonly plugin: PluginPackage;
  readonly bot: ResolvedBot;
};

export type Settle = { readonly ok: true; readonly value: Val } | { readonly ok: false; readonly error: string };

/**
 * A dispatch whose core the host runs. `started` settles when the core is
 * reached (guards and floor passed, pre hooks done) or when the dispatch ended
 * without reaching it. `finish` hands the core's result back and returns the
 * outcome after post hooks.
 */
export type Opened<O> = {
  readonly started: Promise<
    { readonly entered: true; readonly value: Val } | { readonly entered: false; readonly outcome: O }
  >;
  finish(settle: Settle): Promise<O>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

/** Bots with a behavior that `pick` selects. */
export function botChoices(
  packages: readonly PluginPackage[],
  pick: (bot: ResolvedBot, plugin: PluginPackage) => boolean,
  errors: string[],
): BotChoice[] {
  const out: BotChoice[] = [];
  for (const plugin of packages) {
    let bots: readonly ResolvedBot[];
    try {
      bots = resolvePackageSurface(plugin.root).bots;
    } catch (error) {
      errors.push(`${plugin.name}: ${messageOf(error)}`);
      continue;
    }
    for (const bot of bots) {
      if (bot.behavior != null && pick(bot, plugin)) out.push({ plugin, bot });
    }
  }
  return out;
}

/** The foreground agent runs every `attach: foreground` bot whose plugin the host config does not opt out. */
export function foregroundChoices(packages: readonly PluginPackage[], errors: string[]): BotChoice[] {
  return botChoices(
    packages.filter((plugin) => plugin.foreground !== false),
    (bot) => bot.foreground,
    errors,
  );
}

/**
 * A behavior `environment` is JS that would run in the host process, like the
 * internal plugin API. Until that door opens, such a bot does not attach.
 */
export const ENVIRONMENT_UNSUPPORTED =
  "behavior environment modules run JS in the host and are not supported; keep the behavior in Scheme";

/** Load the program once to learn every module it requires, then pin them. */
async function loadBotProgram(choice: BotChoice): Promise<Registry> {
  const behavior = choice.bot.behavior;
  PluginSurfaceError.invariant(behavior != null, `${choice.bot.name} selects no behavior`);
  PluginSurfaceError.invariant(behavior.environmentPath === "", `${ENVIRONMENT_UNSUPPORTED}`);
  return await loadProgram({
    agentId: `pin:${choice.plugin.name}/${choice.bot.name}`,
    source: behavior.programSource,
    filename: behavior.programPath,
    revision: "",
    root: choice.plugin.root,
    read: (path) => readFileSync(path, "utf8"),
    kind: "behavior",
    config: behavior.configuration,
  });
}

export async function pinChoice(choice: BotChoice): Promise<PinnedBehavior> {
  const behavior = choice.bot.behavior;
  PluginSurfaceError.invariant(behavior != null, `${choice.bot.name} selects no behavior`);
  const registry = await loadBotProgram(choice);
  return {
    ...pinSources(
      choice.plugin.name,
      relative(choice.plugin.root, behavior.programPath),
      new Map([...registry.loaded].map(([path, text]) => [relative(choice.plugin.root, path), text])),
      behavior.configuration ?? {},
      behavior.bindings,
    ),
    bot: choice.bot.name,
    root: choice.plugin.root,
  };
}

function unchangedOnDisk(pinned: PinnedBehavior): boolean {
  return pinned.modules.every((module) => {
    try {
      return readFileSync(resolvePath(pinned.root, module.path), "utf8") === module.source;
    } catch {
      return false;
    }
  });
}

/** Keep a previous pin whose modules are unchanged; pin the rest afresh. */
export async function repin(choices: readonly BotChoice[], previous: AgentPin, errors: string[]): Promise<AgentPin> {
  const behaviors: PinnedBehavior[] = [];
  for (const choice of choices) {
    const prior = previous.behaviors.find(
      (row) => row.plugin === choice.plugin.name && row.bot === choice.bot.name && row.root === choice.plugin.root,
    );
    if (
      prior != null &&
      JSON.stringify(prior.configuration) === JSON.stringify(choice.bot.behavior?.configuration ?? {}) &&
      JSON.stringify(prior.bindings ?? {}) === JSON.stringify(choice.bot.behavior?.bindings ?? {}) &&
      unchangedOnDisk(prior)
    ) {
      behaviors.push(prior);
      continue;
    }
    try {
      behaviors.push(await pinChoice(choice));
    } catch (error) {
      errors.push(`${choice.plugin.name}/${choice.bot.name}: ${messageOf(error)}`);
    }
  }
  return { version: 1, behaviors };
}

export function parseAgentPin(json: string): AgentPin {
  if (json.trim() === "") return EMPTY_PIN;
  const raw: unknown = JSON.parse(json);
  PluginSurfaceError.invariant(
    !(
      raw == null ||
      typeof raw !== "object" ||
      (raw as { version?: unknown }).version !== 1 ||
      !Array.isArray((raw as { behaviors?: unknown }).behaviors)
    ),
    "unrecognized behavior pin",
  );
  return raw as AgentPin;
}

export function pinJson(pin: AgentPin): string {
  return pin.behaviors.length === 0 ? "" : JSON.stringify(pin);
}

type BehaviorInstance = {
  readonly plugin: string;
  readonly bot: string;
  readonly registry: Registry;
  readonly bindings: ReadonlyMap<string, BoundReceiver>;
};

export type StateScope = "session" | "project" | "global";

function scopeIdOf(scope: StateScope, opts: { readonly agentId: string; readonly projectId: string }): string {
  if (scope === "session") return opts.agentId;
  if (scope === "project") return opts.projectId;
  return "";
}

/**
 * Kernel-wide behavior runtime: the state directory every agent's bindings
 * resolve into, and the note log hooks write to.
 */
export class BehaviorKernel {
  readonly directory: StateDirectory;
  readonly notes: NoteLog;
  readonly #packages: () => readonly PluginPackage[];
  readonly #approved: (plugin: string) => ReadonlySet<string>;
  readonly #opening = new Map<string, Promise<void>>();

  constructor(opts: {
    readonly packages: () => readonly PluginPackage[];
    /** Content hashes of guards a human approved for this plugin. */
    readonly approved?: (plugin: string) => ReadonlySet<string>;
    readonly notes?: NoteLog;
    /** Where owner logs outlive the process. Absent: memory only. */
    readonly store?: StateStore;
  }) {
    this.directory = new StateDirectory(opts.store);
    this.#packages = opts.packages;
    this.#approved = opts.approved ?? (() => new Set());
    this.notes = opts.notes ?? behaviorNoteLog();
  }

  packages(): readonly PluginPackage[] {
    return this.#packages();
  }

  /**
   * Instantiate a pin for one agent. A behavior that fails to load is left
   * out and reported; the others still attach.
   */
  async attach(opts: {
    readonly agentId: string;
    readonly projectId: string;
    readonly pin: AgentPin;
  }): Promise<{ readonly agent: AgentBehavior; readonly errors: string[] }> {
    const instances: BehaviorInstance[] = [];
    const errors: string[] = [];
    for (const entry of opts.pin.behaviors) {
      try {
        instances.push(await this.#instance(entry, opts));
      } catch (error) {
        errors.push(`${entry.plugin}/${entry.bot}: ${messageOf(error)}`);
      }
    }
    return { agent: new AgentBehavior(opts.agentId, instances, this), errors };
  }

  async #instance(
    entry: PinnedBehavior,
    opts: { readonly agentId: string; readonly projectId: string },
  ): Promise<BehaviorInstance> {
    const sources = new Map(entry.modules.map((row) => [resolvePath(entry.root, row.path), row.source]));
    const filename = resolvePath(entry.root, entry.programPath);
    const source = sources.get(filename);
    PluginSurfaceError.invariant(source != null, "pinned program unavailable");
    const registry = await loadProgram({
      agentId: opts.agentId,
      source,
      filename,
      revision: `${entry.plugin}/${entry.bot}@${entry.revision}`,
      root: entry.root,
      read: (path) => {
        const text = sources.get(path);
        PluginSurfaceError.invariant(text != null, `pinned module unavailable: ${relative(entry.root, path)}`);
        return text;
      },
      kind: "behavior",
      config: entry.configuration,
    });
    const approved = this.#approved(entry.plugin);
    const unapproved = registry.guards.filter((guard) => !approved.has(guard.hash));
    PluginSurfaceError.invariant(
      unapproved.length === 0,
      `unapproved guard ${unapproved.map((guard) => `${guard.declarationId} (${guard.hash})`).join(", ")}; approve it under plugins.${entry.plugin}.guards in config.json`,
    );
    const bindings = new Map<string, BoundReceiver>();
    for (const [alias, binding] of Object.entries(entry.bindings ?? {})) {
      const ownerId = await this.#owner(binding.plugin, binding.scope, scopeIdOf(binding.scope, opts));
      bindings.set(alias, {
        alias,
        ownerId,
        methods: new Set(binding.methods),
        abi: this.directory.get(ownerId).abi,
      });
    }
    return { plugin: entry.plugin, bot: entry.bot, registry, bindings };
  }

  /**
   * A plugin command's call into that plugin's own state, on behalf of the
   * person at the keyboard: every method is granted, host-only actions are not.
   */
  async callState(opts: {
    readonly plugin: string;
    readonly scope: StateScope;
    readonly agentId: string;
    readonly projectId: string;
    readonly method: string;
    readonly args: unknown;
    /** The tool itself sealing limbo and the exam verdict. A nested plugin call never sets this. */
    readonly hostAuthority?: boolean;
  }): Promise<Val> {
    const input = jsonToVal(opts.args ?? {});
    PluginSurfaceError.invariant(input instanceof Dict, "method arguments must be an object");
    const ownerId = await this.#owner(opts.plugin, opts.scope, scopeIdOf(opts.scope, opts));
    const owner = this.directory.get(ownerId);
    PluginSurfaceError.invariant(
      owner.methods.has(opts.method),
      `${opts.plugin} ${opts.scope} state has no method ${opts.method}`,
    );
    return callMethod({
      directory: this.directory,
      caller: new CallerLedger(),
      bindings: new Map([
        [
          "command",
          {
            alias: "command",
            ownerId,
            methods: new Set(owner.methods.keys()),
            abi: owner.abi,
          },
        ],
      ]),
      receiver: "command",
      method: opts.method,
      args: input.entries,
      callId: `command:${opts.method}`,
      hostAuthority: opts.hostAuthority === true,
    });
  }

  async #owner(plugin: string, scope: StateScope, scopeId: string): Promise<string> {
    const id = this.directory.ownerId(plugin, scope, scopeId, "state");
    if (this.directory.has(id)) return id;
    let opening = this.#opening.get(id);
    if (opening == null) {
      opening = this.#openOwner(id, plugin, scope).finally(() => {
        this.#opening.delete(id);
      });
      this.#opening.set(id, opening);
    }
    await opening;
    return id;
  }

  async #openOwner(id: string, plugin: string, scope: StateScope): Promise<void> {
    const pkg = this.#packages().find((row) => row.name === plugin);
    PluginSurfaceError.invariant(pkg != null, `plugin ${plugin} is not enabled`);
    const state = resolvePackageSurface(pkg.root).states.find((row) => row.scope === scope);
    PluginSurfaceError.invariant(state != null, `${plugin} has no ${scope} state`);
    const registry = await loadProgram({
      agentId: id,
      source: state.source,
      filename: state.path,
      revision: "",
      root: pkg.root,
      read: (path) => readFileSync(path, "utf8"),
      kind: "state",
    });
    PluginSurfaceError.invariant(registry.reducer != null, `${plugin} ${scope} state has no reducer`);
    const abi = programDigest(new Map([...registry.loaded].map(([path, text]) => [relative(pkg.root, path), text])));
    this.directory.open(id, scope, abi, registry.reducer, registry.methods);
  }
}

const NEUTRAL_BOUNDARY: Omit<BoundaryOutcome, "result"> = {
  refusal: "",
  failure: "",
  hookFailures: [],
  guardFailure: "",
  deliveries: [],
  originAtoms: [],
};

function combineBoundary(outcomes: readonly BoundaryOutcome[], fallback: Val): BoundaryOutcome {
  const outer = outcomes.at(-1);
  if (outer == null) return { ...NEUTRAL_BOUNDARY, result: fallback };
  return {
    result: outer.result,
    refusal: outer.refusal,
    failure: outer.failure,
    hookFailures: outcomes.flatMap((row) => row.hookFailures),
    guardFailure: outcomes.find((row) => row.guardFailure !== "")?.guardFailure ?? "",
    deliveries: outcomes.flatMap((row) => row.deliveries),
    originAtoms: outcomes.flatMap((row) => row.originAtoms),
  };
}

function combineTool(outcomes: readonly ToolOutcome[]): ToolOutcome {
  const outer = outcomes.at(-1);
  PluginSurfaceError.invariant(outer != null, "tool dispatch did not run");
  return {
    entered: outcomes.some((row) => row.entered),
    result: outer.result,
    refusal: outer.refusal,
    failure: outer.failure,
    diagnostics: outcomes.flatMap((row) => row.diagnostics),
    hookFailures: outcomes.flatMap((row) => row.hookFailures),
    guardFailure: outcomes.find((row) => row.guardFailure !== "")?.guardFailure ?? "",
    marks: outer.marks,
    attempts: Math.max(...outcomes.map((row) => row.attempts)),
    deliveries: outcomes.flatMap((row) => row.deliveries),
    originAtoms: outcomes.flatMap((row) => row.originAtoms),
  };
}

/** A declared tool's result as a host tool outcome. */
export function toolResultOf(value: Val): {
  readonly ok: boolean;
  readonly text?: string;
  readonly value?: unknown;
} {
  if (value instanceof Refusal) return { ok: false, text: value.message };
  if (typeof value === "string") return { ok: true, text: value };
  return { ok: true, value: toJS(value) };
}

/** A host tool outcome as the value post hooks and guards see. */
export function outcomeValue(outcomeJson: string): Settle {
  let raw: unknown;
  try {
    raw = JSON.parse(outcomeJson === "" ? "{}" : outcomeJson);
  } catch {
    return { ok: true, value: outcomeJson };
  }
  const record = raw != null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = typeof record.text === "string" ? record.text : "";
  if (record.ok === false) return { ok: false, error: text === "" ? "tool failed" : text };
  if (text !== "") return { ok: true, value: text };
  try {
    return { ok: true, value: jsonToVal(record.value ?? null) };
  } catch {
    return { ok: true, value: JSON.stringify(record.value) };
  }
}

/** One agent's instantiated behaviors, in pin order. The first wraps the rest. */
export class AgentBehavior {
  constructor(
    readonly agentId: string,
    readonly instances: readonly BehaviorInstance[],
    readonly kernel: BehaviorKernel,
  ) {}

  get empty(): boolean {
    return this.instances.length === 0;
  }

  selects(point: GuardPoint, paths: readonly string[]): boolean {
    return this.instances.some((row) => selectsCall(row.registry, point, paths));
  }

  /** Model-facing declared tools. A name already taken by an earlier behavior is reported. */
  tools(errors: string[]): readonly {
    readonly plugin: string;
    readonly decl: ToolDecl;
  }[] {
    const seen = new Set<string>();
    const out: { plugin: string; decl: ToolDecl }[] = [];
    for (const instance of this.instances) {
      for (const decl of instance.registry.tools.values()) {
        if (decl.expose === "procedure") continue;
        if (seen.has(decl.name)) {
          errors.push(`${instance.plugin}/${instance.bot}: tool ${decl.name} is already declared`);
          continue;
        }
        seen.add(decl.name);
        out.push({ plugin: instance.plugin, decl });
      }
    }
    return out;
  }

  async callTool(name: string, input: unknown, turnId = ""): Promise<Val> {
    const instance = this.instances.find((row) => {
      const tool = row.registry.tools.get(name);
      return tool != null && tool.expose !== "procedure";
    });
    PluginSurfaceError.invariant(instance != null, `${name} is not a model tool`);
    return callDeclaredTool(
      instance.registry,
      name,
      jsonToVal(input ?? {}),
      this.#onMethod(instance, new CallerLedger()),
      { notes: this.kernel.notes, turnId },
    );
  }

  #onMethod(instance: BehaviorInstance, caller: CallerLedger): NonNullable<Ctx["onMethod"]> {
    let seq = 0;
    return (receiver, method, kw) => {
      seq += 1;
      return callMethod({
        directory: this.kernel.directory,
        caller,
        bindings: instance.bindings,
        receiver,
        method,
        args: Object.fromEntries(kw),
        callId: `${this.agentId}:${receiver}.${method}#${seq}`,
      });
    };
  }

  openBoundary(point: "turn" | "round", record: Val, turnId: string): Opened<BoundaryOutcome> {
    const reached = deferred<Val>();
    const release = deferred<Settle>();
    const outcomes: BoundaryOutcome[] = [];
    let fallback: Val = false;
    const layer = async (index: number, value: Val): Promise<Val> => {
      if (index >= this.instances.length) {
        reached.resolve(value);
        const settled = await release.promise;
        PluginSurfaceError.invariant(settled.ok, settled.ok ? "" : settled.error);
        fallback = settled.value;
        return settled.value;
      }
      const instance = this.instances[index];
      const out = await dispatchBoundary({
        registry: instance.registry,
        point,
        record: value,
        notes: this.kernel.notes,
        turnId,
        onMethod: this.#onMethod(instance, new CallerLedger()),
        core: (inner) => layer(index + 1, inner),
      });
      outcomes.push(out);
      if (out.refusal !== "") return new Refusal(out.refusal);
      PluginSurfaceError.invariant(out.failure === "", out.failure);
      return out.result;
    };
    const whole = layer(0, record).then(
      () => combineBoundary(outcomes, fallback),
      (error: unknown) => {
        const combined = combineBoundary(outcomes, false);
        return outcomes.length === 0 ? { ...combined, failure: messageOf(error) } : combined;
      },
    );
    return {
      started: Promise.race([
        reached.promise.then((value) => ({ entered: true as const, value })),
        whole.then((outcome) => ({ entered: false as const, outcome })),
      ]),
      finish: async (settle) => {
        release.resolve(settle);
        return whole;
      },
    };
  }

  /**
   * Guards run outermost first, then `floor` (the host license), then pre
   * hooks, then the host core. Only behaviors that select the call take part.
   */
  openTool(opts: {
    readonly point: GuardPoint;
    readonly paths: readonly string[];
    readonly raw: Val;
    readonly turnId: string;
    readonly floor: (value: Val) => Promise<Val>;
  }): Opened<ToolOutcome> {
    const active = this.instances.filter((row) => selectsCall(row.registry, opts.point, opts.paths));
    const reached = deferred<Val>();
    const release = deferred<Settle>();
    const outcomes: ToolOutcome[] = [];
    const core = async (value: Val): Promise<Val> => {
      reached.resolve(value);
      const settled = await release.promise;
      PluginSurfaceError.invariant(settled.ok, settled.ok ? "" : settled.error);
      return settled.value;
    };
    const layer = async (index: number, value: Val): Promise<Val> => {
      if (index >= active.length) {
        const judged = await opts.floor(value);
        if (judged instanceof Refusal) return judged;
        return core(judged);
      }
      const instance = active[index];
      const last = index === active.length - 1;
      const out = await dispatchTool({
        registry: instance.registry,
        point: opts.point,
        paths: opts.paths,
        raw: value,
        floor: last ? opts.floor : (inner) => inner,
        core: last ? core : (inner) => layer(index + 1, inner),
        notes: this.kernel.notes,
        turnId: opts.turnId,
        onMethod: this.#onMethod(instance, new CallerLedger()),
      });
      outcomes.push(out);
      if (out.refusal !== "") return new Refusal(out.refusal);
      PluginSurfaceError.invariant(out.failure === "", out.failure);
      return out.result;
    };
    const whole = layer(0, opts.raw).then(
      (value) => (outcomes.length === 0 ? bareTool(value, "") : combineTool(outcomes)),
      (error: unknown) => (outcomes.length === 0 ? bareTool(false, messageOf(error)) : combineTool(outcomes)),
    );
    return {
      started: Promise.race([
        reached.promise.then((value) => ({ entered: true as const, value })),
        whole.then((outcome) => ({ entered: false as const, outcome })),
      ]),
      finish: async (settle) => {
        release.resolve(settle);
        return whole;
      },
    };
  }
}

function bareTool(value: Val, failure: string): ToolOutcome {
  return {
    entered: true,
    result: value instanceof Refusal ? false : value,
    refusal: value instanceof Refusal ? value.message : "",
    failure,
    diagnostics: [],
    hookFailures: [],
    guardFailure: "",
    marks: [],
    attempts: 1,
    deliveries: [],
    originAtoms: [],
  };
}
