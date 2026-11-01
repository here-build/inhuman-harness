/**
 * One session's plugin behavior. The foreground agent re-selects every
 * enabled plugin's `foreground` bot at each turn start; a named agent keeps
 * the pin it was created with. The attached pin supplies boundary hooks,
 * tool guards and hooks, and the session's declared tools. The turn, round,
 * and tool boundaries a running wrap holds open live here too.
 */
import { fail } from "@inhuman.tools/harness-diagnostics";
import {
  AskAgentSpec,
  hostingTurnOf,
  cancelOutcomeText,
  CallJob,
  FailureOutcome,
  type SessionRoot,
  SessionTurn,
  SuccessfulOutcome,
  type ToolCallJob,
} from "@inhuman.tools/harness-model";
import { runInAction, when } from "mobx";

import {
  declaredToolEntries,
  Dict,
  EMPTY_PIN,
  foregroundChoices,
  outcomeValue,
  parseAgentPin,
  pinJson,
  repin,
  type AgentBehavior,
  type AgentPin,
  type BehaviorKernel,
  type BoundaryOutcome,
  type Opened,
  type Settle,
  type ToolOutcome,
} from "@/extensions";
import { bounded } from "@/extensions/hook-deadline";
import { isWorkReachable } from "@/session";
import { bindBehaviorEntries } from "@/tool-catalog";
import { guardedOutcomeJson } from "@/tool-runtime";

import { type KernelToolCatalog } from "../../toolkit/tool-table.js";

export function isForegroundAgent(session: SessionRoot): boolean {
  const spec = session.agent.spec;
  return spec.name === "" && !(spec instanceof AskAgentSpec);
}

/** Live boundaries of one running turn. A resumed turn does not replay them. */
export type TurnBehavior = {
  readonly agent: AgentBehavior;
  turn: Opened<BoundaryOutcome> | null;
  round: Opened<BoundaryOutcome> | null;
  rounds: number;
};

/** The daemon side of a session's behavior: its tool catalog and plugin state. */
export type SessionBehaviorHooks = {
  readonly syncTools: (turn: SessionTurn) => void;
  /** How long a plugin boundary may hold a turn open before it is skipped. */
  readonly hookTimeoutMs: () => number;
};

/** A park keeps the work for the next wrap; its hooks do not run. */
export function isParkAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === "park";
}

/** A Call's settled outcome as the plugin layer sees it. `fallback` says why there is none. */
function callSettle(job: CallJob, fallback: string): Settle {
  const outcome = job.outcome;
  if (outcome instanceof SuccessfulOutcome) return outcomeValue(JSON.stringify({ ok: true, value: outcome.value }));
  return { ok: false, error: outcome instanceof FailureOutcome ? outcome.message || outcome.code : fallback };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Executor ownership is nearest-first; inherited plugin/eval context may use an outer turn. */
function* owningTurns(job: ToolCallJob): Generator<SessionTurn> {
  const seen = new Set<object>();
  let node: { readonly parent: unknown } | null = job;
  while (node != null && !seen.has(node)) {
    seen.add(node);
    if (node instanceof SessionTurn) yield node;
    const parent: unknown = node.parent;
    node =
      parent != null && typeof parent === "object" && "parent" in parent
        ? (parent as { readonly parent: unknown })
        : null;
  }
}

type HeldTool = {
  readonly opened: Opened<ToolOutcome>;
  readonly owner: SessionTurn | null;
  /** A completed background job leaves scheduling, but its accepted invocation still owns its tail. */
  readonly retained: () => boolean;
};

export class SessionBehavior implements Disposable {
  #attached: { readonly json: string; readonly agent: AgentBehavior } | null = null;
  #attaching: {
    readonly json: string;
    readonly promise: Promise<{ readonly agent: AgentBehavior; readonly errors: string[] }>;
  } | null = null;
  readonly #problems = { pin: "", load: "" };
  #turnProblems: string[] = [];
  readonly #lifetime = new AbortController();
  readonly #admission = new AbortController();
  readonly #signals = new Map<SessionTurn, AbortSignal>();
  readonly #turns = new Map<SessionTurn, TurnBehavior>();
  /** Tool calls whose plugin guards reached the core and wait for its result. */
  readonly #tools = new Map<ToolCallJob, HeldTool>();
  readonly #finishing = new Map<
    ToolCallJob,
    { readonly owner: SessionTurn | null; readonly promise: Promise<ToolOutcome | null> }
  >();
  /** Pending job-ending releases of {@link holdTool}. */
  readonly #releases = new Map<ToolCallJob, () => void>();

  constructor(
    private readonly kernel: BehaviorKernel,
    private readonly session: SessionRoot,
    private readonly projectId: string,
    /** Host tools a declared tool may not shadow. */
    private readonly hostCatalog: KernelToolCatalog,
    private readonly hooks: SessionBehaviorHooks,
  ) {}

  /** The last attached behavior. Null until the first turn attaches one. */
  get agent(): AgentBehavior | null {
    return this.#attached?.agent ?? null;
  }

  /** Turn start: re-select the foreground's bots, then attach the pin. */
  async prepare(signal?: AbortSignal): Promise<AgentBehavior> {
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    this.#turnProblems = [];
    this.#publish();
    const spec = this.session.agent.spec;
    if (isForegroundAgent(this.session)) {
      const errors: string[] = [];
      let previous: AgentPin = EMPTY_PIN;
      try {
        previous = parseAgentPin(spec.behaviorPin);
      } catch {
        /* a pin this host cannot read is replaced by a fresh selection */
      }
      const next = pinJson(await repin(foregroundChoices(this.kernel.packages(), errors), previous, errors));
      signal?.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      this.#report("pin", errors);
      if (next !== spec.behaviorPin) {
        runInAction(() => {
          spec.behaviorPin = next;
        });
      }
    }
    return this.attach(signal);
  }

  /** Attach whatever the session's spec pins now. */
  async attach(signal?: AbortSignal): Promise<AgentBehavior> {
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    const json = this.session.agent.spec.behaviorPin;
    if (this.#attached?.json === json) return this.#attached.agent;
    let pending = this.#attaching;
    if (pending?.json !== json) {
      pending = { json, promise: this.#load(json) };
      this.#attaching = pending;
    }
    const { agent, errors } = await pending.promise;
    signal?.throwIfAborted();
    this.#lifetime.signal.throwIfAborted();
    if (this.#attaching === pending && this.session.agent.spec.behaviorPin === json) {
      bindBehaviorEntries(
        this.session,
        declaredToolEntries(
          agent,
          (name) => this.hostCatalog.catalogEntry(name) != null,
          errors,
          () => this.session.findRunningTurn()?.uuid ?? "",
        ),
      );
      this.#report("load", errors);
      this.#attached = { json, agent };
      this.#attaching = null;
    }
    return agent;
  }

  async #load(json: string): Promise<{ readonly agent: AgentBehavior; readonly errors: string[] }> {
    const errors: string[] = [];
    let pin: AgentPin = EMPTY_PIN;
    try {
      pin = parseAgentPin(json);
    } catch (error) {
      errors.push(messageOf(error));
    }
    const attached = await this.kernel.attach({
      agentId: this.session.sessionId,
      projectId: this.projectId,
      pin,
    });
    errors.push(...attached.errors);
    return { agent: attached.agent, errors };
  }

  /**
   * A plugin promise this host waits on is bounded: by the hook deadline, and
   * (when `honourStop`) by the turn's cancel request. A timeout is recorded
   * as a problem and the boundary is skipped; the plugin's late result is dropped.
   */
  async #within<T>(
    turn: SessionTurn,
    work: Promise<T>,
    what: string,
    honourStop: boolean,
    opened?: { abandon(): void },
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
    const ms = this.hooks.hookTimeoutMs();
    let outcome;
    try {
      outcome = await bounded(work, {
        ms,
        signal: honourStop
          ? AbortSignal.any([
              this.#lifetime.signal,
              this.#admission.signal,
              ...(this.#signals.has(turn) ? [this.#signals.get(turn)!] : []),
            ])
          : this.#lifetime.signal,
        stopped: () => !isWorkReachable(this.session, turn) || (honourStop && turn.cancelRequested),
      });
    } catch (error) {
      opened?.abandon();
      throw error;
    }
    if (outcome.kind === "done") {
      if (
        !this.#lifetime.signal.aborted &&
        isWorkReachable(this.session, turn) &&
        (!honourStop || (!this.#admission.signal.aborted && !this.#signals.get(turn)?.aborted && !turn.cancelRequested))
      ) {
        return { ok: true, value: outcome.value };
      }
      opened?.abandon();
      return { ok: false };
    }
    opened?.abandon();
    if (outcome.kind === "timeout") this.problem(what, new Error(`no answer in ${ms}ms; skipped`));
    return { ok: false };
  }

  /** A guard cannot outlive its wrap or the turn that admitted it. */
  signalFor(job: ToolCallJob): AbortSignal {
    const owner = [...owningTurns(job)].find((turn) => this.#signals.has(turn));
    const signal = owner == null ? undefined : this.#signals.get(owner);
    return AbortSignal.any([this.#lifetime.signal, this.#admission.signal, ...(signal == null ? [] : [signal])]);
  }

  /** Stop new plugin entry immediately, while an effect already on the wire may still drain. */
  stopAdmission(): void {
    this.#admission.abort(new Error("plugin admission stopped"));
  }

  /** A hook or guard failure in this turn. Shown until the next turn starts. */
  problem(what: string, error: unknown): void {
    const text = `${what}: ${messageOf(error)}`;
    fail(what, error);
    if (this.#turnProblems.includes(text)) return;
    this.#turnProblems.push(text);
    this.#publish();
  }

  #report(stage: "pin" | "load", errors: readonly string[]): void {
    const text = errors.join("; ");
    if (text === this.#problems[stage]) return;
    this.#problems[stage] = text;
    this.#publish();
    if (text !== "") fail("plugin behavior", text);
  }

  #publish(): void {
    const joined = [this.#problems.pin, this.#problems.load, ...this.#turnProblems]
      .filter((row) => row !== "")
      .join("; ");
    const text = joined === "" ? null : joined;
    if (this.session.pluginProblem === text) return;
    runInAction(() => {
      this.session.pluginProblem = text;
    });
  }

  /** A parked turn is resumed by the next wrap, which opens its boundary again. */
  dropTurn(turn: SessionTurn): void {
    const state = this.#turns.get(turn);
    state?.round?.abandon();
    state?.turn?.abandon();
    this.#turns.delete(turn);
    this.#signals.delete(turn);
  }

  /**
   * Attach the session's behavior and open the turn boundary the first time
   * this orchestrator runs the turn. A turn picked up after a park or restart
   * (`resumed`) opens it again, so its post hooks still run when it ends.
   */
  async enterTurn(turn: SessionTurn, resumed: boolean, signal: AbortSignal): Promise<TurnBehavior | null> {
    this.#signals.set(turn, signal);
    const known = this.#turns.get(turn);
    if (known != null) return known;
    const preparation = new AbortController();
    const signalForPreparation = AbortSignal.any([
      signal,
      this.#lifetime.signal,
      this.#admission.signal,
      preparation.signal,
    ]);
    const prepared = await this.#within(turn, this.prepare(signalForPreparation), "plugin behavior", true, {
      abandon: () => preparation.abort(new Error("plugin preparation abandoned")),
    });
    if (!prepared.ok) return null;
    const agent = prepared.value;
    this.hooks.syncTools(turn);
    const state: TurnBehavior = { agent, turn: null, round: null, rounds: 0 };
    this.#turns.set(turn, state);
    if (agent.empty) return state;
    const opened = agent.openBoundary("turn", new Dict({ id: turn.uuid, prompt: turn.prompt, resumed }), turn.uuid);
    const started = await this.#within(turn, opened.started, "plugin turn hook", true, opened);
    // Stopped: no turn. Timed out: the turn runs without that boundary.
    if (!started.ok)
      return signal.aborted || turn.cancelRequested || !isWorkReachable(this.session, turn) ? null : state;
    if (!started.value.entered) {
      this.#refused("turn", started.value.outcome);
      return null;
    }
    state.turn = opened;
    return state;
  }

  async openRound(turn: SessionTurn, state: TurnBehavior): Promise<boolean> {
    if (state.agent.empty) return true;
    state.rounds += 1;
    const opened = state.agent.openBoundary("round", new Dict({ turn: turn.uuid, index: state.rounds }), turn.uuid);
    const started = await this.#within(turn, opened.started, "plugin round hook", true, opened);
    if (!started.ok) return !turn.cancelRequested;
    if (!started.value.entered) {
      this.#refused("round", started.value.outcome);
      return false;
    }
    state.round = opened;
    return true;
  }

  async closeRound(turn: SessionTurn, settle: Settle): Promise<void> {
    const state = this.#turns.get(turn);
    const round = state?.round;
    if (state == null || round == null) return;
    state.round = null;
    const finished = await this.#within(turn, round.finish(settle), "plugin round hook", true, round);
    if (finished.ok) this.#boundaryReport("round", finished.value);
  }

  /** A round still open here did not finish. The turn fails only when cancelled or broken. */
  async leaveTurn(turn: SessionTurn, broke: string): Promise<void> {
    await Promise.all([...this.#finishing.values()].filter((work) => work.owner === turn).map((work) => work.promise));
    const state = this.#turns.get(turn);
    if (state == null) {
      this.#signals.delete(turn);
      this.#recordPluginState(turn);
      return;
    }
    this.#turns.delete(turn);
    const failure = turn.cancelRequested ? "cancelled" : broke;
    try {
      // The post hooks run on a cancel too (they report it), so only the deadline bounds them.
      if (state.round != null) {
        const round = state.round;
        state.round = null;
        const finished = await this.#within(
          turn,
          round.finish({ ok: false, error: failure === "" ? "round did not finish" : failure }),
          "plugin round hook",
          false,
          round,
        );
        if (finished.ok) this.#boundaryReport("round", finished.value);
      }
      if (state.turn != null) {
        const finished = await this.#within(
          turn,
          state.turn.finish(failure === "" ? { ok: true, value: false } : { ok: false, error: failure }),
          "plugin turn hook",
          false,
          state.turn,
        );
        if (finished.ok) this.#boundaryReport("turn", finished.value);
      }
    } catch (error) {
      this.problem("plugin turn boundary", error);
    } finally {
      this.#signals.delete(turn);
      this.kernel.notes.expireUnused(this.session.sessionId, turn.uuid);
      this.#recordPluginState(turn);
    }
  }

  /**
   * The turn's end state is what a rewind to it restores. A turn rewound
   * away while its hooks ran must not leave their writes on the new head.
   */
  #recordPluginState(turn: SessionTurn): void {
    // A turn off the live chain was rewound away. The plugin state in the
    // session now belongs to the head that replaced it: record nothing on the
    // old turn and restore nothing, however late its hooks finish.
    if (!isWorkReachable(this.session, turn)) return;
    turn.pluginState = this.session.pluginState;
  }

  #boundaryReport(point: string, outcome: BoundaryOutcome): void {
    for (const failure of outcome.hookFailures) this.problem(`plugin ${point} hook`, failure);
    if (outcome.guardFailure !== "") this.problem(`plugin ${point} guard`, outcome.guardFailure);
  }

  #refused(point: string, outcome: BoundaryOutcome): void {
    this.problem(`plugin ${point} refused`, outcome.refusal === "" ? outcome.failure : outcome.refusal);
    this.#boundaryReport(point, outcome);
  }

  /**
   * The wrapper opened by the guards waits for the body's receipt. The job's
   * ending releases it, whichever way the job ends: a job cancelled between
   * guard and body never reaches `finishTool`, and without this its post
   * hooks would never run and the closure would stay held.
   */
  holdTool(job: ToolCallJob, opened: Opened<ToolOutcome>): void {
    const origin = hostingTurnOf(this.session, job);
    const held: HeldTool = {
      opened,
      owner: owningTurns(job).next().value ?? null,
      retained: () => origin != null && this.session.liveTurns.has(origin) && origin.subtreeWork.includes(job),
    };
    this.#tools.set(job, held);
    const fire = (): void => {
      this.#releases.delete(job);
      if (this.#tools.get(job) !== held) return;
      this.#tools.delete(job);
      const receipt = job.receiptJson ?? "";
      const settle: Settle =
        job instanceof CallJob
          ? callSettle(job, "cancelled")
          : receipt !== ""
            ? outcomeValue(receipt)
            : { ok: false, error: "cancelled" };
      const finishing = this.#finishToolBoundary(job, held, settle);
      this.#finishing.set(job, { owner: held.owner, promise: finishing });
      void finishing.finally(() => this.#finishing.delete(job));
    };
    const release = when(() => job.completed || job.cancelled, fire);
    if (this.#tools.get(job) === held) this.#releases.set(job, release);
  }

  /** Post hooks observe the worker's settled outcome. */
  async finishCall(job: CallJob, signal: AbortSignal): Promise<void> {
    const held = this.#tools.get(job);
    if (held == null) {
      await this.#finishing.get(job)?.promise;
      return;
    }
    const { opened } = held;
    this.#tools.delete(job);
    this.#releases.get(job)?.();
    this.#releases.delete(job);
    if (isParkAbort(signal)) {
      opened.abandon();
      return;
    }
    await this.#finishToolBoundary(
      job,
      held,
      callSettle(job, signal.aborted ? cancelOutcomeText(signal.reason) : "no outcome"),
      signal,
    );
  }

  /** Post hooks and guard tails see the core's receipt, which they may replace or annotate. */
  async finishTool(job: ToolCallJob, signal: AbortSignal): Promise<void> {
    const held = this.#tools.get(job);
    if (held == null) {
      await this.#finishing.get(job)?.promise;
      return;
    }
    const { opened } = held;
    this.#tools.delete(job);
    this.#releases.get(job)?.();
    this.#releases.delete(job);
    if (isParkAbort(signal)) {
      opened.abandon();
      return;
    }
    const receipt = job.receiptJson ?? "";
    const outcome = await this.#finishToolBoundary(job, held, outcomeValue(receipt), signal);
    if (outcome == null || signal.aborted || job.completed || job.cancelled) return;
    const next = guardedOutcomeJson(receipt, outcome);
    if (next !== receipt) {
      runInAction(() => {
        job.receiptJson = next;
      });
    }
  }

  async #finishToolBoundary(
    job: ToolCallJob,
    held: HeldTool,
    settle: Settle,
    signal?: AbortSignal,
  ): Promise<ToolOutcome | null> {
    const { opened } = held;
    const inactive = () =>
      this.#lifetime.signal.aborted || this.#admission.signal.aborted || signal?.aborted === true || !held.retained();
    if (inactive()) {
      opened.abandon();
      return null;
    }
    try {
      const result = await bounded(opened.finish(settle), {
        ms: this.hooks.hookTimeoutMs(),
        signal: AbortSignal.any([this.#lifetime.signal, this.#admission.signal, ...(signal == null ? [] : [signal])]),
        stopped: () => !held.retained(),
      });
      if (result.kind !== "done") {
        opened.abandon();
        if (result.kind === "timeout") this.problem(`plugin ${job.name} hook`, new Error("deadline exceeded; skipped"));
        return null;
      }
      if (inactive()) {
        opened.abandon();
        return null;
      }
      this.toolReport(job, result.value);
      return result.value;
    } catch (error) {
      opened.abandon();
      this.problem(`plugin ${job.name} hook`, error);
      return null;
    }
  }

  toolReport(job: ToolCallJob, outcome: ToolOutcome): void {
    for (const failure of outcome.hookFailures) this.problem(`plugin ${job.name} hook`, failure);
    if (outcome.guardFailure !== "") this.problem(`plugin ${job.name} guard`, outcome.guardFailure);
  }

  [Symbol.dispose](): void {
    this.#lifetime.abort(new Error("plugin behavior disposed"));
    for (const turn of this.#turns.keys()) this.dropTurn(turn);
    for (const held of this.#tools.values()) held.opened.abandon();
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#tools.clear();
    this.#signals.clear();
    bindBehaviorEntries(this.session, []);
  }
}
