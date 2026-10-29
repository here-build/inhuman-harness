/**
 * COLLECTORS ARE NOT `.work`. Collectors expand until `walkBoundary`.
 * Job is a WorkContainer, not a WorkExpectation.
 *
 * `orchestrationResult` is the guard's boolean. `orchestrated` is computed
 * (`!== null`). `cancelled` is the cancel fact. Do not assign `orchestrated`.
 *
 * Await settles on `result`, not on this object. `result` stays null until
 * `endedAtMs` is set, then this class fulfills `undefined`. `cancelled` alone
 * does not settle. A subclass names its value and rejection by overriding `result`.
 */
import { syncing } from "@here.build/plexus";
import { computed, when } from "mobx";
import invariant from "tiny-invariant";

import { WorkContainer } from "./WorkContainer.js";

export type JobResolution<TValue, TReason> =
  { readonly status: "fulfilled"; readonly value: TValue } | { readonly status: "rejected"; readonly reason: TReason };

export type JobKind = "command" | "agent" | "bot" | "workflow";

/** Runtime that owns a job's effect. */
export type JobEffectOwner = "session-runtime" | "tool-runtime" | "scheme-runtime" | "agent-calls" | "honor";

/** What a restart does with a job whose outcome it cannot see. */
export type UnknownOutcomeRecovery = "resume-queued" | "resume-inner" | "unknown-no-replay";

@syncing("@inhuman.tools/plexus-expectations:Job")
export abstract class Job<TValue = unknown, TReason = unknown> extends WorkContainer implements Promise<TValue> {
  #pending: Promise<TValue> | null = null;

  /** Not this instantiation — a parent holds jobs with other fulfill and reject types. */
  @syncing.child.list accessor children: Job<unknown, unknown>[] = [];
  @syncing accessor background: boolean = false;
  @syncing accessor walkBoundary: boolean = false;
  /** Guard return. `null` = phase 1 not done. */
  @syncing accessor orchestrationResult: true | false | null = null;
  /** Cancel fact. `false → true`. Not a deny and not a human approval. */
  @syncing accessor cancelled: boolean = false;
  /** This job's own work has finalized (ok or not). */
  @syncing accessor completed: boolean = false;
  /**
   * Crash ending: the license guard or the executor body threw. Empty means
   * no crash. The message is the fact; the host stamps a receipt from it and
   * the job completes, so whoever joins the job is released with an outcome.
   */
  @syncing accessor crash: string = "";
  /**
   * Ordering as data: jobs that must be released before this one is claimed
   * (license and body). Refs to earlier siblings, never a cycle. The
   * orchestrator honours it on every pass, so it holds across a restart.
   */
  @syncing.list accessor after: Job<unknown, unknown>[] = [];

  /**
   * Seal + end clock, in one update: `result` keys on `endedAtMs`, so a
   * crash between the two writes would leave a completed job unawaitable.
   * Deny-without-BODY leaves `startedAtMs` null.
   */
  @syncing.action
  markComplete(now = Date.now()): void {
    if (!this.completed) this.completed = true;
    this.markEnded(now);
  }

  /** Replace {@link after}. Call before the job becomes reachable. */
  @syncing.action
  stampAfter(jobs: readonly Job<unknown, unknown>[]): void {
    this.after.splice(0, this.after.length, ...jobs);
  }

  /**
   * Released for a successor: done, cancelled, or a background job that has
   * started. A denied or failed predecessor is done too; order is not success.
   */
  get released(): boolean {
    return this.completed || this.cancelled || (this.orchestrated && this.background);
  }

  /** Every {@link after} predecessor is released. */
  @computed
  get afterReleased(): boolean {
    return this.after.every((job) => job.released);
  }

  /** Parent `child` when it is not already in `children`. Does not enqueue or wait. */
  registerJob<T extends Job<unknown, unknown>>(child: T): T {
    if (!this.children.includes(child)) this.children.push(child);
    return child;
  }

  @computed
  get orchestrated(): boolean {
    return this.orchestrationResult !== null;
  }

  /** Not one call. Agent, bot, shell, and program override. */
  get kind(): JobKind {
    return "workflow";
  }

  /** Not the background flag. Call, program, and shell override. */
  get isTrackedBackground(): boolean {
    return false;
  }

  /** Not the wire name. Call, program, and shell override. */
  get object(): string {
    return "";
  }

  /**
   * Effect contract for this class. Not synced. An abstract intermediate
   * declares none, so every concrete kind has to state its own.
   */
  abstract readonly owner: JobEffectOwner;
  abstract readonly intent: string;
  abstract readonly checkpoint: string;
  abstract readonly dispatch: string;
  abstract readonly settlement: string;
  abstract readonly cancel: string;
  abstract readonly unknownRecovery: UnknownOutcomeRecovery;
  abstract readonly unknownNote: string;
  abstract readonly intentRequired: boolean;

  @computed
  get jobs(): Job<unknown, unknown>[] {
    const out: Job<unknown, unknown>[] = [];
    for (const child of this.children) {
      if (!(child instanceof Job)) continue;
      out.push(child);
      if (!child.walkBoundary) out.push(...child.jobs);
    }
    return out;
  }

  @computed
  get foregroundJobs(): Job<unknown, unknown>[] {
    return this.jobs.filter((node) => !node.background);
  }

  @computed
  get backgroundJobs(): Job<unknown, unknown>[] {
    return this.jobs.filter((node) => node.background);
  }

  @computed
  get result(): JobResolution<TValue, TReason> | null {
    if (this.endedAtMs == null) return null;
    return { status: "fulfilled", value: undefined as TValue };
  }

  @computed
  get work(): readonly WorkContainer[] {
    return this.children;
  }

  then<TFulfilled = TValue, TRejected = never>(
    onfulfilled?: ((value: TValue) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onrejected?: ((reason: TReason) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TFulfilled | TRejected> {
    return this.#settled().then(onfulfilled, onrejected);
  }

  catch<TRejected = never>(
    onrejected?: ((reason: TReason) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TValue | TRejected> {
    return this.#settled().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<TValue> {
    return this.#settled().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return "Job";
  }

  #settled(): Promise<TValue> {
    if (this.#pending != null) return this.#pending;
    const deliver = (): TValue => {
      const resolution = this.result;
      invariant(resolution != null, "Job settled without result");
      if (resolution.status === "rejected") throw resolution.reason;
      return resolution.value;
    };
    this.#pending =
      this.result != null ? Promise.resolve().then(deliver) : when(() => this.result != null).then(deliver);
    return this.#pending;
  }
}
