import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";
import { fail } from "@inhuman.tools/harness-diagnostics";
import type { WebSocketServer } from "ws";
import { z } from "zod";

import {
  type HarnessProcedure,
  methodOf,
  type UiAnswer,
  uiAnswerSchema,
  uiParkSchema,
  uiResolvePending,
} from "@/protocol/rpc";
import type { PlaneSocket } from "@/yjs";

import { acceptJsonRpc } from "./transport/accept.js";
import type { RpcApplication, RpcRequestIdentity } from "./transport/jsonrpc.js";
import { asRecord } from "./util/read-field.js";

export class UiCancelled extends Error {
  constructor() {
    super("ui cancelled");
    this.name = "UiCancelled";
  }
}

export function isUiCancelled(value: unknown): value is UiCancelled {
  return value instanceof UiCancelled;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

const NEVER_ABORTED = new AbortController().signal;
const performAls = new AsyncLocalStorage<PerformCtx>();

/**
 * Named JSON-RPC method. Construct via {@link DaemonRpcMethod.define} so the
 * run function is checked against the input/output schemas.
 * Defaults stay `any` so a mixed `rpcMethods` table is assignable —
 * `unknown` is contravariant on `run`.
 */
export class DaemonRpcMethod<TIn = any, TOut = any> {
  readonly name: string;
  readonly input: z.ZodType<TIn>;
  readonly output: z.ZodType<TOut>;
  readonly run: (input: TIn) => TOut | Promise<TOut>;

  protected constructor(
    name: string,
    contract: { readonly input: z.ZodType<TIn>; readonly output: z.ZodType<TOut> },
    run: (input: TIn) => TOut | Promise<TOut>,
  ) {
    this.name = name;
    this.input = contract.input;
    this.output = contract.output;
    this.run = run;
  }

  static define<I extends z.ZodType, O extends z.ZodType>(
    name: string,
    contract: { readonly input: I; readonly output: O },
    fn: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
  ): DaemonRpcMethod<z.output<I>, z.output<O>> {
    return new DaemonRpcMethod<z.output<I>, z.output<O>>(
      name,
      contract as {
        readonly input: z.ZodType<z.output<I>>;
        readonly output: z.ZodType<z.output<O>>;
      },
      fn,
    );
  }

  /**
   * Implement a procedure of the harness-contract: wire name, input and
   * output come from the contract, so a daemon cannot drift from it.
   */
  static fromContract<I extends z.ZodType, O extends z.ZodType>(
    procedure: HarnessProcedure<I, O>,
    fn: (input: z.output<I>) => z.output<O> | Promise<z.output<O>>,
  ): DaemonRpcMethod<z.output<I>, z.output<O>> {
    const { inputSchema, outputSchema } = procedure["~orpc"];
    if (inputSchema === undefined || outputSchema === undefined) {
      throw new Error(`contract procedure ${methodOf(procedure)} has no input or output schema`);
    }
    return DaemonRpcMethod.define(methodOf(procedure), { input: inputSchema, output: outputSchema }, fn);
  }
}

type ParkYield = {
  readonly pending: string;
  readonly ctx: PerformCtx;
  readonly body: string;
  readonly resume: (answer: UiAnswer) => void;
};

/**
 * The parks of one perform, in order. A park pushed while nobody waits is
 * queued, so two concurrent `ui()` calls both reach the caller, one per wait.
 */
type ParkCycle = {
  next: () => Promise<ParkYield>;
  push: (park: ParkYield) => void;
};

type PerformCtx = {
  readonly cycle: ParkCycle;
  readonly abort: AbortController;
  readonly parks: Set<string>;
};

type Pending =
  | {
      readonly kind: "reenter";
      readonly method: string;
      readonly input: unknown;
      readonly connectionId: string | undefined;
    }
  | {
      readonly kind: "resume";
      readonly resume: (answer: UiAnswer) => void;
      readonly done: Promise<unknown>;
      readonly cycle: ParkCycle;
      readonly ctx: PerformCtx;
    };

function createParkCycle(): ParkCycle {
  const queued: ParkYield[] = [];
  const waiting: Array<(park: ParkYield) => void> = [];
  return {
    next: () => {
      const park = queued.shift();
      if (park !== undefined) return Promise.resolve(park);
      return new Promise<ParkYield>((resolve) => {
        waiting.push(resolve);
      });
    },
    push: (park) => {
      const wake = waiting.shift();
      if (wake === undefined) queued.push(park);
      else wake(park);
    },
  };
}

/**
 * Application JSON-RPC host: dispatch, validation, UI park/resume.
 * Socket accept and envelope delivery live in transport; {@link accept} is an adapter.
 * Two park styles:
 * - return `{ form: "ui", body }` → re-enter the action with merged args
 * - `await this.ui(body)` inside run → same call stack resumes with the answer
 *   (confirm, driver adopt). Not an elicit protocol; the Scheme chunk is the demand.
 * `ui/resolve` body is {@link uiAnswerSchema} plus `pending`.
 * `ui()` binds to the `#perform` that called it (ALS), so a second TUI RPC cannot
 * steal or clear that park. Plane close aborts that perform's signal.
 */
export class RequestHost implements RpcApplication {
  rpcMethods: DaemonRpcMethod[] = [];
  readonly #pendings = new Map<string, Pending>();
  /** Answered parks whose perform still runs: a later `cancel` for the same pending aborts it. */
  readonly #answered = new Map<string, PerformCtx>();
  readonly #planePerforms = new Map<string, Set<PerformCtx>>();

  /** Adapter for existing upgrade callers. Transport does not construct this host. */
  accept(socket: Duplex, request: IncomingMessage, head: Buffer, wss: WebSocketServer): void {
    acceptJsonRpc(socket, request, head, wss, this, (plane) => this.attach(plane));
  }

  protected attach(_plane: PlaneSocket): void {}

  protected get parent(): RequestHost | undefined {
    return undefined;
  }

  protected execute(run: () => unknown | Promise<unknown>): unknown | Promise<unknown> {
    return run();
  }

  protected queuesExecute(_method: string): boolean {
    return true;
  }

  /** Re-enter this perform after `execute` queues work on another promise. */
  protected bindPerform<T>(run: () => T | Promise<T>): () => Promise<T> {
    const ctx = performAls.getStore();
    return async () => (ctx == null ? await run() : await performAls.run(ctx, run));
  }

  protected requestSignal(): AbortSignal {
    return performAls.getStore()?.abort.signal ?? NEVER_ABORTED;
  }

  /** A closed plane can never answer its parks. Parent dispatch tracked the same id. */
  onPlaneClose(connectionId: string): void {
    const set = this.#planePerforms.get(connectionId);
    this.#planePerforms.delete(connectionId);
    for (const ctx of set ?? []) this.#abortPerform(ctx);
    for (const [pending, parked] of this.#pendings) {
      if (parked.kind === "reenter" && parked.connectionId === connectionId) this.#pendings.delete(pending);
    }
    this.parent?.onPlaneClose(connectionId);
  }

  /**
   * Park a Scheme demand and resume with the ui/resolve answer.
   * Only valid while `handleRequest` is running this host's action.
   * `kind: "cancel"` rejects with {@link UiCancelled}.
   */
  ui(body: string): Promise<UiAnswer> {
    const ctx = performAls.getStore();
    if (ctx == null) {
      return Promise.reject(new Error("ui() outside of handleRequest"));
    }
    if (ctx.abort.signal.aborted) return Promise.reject(new UiCancelled());
    return new Promise<UiAnswer>((resolve, reject) => {
      const pending = randomUUID();
      const onAbort = (): void => {
        reject(new UiCancelled());
      };
      ctx.abort.signal.addEventListener("abort", onAbort, { once: true });
      ctx.parks.add(pending);
      ctx.cycle.push({
        pending,
        ctx,
        body,
        resume: (answer) => {
          ctx.abort.signal.removeEventListener("abort", onAbort);
          ctx.parks.delete(pending);
          if (answer.kind === "cancel") {
            reject(new UiCancelled());
            return;
          }
          resolve(answer);
        },
      });
    });
  }

  async handleRequest(method: string, args: unknown, identity?: RpcRequestIdentity): Promise<unknown> {
    if (method === "ui/resolve") return this.#resolveUi(args, identity);
    const rpc = this.rpcMethods.find((row) => row.name === method);
    if (rpc === undefined) {
      const parent = this.parent;
      RpcMethodNotFound.invariant(parent !== undefined, method);
      return parent.handleRequest(method, args, identity);
    }
    const input = parseRpcInput(rpc.input, args ?? {});
    const invoke = async () => {
      const out = await rpc.run.call(this, input);
      if (isUiParkResult(out)) return out;
      return parseRpcOutput(method, rpc.output, out);
    };
    return this.#perform(method, input, () => (this.queuesExecute(method) ? this.execute(invoke) : invoke()), identity);
  }

  async #perform(
    method: string,
    input: unknown,
    run: () => unknown | Promise<unknown>,
    identity?: RpcRequestIdentity,
  ): Promise<unknown> {
    const cycle = createParkCycle();
    const abort = new AbortController();
    const ctx: PerformCtx = { cycle, abort, parks: new Set() };
    const connectionId = identity?.connectionId;
    this.#trackPerform(connectionId, ctx);
    const done = performAls.run(ctx, async () => {
      try {
        const result = await run();
        return this.#parkUi(method, input, result, connectionId);
      } finally {
        this.#untrackPerform(connectionId, ctx);
      }
    });
    return this.#waitCycle(cycle, done);
  }

  #trackPerform(connectionId: string | undefined, ctx: PerformCtx): void {
    if (connectionId == null || connectionId === "") return;
    const set = this.#planePerforms.get(connectionId) ?? new Set<PerformCtx>();
    set.add(ctx);
    this.#planePerforms.set(connectionId, set);
  }

  #untrackPerform(connectionId: string | undefined, ctx: PerformCtx): void {
    if (connectionId == null || connectionId === "") return;
    const set = this.#planePerforms.get(connectionId);
    if (set == null) return;
    set.delete(ctx);
    if (set.size === 0) this.#planePerforms.delete(connectionId);
  }

  #abortPerform(ctx: PerformCtx): void {
    ctx.abort.abort();
    for (const pending of ctx.parks) {
      const parked = this.#pendings.get(pending);
      if (parked?.kind !== "resume") continue;
      this.#pendings.delete(pending);
      parked.resume({ kind: "cancel" });
    }
    ctx.parks.clear();
  }

  async #waitCycle(cycle: ParkCycle, done: Promise<unknown>): Promise<unknown> {
    const winner = await Promise.race([
      done.then(
        (result) => ({ t: "done" as const, result }),
        (error: unknown) => ({ t: "fail" as const, error }),
      ),
      cycle.next().then((park) => ({ t: "park" as const, park })),
    ]);
    if (winner.t === "fail") throw winner.error;
    if (winner.t === "done") return winner.result;
    this.#pendings.set(winner.park.pending, {
      kind: "resume",
      resume: winner.park.resume,
      done,
      cycle,
      ctx: winner.park.ctx,
    });
    return { form: "ui", pending: winner.park.pending, body: winner.park.body };
  }

  #parkUi(method: string, input: unknown, result: unknown, connectionId: string | undefined): unknown {
    if (!isUiParkResult(result)) return result;
    if (typeof result.pending === "string" && result.pending.length > 0) return result;
    const pending = randomUUID();
    this.#pendings.set(pending, { kind: "reenter", method, input, connectionId });
    return { form: "ui", pending, body: result.body };
  }

  async #resolveUi(args: unknown, identity?: RpcRequestIdentity): Promise<unknown> {
    const envelope = parseRpcInput(uiResolvePending, args ?? {});
    const { pending, ...rest } = envelope;
    const answer = parseRpcInput(uiAnswerSchema, rest);
    const parked = this.#pendings.get(pending);
    if (parked === undefined) {
      const running = this.#answered.get(pending);
      if (running !== undefined && answer.kind === "cancel") {
        this.#answered.delete(pending);
        this.#abortPerform(running);
        return { ok: true };
      }
      const parent = this.parent;
      RpcInvalidParams.invariant(parent !== undefined, "unknown pending");
      return parent.handleRequest("ui/resolve", args, identity);
    }
    this.#pendings.delete(pending);
    if (parked.kind === "reenter") {
      const base = asRecord(parked.input) ?? {};
      return this.handleRequest(parked.method, { ...base, ...answer }, identity);
    }
    parked.resume(answer);
    if (answer.kind !== "cancel") {
      this.#answered.set(pending, parked.ctx);
      void parked.done.then(
        () => this.#answered.delete(pending),
        () => this.#answered.delete(pending),
      );
    }
    return this.#waitCycle(parked.cycle, parked.done);
  }
}

export class RpcMethodNotFound extends ErrorWithInvariant {
  readonly code = -32_601;
  readonly name = "RpcMethodNotFound";

  constructor(method: string) {
    super(`Method not found: ${method}`);
  }
}

export class RpcInvalidParams extends ErrorWithInvariant {
  readonly code = -32_602;
  readonly name = "RpcInvalidParams";

  constructor(message = "Invalid params") {
    super(message);
  }
}

/** A method result that fails its own contract is the daemon's fault, not the caller's. */
export class RpcInternalError extends ErrorWithInvariant {
  readonly code = -32_603;
  readonly name = "RpcInternalError";

  constructor(message = "Internal error") {
    super(message);
  }
}

export function parseRpcOutput<T>(method: string, schema: z.ZodType<T>, output: unknown): T {
  const parsed = schema.safeParse(output);
  if (!parsed.success) {
    fail(`${method} returned a result that does not match its contract`, parsed.error);
    throw new RpcInternalError(`Internal error: ${method} returned an invalid result`);
  }
  return parsed.data;
}

export function parseRpcInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  RpcInvalidParams.invariant(
    parsed.success,
    parsed.success ? undefined : (parsed.error.issues[0]?.message ?? "Invalid params"),
  );
  return parsed.data;
}

function isUiParkResult(value: unknown): value is { form: "ui"; body: string; pending?: unknown } {
  return uiParkSchema.safeParse(value).success;
}
