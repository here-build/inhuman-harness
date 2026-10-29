import { behaviorAls } from "./behavior.js";
import { applyLambda, makeCtx } from "./eval.js";
import { PluginSurfaceError } from "./surface-error.js";
import {
  Dict,
  Refusal,
  deepEqual,
  emptyRegistry,
  toJS,
  type MethodDecl,
  type ReducerDecl,
  type Registry,
  type Val,
} from "./value.js";

export type BoundReceiver = {
  readonly alias: string;
  readonly ownerId: string;
  readonly methods: ReadonlySet<string>;
  readonly abi: string;
};

export type MethodCallRecord = {
  readonly id: string;
  readonly input: string;
  readonly result: Val;
  readonly ownerRevision: number;
};

export class CallerLedger {
  readonly calls = new Map<string, MethodCallRecord>();
}

export class StateOwner {
  revision: number;
  readonly log: Val[];
  readonly methods: ReadonlyMap<string, MethodDecl>;

  constructor(
    readonly id: string,
    readonly scope: "private" | "session" | "project" | "global",
    readonly abi: string,
    readonly reducer: ReducerDecl,
    methods: ReadonlyMap<string, MethodDecl>,
    log: Val[],
  ) {
    this.methods = methods;
    this.log = log;
    this.revision = log.length;
  }
}

export type OwnerParts = {
  readonly plugin: string;
  readonly scope: StateOwner["scope"];
  readonly scopeId: string;
  readonly namespace: string;
};

/** Where owner logs outlive the process. The directory writes through on every change. */
export interface StateStore {
  load(owner: OwnerParts): readonly Val[] | undefined;
  save(owner: OwnerParts, log: readonly Val[]): void;
}

/**
 * Owner logs. Rebuilding an owner from the same log is a restart. Without a
 * store they live in memory only.
 */
export class StateDirectory {
  readonly #logs = new Map<string, Val[]>();
  readonly #owners = new Map<string, StateOwner>();

  constructor(private readonly store?: StateStore) {}

  ownerId(plugin: string, scope: StateOwner["scope"], scopeId: string, namespace: string): string {
    return `${plugin}\0${scope}\0${scopeId}\0${namespace}`;
  }

  parts(id: string): OwnerParts {
    const [plugin = "", scope = "", scopeId = "", namespace = ""] = id.split("\0");
    PluginSurfaceError.invariant(
      scope === "private" || scope === "session" || scope === "project" || scope === "global",
      `malformed state owner ${id}`,
    );
    return { plugin, scope, scopeId, namespace };
  }

  open(
    id: string,
    scope: StateOwner["scope"],
    abi: string,
    reducer: ReducerDecl,
    methods: ReadonlyMap<string, MethodDecl>,
  ): StateOwner {
    const existing = this.#owners.get(id);
    if (existing != null) return existing;
    const log = this.#logs.get(id) ?? [...(this.store?.load(this.parts(id)) ?? [])];
    this.#logs.set(id, log);
    const owner = new StateOwner(id, scope, abi, reducer, methods, log);
    this.#owners.set(id, owner);
    return owner;
  }

  has(id: string): boolean {
    return this.#owners.has(id);
  }

  get(id: string): StateOwner {
    const owner = this.#owners.get(id);
    PluginSurfaceError.invariant(owner != null, `unknown state owner ${id}`);
    return owner;
  }

  /** Drop the live owner and replay the same durable log. */
  restart(id: string): StateOwner {
    const owner = this.get(id);
    this.#owners.delete(id);
    return this.open(id, owner.scope, owner.abi, owner.reducer, owner.methods);
  }

  /** Caller rollback moves session and private logs. Project and global refuse. */
  rollback(id: string, revision: number): void {
    const owner = this.get(id);
    PluginSurfaceError.invariant(
      !(owner.scope === "project" || owner.scope === "global"),
      "caller rollback does not undo accepted project/global changes",
    );
    owner.log.splice(revision);
    this.commit(owner);
  }

  /** The owner's log changed: bump its revision and write it through. */
  commit(owner: StateOwner): void {
    owner.revision = owner.log.length;
    this.store?.save(this.parts(owner.id), owner.log);
  }

  /** Session owners of one scope id, opened or only logged. */
  sessionOwners(scopeId: string): string[] {
    return [...this.#logs.keys()].filter((id) => {
      const parts = this.parts(id);
      return parts.scope === "session" && parts.scopeId === scopeId;
    });
  }

  /**
   * Replace a session owner's log, as when the session moves to another
   * turn. The store already holds the new log; this only updates memory.
   */
  reset(id: string, log: readonly Val[]): void {
    PluginSurfaceError.invariant(this.parts(id).scope === "session", "only session state follows the session");
    const kept = this.#logs.get(id);
    if (kept == null) return;
    kept.splice(0, kept.length, ...log);
    const owner = this.#owners.get(id);
    if (owner != null) owner.revision = owner.log.length;
  }
}

function registryOf(owner: StateOwner, methods: ReadonlyMap<string, MethodDecl>): Registry {
  const registry = emptyRegistry(owner.id, owner.abi, new Dict({}));
  registry.reducer = owner.reducer;
  for (const [name, method] of methods) registry.methods.set(name, method);
  return registry;
}

async function projectionUntil(owner: StateOwner, until: number): Promise<Val> {
  const ctx = makeCtx({
    mode: "pure",
    agentId: owner.id,
    sourceText: "",
    file: owner.id,
    root: "/",
    read: () => {
      PluginSurfaceError.invariant(false, "missing source");
    },
    config: new Dict({}),
    registry: registryOf(owner, new Map()),
  });
  let state = await applyLambda(owner.reducer.initial, [], ctx);
  for (const action of owner.log.slice(0, until)) {
    state = await applyLambda(owner.reducer.reduce, [state, action], ctx);
  }
  return state;
}

async function isProtected(owner: StateOwner, action: Val): Promise<boolean> {
  if (owner.reducer.hostOnly == null) return false;
  const ctx = makeCtx({
    mode: "pure",
    agentId: owner.id,
    sourceText: "",
    file: owner.id,
    root: "/",
    read: () => {
      PluginSurfaceError.invariant(false, "missing source");
    },
    config: new Dict({}),
    registry: registryOf(owner, new Map()),
  });
  return (await applyLambda(owner.reducer.hostOnly, [action], ctx)) === true;
}

export function hostPropose(directory: StateDirectory, owner: StateOwner, action: Val): void {
  owner.log.push(action);
  directory.commit(owner);
}

export async function callMethod(opts: {
  readonly directory: StateDirectory;
  readonly caller: CallerLedger;
  readonly bindings: ReadonlyMap<string, BoundReceiver>;
  readonly receiver: string;
  readonly method: string;
  readonly args: Readonly<Record<string, Val>>;
  readonly callId: string;
  readonly observedRevision?: number;
  readonly lineage?: string[];
  readonly hostAuthority?: boolean;
  readonly admit?: (id: string) => Val;
}): Promise<Val> {
  const binding = opts.bindings.get(opts.receiver);
  PluginSurfaceError.invariant(binding != null, `unbound receiver ${opts.receiver}`);
  PluginSurfaceError.invariant(binding.methods.has(opts.method), "method not granted");
  const owner = opts.directory.get(binding.ownerId);
  PluginSurfaceError.invariant(binding.abi === owner.abi, "revision mismatch");
  const decl = owner.methods.get(opts.method);
  PluginSurfaceError.invariant(decl != null, `unknown method ${opts.method}`);
  const input = new Dict(opts.args);
  const inputIssue = decl.input.check(input);
  PluginSurfaceError.invariant(inputIssue == null, `schema ${inputIssue}`);
  const inputHash = JSON.stringify(toJS(input));
  const prior = opts.caller.calls.get(opts.callId);
  if (prior != null) {
    PluginSurfaceError.invariant(prior.input === inputHash, "call id reuse");
    return prior.result;
  }
  const observed = opts.observedRevision ?? owner.revision;
  const lineage = [...(opts.lineage ?? behaviorAls.getStore()?.lineage ?? [])];
  const registration = `method:${owner.id}:${decl.name}`;
  const active = lineage.filter((item) => item === registration).length;
  PluginSurfaceError.invariant(active <= decl.reentrantDepth, `re-entrant registration ${registration}`);
  lineage.push(registration);
  const ctx = makeCtx({
    mode: "run",
    agentId: owner.id,
    sourceText: decl.handler.source,
    file: owner.id,
    root: "/",
    read: () => {
      PluginSurfaceError.invariant(false, "missing source");
    },
    config: new Dict({}),
    registry: registryOf(owner, new Map([[decl.name, decl]])),
  });
  ctx.lineage = lineage;
  ctx.hostAuthority = opts.hostAuthority === true;
  ctx.admit = opts.admit ?? null;
  ctx.proposals = decl.kind === "mutation" ? [] : null;
  ctx.onMethod = (receiver, name, kw) =>
    callMethod({
      ...opts,
      receiver,
      method: name,
      args: Object.fromEntries(kw),
      callId: `${opts.callId}>${receiver}.${name}`,
      lineage,
      observedRevision: undefined,
    });
  const state = await projectionUntil(owner, observed);
  let result: Val;
  try {
    result = await applyLambda(decl.handler, [input, state], ctx);
  } finally {
    lineage.pop();
  }
  if (result instanceof Refusal) return result;
  const outputIssue = decl.output.check(result);
  PluginSurfaceError.invariant(outputIssue == null, `schema ${outputIssue}`);
  if (decl.kind === "query") {
    opts.caller.calls.set(opts.callId, {
      id: opts.callId,
      input: inputHash,
      result,
      ownerRevision: observed,
    });
    return result;
  }
  PluginSurfaceError.invariant(owner.revision === observed, "stale commit");
  if (opts.hostAuthority !== true) {
    for (const action of ctx.proposals ?? []) {
      PluginSurfaceError.invariant(!(await isProtected(owner, action)), "protected action");
    }
  }
  for (const action of ctx.proposals ?? []) owner.log.push(action);
  opts.directory.commit(owner);
  opts.caller.calls.set(opts.callId, {
    id: opts.callId,
    input: inputHash,
    result,
    ownerRevision: owner.revision,
  });
  return result;
}

export function projectionOf(owner: StateOwner): Promise<Val> {
  return projectionUntil(owner, owner.revision);
}

export function sameState(left: Val, right: Val): boolean {
  return deepEqual(left, right);
}
