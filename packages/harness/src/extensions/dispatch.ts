import { behaviorAls } from "./behavior.js";
import { jsToVal, unwrapBehaviorError, valToScheme } from "./crossing.js";
import { applyLambda, makeCtx } from "./eval.js";
import { selectionMatches } from "./match.js";
import { NoteLog, type ContextNote } from "./notes.js";
import { PluginSurfaceError } from "./surface-error.js";
import {
  Dict,
  Proc,
  Refusal,
  RetrySignal,
  dictGet,
  unwrap,
  type Ctx,
  type DeliveryRecord,
  type GuardDecl,
  type GuardPoint,
  type HookDecl,
  type NotifyBoundary,
  type Registry,
  type Val,
} from "./value.js";

export type ToolOutcome = {
  readonly entered: boolean;
  readonly result: Val;
  readonly refusal: string;
  /** The floor or core threw. Guards did not cause it. */
  readonly failure: string;
  readonly diagnostics: readonly string[];
  readonly hookFailures: readonly string[];
  readonly guardFailure: string;
  readonly marks: readonly string[];
  readonly attempts: number;
  readonly deliveries: readonly DeliveryRecord[];
  readonly originAtoms: readonly string[];
};

export type BoundaryOutcome = {
  readonly result: Val;
  readonly refusal: string;
  /** The wrapped core threw. Guards did not cause it. */
  readonly failure: string;
  readonly hookFailures: readonly string[];
  readonly guardFailure: string;
  readonly deliveries: readonly DeliveryRecord[];
  readonly originAtoms: readonly string[];
};

type RunOptions = {
  readonly lineage?: readonly string[];
  readonly onMethod?: Ctx["onMethod"];
  readonly admit?: (id: string) => Val;
  readonly cancelled?: boolean;
  readonly replay?: boolean;
  /** Deliveries recorded by the live run. Replay answers admits from them. */
  readonly recorded?: readonly DeliveryRecord[];
  readonly invocationId?: string;
};

/** Guard code threw after `invoke` completed. The effect stands. */
class AfterEffect extends Error {
  constructor(
    readonly result: Val,
    message: string,
  ) {
    super(message);
    this.name = "AfterEffect";
  }
}

/** The floor or core threw. That is the tool's failure, not a guard's. */
class CoreFailure extends Error {
  constructor(cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = "CoreFailure";
  }
}

class InvokeToken {
  state: "unused" | "running" | "done" | "failed" | "closed" = "unused";
  result: Val = false;

  async call(body: () => Promise<Val>): Promise<Val> {
    PluginSurfaceError.invariant(this.state === "unused", "invoke is single-use");
    this.state = "running";
    try {
      this.result = await body();
      this.state = "done";
      return this.result;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  close(): void {
    if (this.state !== "running") this.state = "closed";
  }
}

/** Lineage identity of one registration: agent instance, module revision, declaration. */
export function registrationKey(registry: Registry, declarationId: string): string {
  return `${registry.agentId}\u0000${registry.revision}\u0000${declarationId}`;
}

export function enterRegistration(lineage: string[], id: string, depth: number): () => void {
  const active = lineage.filter((item) => item === id).length;
  PluginSurfaceError.invariant(active <= depth, `re-entrant registration ${id}`);
  lineage.push(id);
  return () => {
    lineage.pop();
  };
}

/** Nested dispatch from inside a guard, hook, or core inherits the live lineage. */
function inheritedLineage(explicit: readonly string[] | undefined): string[] {
  return [...(explicit ?? behaviorAls.getStore()?.lineage ?? [])];
}

function runtime(
  registry: Registry,
  opts: RunOptions,
  emitted: ContextNote[],
  notes: NoteLog | undefined,
  turnId: string,
): Ctx {
  const ctx = makeCtx({
    mode: "run",
    agentId: registry.agentId,
    sourceText: "",
    file: registry.agentId,
    root: "/",
    read: () => {
      PluginSurfaceError.invariant(false, "missing source");
    },
    config: registry.config,
    registry,
    environment: registry.environment,
  });
  ctx.lineage = inheritedLineage(opts.lineage);
  ctx.onMethod = opts.onMethod ?? null;
  ctx.admit = opts.admit ?? null;
  ctx.cancelled = opts.cancelled === true;
  ctx.replay = opts.replay === true;
  ctx.recorded = new Map((opts.recorded ?? []).map((row) => [row.id, row]));
  ctx.invocationId = opts.invocationId ?? "";
  ctx.retryable = false;
  if (notes != null) {
    ctx.notify = (mode, message, boundary) => {
      if (mode === "origin") return;
      emitted.push(
        notes.emit({
          agentId: registry.agentId,
          mode,
          boundary,
          message,
          turnId,
        }),
      );
    };
  }
  return ctx;
}

const FIELDS: Partial<Record<GuardPoint, readonly string[]>> = {
  write: ["paths", "contents"],
  edit: ["old", "new"],
  mcp: ["server", "tool", "opts"],
  agent: ["prompt", "tools"],
};

/** The positional arguments a guard or hook receives for one call value. */
function spread(point: GuardPoint, value: Val): Val[] {
  const fields = FIELDS[point];
  return fields == null ? [value] : fields.map((field) => dictGet(value, field));
}

/** The call value a guard's `(invoke …)` arguments describe. */
function pack(point: GuardPoint, args: readonly Val[]): Val {
  const fields = FIELDS[point];
  const arity = fields?.length ?? 1;
  PluginSurfaceError.invariant(
    args.length === arity,
    `invoke for ${point} takes ${arity} argument${arity === 1 ? "" : "s"}`,
  );
  if (fields == null) return args[0] ?? false;
  return new Dict(Object.fromEntries(fields.map((field, index) => [field, args[index] ?? false])));
}

function hookArguments(point: GuardPoint, phase: "pre" | "post" | "post-fail", value: Val, extra: Val): Val[] {
  const base = spread(point, value);
  if (phase === "pre") return base;
  if ((point === "turn" || point === "round") && phase === "post") return base;
  return [...base, extra];
}

function selected<
  T extends {
    readonly point: GuardPoint;
    readonly matchers: readonly string[];
  },
>(rows: readonly T[], point: GuardPoint, paths: readonly string[]): T[] {
  return rows.filter((row) => row.point === point && selectionMatches(row.matchers, paths));
}

/** Whether any guard or hook of this registry selects the call. */
export function selectsCall(registry: Registry, point: GuardPoint, paths: readonly string[]): boolean {
  return selected(registry.guards, point, paths).length > 0 || selected(registry.hooks, point, paths).length > 0;
}

/**
 * Hooks at one position run concurrently and fail open. Each gets its own
 * lineage branch so parallel siblings never see each other as ancestry.
 */
async function runHooks(
  hooks: readonly HookDecl[],
  phase: "pre" | "post" | "post-fail",
  point: GuardPoint,
  value: Val,
  extra: Val,
  ctx: Ctx,
  boundary: NotifyBoundary,
  failures: string[],
): Promise<string[]> {
  const returned = await Promise.all(
    hooks.map(async (hook): Promise<string> => {
      const lambda = phase === "pre" ? hook.pre : phase === "post" ? hook.post : hook.postFail;
      if (lambda == null) return "";
      const branch: Ctx = {
        ...ctx,
        lineage: [...ctx.lineage],
        boundary,
        retryable: false,
      };
      try {
        const leave = enterRegistration(
          branch.lineage,
          registrationKey(ctx.registry, hook.declarationId),
          hook.reentrantDepth,
        );
        try {
          const out = await applyLambda(lambda, hookArguments(point, phase, value, extra), branch);
          return typeof out === "string" ? out.trim() : "";
        } finally {
          leave();
        }
      } catch (error) {
        failures.push(messageOf(unwrapBehaviorError(error)));
        return "";
      }
    }),
  );
  return returned.filter((text) => text !== "");
}

type Link = (value: Val, marks: readonly string[]) => Promise<Val>;

/**
 * One guard. It receives plain values; marks ride beside them on the host
 * side, so a later guard can add a mark but never strip one.
 */
async function runGuard(
  guard: GuardDecl,
  point: GuardPoint,
  value: Val,
  marks: readonly string[],
  next: Link,
  ctx: Ctx,
  after: NotifyBoundary,
): Promise<Val> {
  const token = new InvokeToken();
  const own: Ctx = { ...ctx, retryable: true };
  const leave = enterRegistration(
    ctx.lineage,
    registrationKey(ctx.registry, guard.declarationId),
    guard.reentrantDepth,
  );
  const invokeFn = async (...jsArgs: unknown[]): Promise<unknown> => {
    PluginSurfaceError.invariant(token.state === "unused", "invoke is single-use");
    own.retryable = false;
    const args = jsArgs.map((item) => unwrap(jsToVal(item)));
    const forwarded = pack(
      point,
      args.map((arg) => arg.value),
    );
    const added = args.flatMap((arg) => arg.marks);
    const carried = [...new Set([...marks, ...added])];
    const result = await token.call(() => next(forwarded, carried));
    own.boundary = after;
    return valToScheme(result);
  };
  const invoke = new Proc(
    "invoke",
    () => {
      PluginSurfaceError.invariant(false, "invoke is pending");
    },
    invokeFn,
  );
  try {
    const returned = await applyLambda(guard.handler, [...spread(point, value), invoke], own);
    if (token.state === "unused") {
      PluginSurfaceError.invariant(returned instanceof Refusal, "synthesized success");
      return returned;
    }
    return token.result;
  } catch (error) {
    const unwrapped = unwrapBehaviorError(error);
    if (unwrapped instanceof RetrySignal || unwrapped instanceof CoreFailure) {
      throw unwrapped;
    }
    if (messageOf(unwrapped) === "invoke is single-use") throw unwrapped;
    if (token.state === "done") {
      throw new AfterEffect(token.result, messageOf(unwrapped));
    }
    throw unwrapped;
  } finally {
    token.close();
    leave();
  }
}

function chainOf(
  guards: readonly GuardDecl[],
  point: GuardPoint,
  ctx: Ctx,
  innermost: Link,
  after: NotifyBoundary,
): Link {
  const at =
    (index: number): Link =>
    (value, marks) => {
      const guard = guards[index];
      if (guard == null) return innermost(value, marks);
      return runGuard(guard, point, value, marks, at(index + 1), ctx, after);
    };
  return at(0);
}

type Reached = { value: Val; marks: readonly string[] } | null;

export async function dispatchTool(
  opts: RunOptions & {
    readonly registry: Registry;
    readonly point: GuardPoint;
    readonly paths: readonly string[];
    readonly raw: Val;
    readonly floor: (value: Val, marks: readonly string[]) => Val | Promise<Val>;
    readonly core: (value: Val) => Val | Promise<Val>;
    readonly retryBudget?: number;
    readonly ceiling?: ReadonlySet<string>;
    readonly effect?: string;
    readonly notes?: NoteLog;
    readonly boundary?: NotifyBoundary;
    readonly turnId?: string;
  },
): Promise<ToolOutcome> {
  const skipped = (refusal: string): ToolOutcome => ({
    entered: false,
    result: false,
    refusal,
    failure: "",
    diagnostics: [],
    hookFailures: [],
    guardFailure: "",
    marks: [],
    attempts: 0,
    deliveries: [],
    originAtoms: [],
  });
  if (opts.effect != null && opts.ceiling != null && !opts.ceiling.has(opts.effect)) {
    return skipped("effect outside ceiling");
  }
  const guards = selected(opts.registry.guards, opts.point, opts.paths);
  const hooks = selected(opts.registry.hooks, opts.point, opts.paths);
  if (guards.length === 0 && hooks.length === 0) return skipped("");
  const budget = opts.retryBudget ?? 2;
  const boundary = opts.boundary ?? "";

  const once = async (attempts: number): Promise<ToolOutcome> => {
    const ctx = runtime(opts.registry, opts, [], opts.notes, opts.turnId ?? "");
    ctx.boundary = boundary;
    const failures: string[] = [];
    const outcome = (
      fields: Pick<ToolOutcome, "result" | "refusal" | "guardFailure"> &
        Partial<Pick<ToolOutcome, "diagnostics" | "marks" | "failure">>,
    ): ToolOutcome => ({
      entered: true,
      diagnostics: [],
      marks: [],
      failure: "",
      ...fields,
      hookFailures: failures,
      attempts,
      deliveries: ctx.deliveries,
      originAtoms: ctx.originAtoms,
    });
    // The value that reached the floor, after every guard. Hooks see only this.
    const reach: { at: Reached } = { at: null };
    const innermost: Link = async (value, marks) => {
      reach.at = { value, marks };
      try {
        const judged = await opts.floor(value, marks);
        if (judged instanceof Refusal) return judged;
        await runHooks(hooks, "pre", opts.point, value, false, ctx, boundary, failures);
        return await opts.core(value);
      } catch (error) {
        throw new CoreFailure(error);
      }
    };
    const post = (phase: "post" | "post-fail", extra: Val): Promise<string[]> =>
      runHooks(hooks, phase, opts.point, reach.at?.value ?? false, extra, ctx, boundary, failures);
    const succeeded = async (result: Val, guardFailure: string): Promise<ToolOutcome> =>
      outcome({
        result,
        refusal: "",
        guardFailure,
        diagnostics: await post("post", result),
        marks: reach.at?.marks ?? [],
      });
    try {
      const judged = await chainOf(guards, opts.point, ctx, innermost, boundary)(opts.raw, []);
      if (judged instanceof Refusal) {
        await post("post-fail", judged.message);
        return outcome({
          result: false,
          refusal: judged.message,
          guardFailure: "",
        });
      }
      return await succeeded(judged, "");
    } catch (error) {
      const unwrapped = unwrapBehaviorError(error);
      if (unwrapped instanceof RetrySignal) throw unwrapped;
      if (unwrapped instanceof CoreFailure) {
        await post("post-fail", unwrapped.message);
        return outcome({
          result: false,
          refusal: "",
          guardFailure: "",
          failure: unwrapped.message,
        });
      }
      if (unwrapped instanceof AfterEffect) {
        return await succeeded(unwrapped.result, unwrapped.message);
      }
      const message = messageOf(unwrapped);
      if (message === "synthesized success" || message === "invoke is single-use") {
        throw unwrapped;
      }
      await post("post-fail", message);
      return outcome({
        result: false,
        refusal: message,
        guardFailure: message,
      });
    }
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await once(attempt);
    } catch (error) {
      if (!(unwrapBehaviorError(error) instanceof RetrySignal)) throw error;
      if (attempt >= budget) {
        return {
          ...skipped("retry budget exhausted"),
          entered: true,
          attempts: attempt,
        };
      }
    }
  }
}

/**
 * One turn or round. Guards wrap the whole boundary: before `invoke` is the
 * start, after it returns is the end. `:pre` hooks finish before `core` so
 * their notes reach the upcoming model call; `:post` hooks run after it.
 */
export async function dispatchBoundary(
  opts: RunOptions & {
    readonly registry: Registry;
    readonly point: "turn" | "round";
    readonly record: Val;
    readonly notes: NoteLog;
    readonly turnId: string;
    readonly core?: (record: Val) => Val | Promise<Val>;
  },
): Promise<BoundaryOutcome> {
  const start: NotifyBoundary = opts.point === "turn" ? "turn-start" : "round-start";
  const end: NotifyBoundary = opts.point === "turn" ? "turn-end" : "round-end";
  const guards = selected(opts.registry.guards, opts.point, []);
  const hooks = selected(opts.registry.hooks, opts.point, []);
  const failures: string[] = [];
  const emitted: ContextNote[] = [];
  const ctx = runtime(opts.registry, opts, emitted, opts.notes, opts.turnId);
  ctx.boundary = start;
  const core = opts.core ?? ((record: Val) => record);
  let filtered: Val = false;
  const outcome = (
    fields: Pick<BoundaryOutcome, "result" | "refusal" | "guardFailure"> & Partial<Pick<BoundaryOutcome, "failure">>,
  ): BoundaryOutcome => ({
    failure: "",
    ...fields,
    hookFailures: failures,
    deliveries: ctx.deliveries,
    originAtoms: ctx.originAtoms,
  });
  const innermost: Link = async (value) => {
    filtered = value;
    await runHooks(hooks, "pre", opts.point, value, false, ctx, start, failures);
    try {
      return await core(value);
    } catch (error) {
      throw new CoreFailure(error);
    }
  };
  const postFail = (message: string): Promise<string[]> =>
    runHooks(hooks, "post-fail", opts.point, filtered, message, ctx, end, failures);
  const succeeded = async (result: Val, guardFailure: string): Promise<BoundaryOutcome> => {
    await runHooks(hooks, "post", opts.point, filtered, result, ctx, end, failures);
    return outcome({ result, refusal: "", guardFailure });
  };
  try {
    const result = await chainOf(guards, opts.point, ctx, innermost, end)(opts.record, []);
    if (result instanceof Refusal) {
      await postFail(result.message);
      return outcome({
        result: false,
        refusal: result.message,
        guardFailure: "",
      });
    }
    return await succeeded(result, "");
  } catch (error) {
    const unwrapped = unwrapBehaviorError(error);
    if (unwrapped instanceof CoreFailure) {
      await postFail(unwrapped.message);
      return outcome({
        result: false,
        refusal: "",
        guardFailure: "",
        failure: unwrapped.message,
      });
    }
    if (unwrapped instanceof AfterEffect) {
      return await succeeded(unwrapped.result, unwrapped.message);
    }
    const message = messageOf(unwrapped);
    await postFail(message);
    return outcome({ result: false, refusal: message, guardFailure: message });
  }
}

/** Project a prompt for the upcoming call. The recorded input is left as passed. */
export function projectPrompt<T>(
  recorded: T,
  project: (input: T) => T,
): { readonly recorded: T; readonly projected: T } {
  return { recorded, projected: project(recorded) };
}

export async function callDeclaredTool(
  registry: Registry,
  name: string,
  input: Val,
  onMethod?: Ctx["onMethod"],
  opts?: { readonly notes?: NoteLog; readonly turnId?: string },
): Promise<Val> {
  const tool = registry.tools.get(name);
  PluginSurfaceError.invariant(!(tool == null || tool.expose === "procedure"), `${name} is not a model tool`);
  if (tool.input != null) {
    const issue = tool.input.check(input);
    PluginSurfaceError.invariant(issue == null, `schema ${issue}`);
  }
  const ctx = runtime(registry, { onMethod }, [], opts?.notes, opts?.turnId ?? "");
  const leave = enterRegistration(ctx.lineage, registrationKey(registry, tool.declarationId), tool.reentrantDepth);
  try {
    return await applyLambda(tool.handler, [input], ctx);
  } finally {
    leave();
  }
}

export function replayDeliveries(
  deliveries: readonly { readonly id: string; readonly payload: string }[],
): readonly string[] {
  return deliveries.map((row) => row.payload);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
