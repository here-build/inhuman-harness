import { type PlexusAwareness, syncing } from "@here.build/plexus";
import { docPlexus } from "@here.build/plexus/internals";
import { comparer, computed, observable, reaction, when } from "mobx";
import invariant from "tiny-invariant";

import { type EndCause, type ExpectationOutcome } from "../control.js";
import { roleOf } from "../role.js";
import type { SessionAwareness, SessionPlexus } from "../types.js";
import { Job } from "./Job.js";
import { WorkContainer } from "./WorkContainer.js";

/**
 * Awareness: empty string occupies the role map without a report frame.
 * Retract drops the uuid. Not a durable outcome.
 */
export const ROLE_LANE_OCCUPIED = "";

@syncing("@inhuman.tools/plexus-expectations:WorkExpectation")
export abstract class WorkExpectation<TResult = unknown, TReport = unknown>
  extends WorkContainer
  implements Promise<ExpectationOutcome>
{
  /**
   * Kernel catalog key this work rides. Required at construction.
   * Plexus materialization passes a symbol through unchanged.
   */
  @syncing
  accessor connectionId!: string;

  constructor(init: { readonly connectionId: string } | symbol) {
    if (typeof init !== "symbol") {
      invariant(
        typeof init.connectionId === "string" && init.connectionId !== "",
        "WorkExpectation.connectionId is required",
      );
    }
    super(init);
  }

  @syncing
  accessor outcome: ExpectationOutcome | null = null;

  @syncing
  accessor endCause: EndCause | null = null;

  @syncing
  accessor endDetail: string | null = null;

  /** Durable last frame as JSON. `"null"` when the work ended without a report. */
  @syncing
  accessor outcomeReport: string | null = null;

  /** Last live role-map frame this process saw. Retract does not clear it. */
  @observable.ref private accessor lastProgress: TReport | null = null;
  #progressCacheStarted = false;
  #settledPromise: Promise<ExpectationOutcome> | null = null;

  get plexus(): SessionPlexus | null {
    const doc = this.__doc__;
    if (!doc) return null;
    const plexus = docPlexus.get(doc);
    if (!plexus) return null;
    return plexus as SessionPlexus;
  }

  get awareness(): PlexusAwareness<SessionAwareness> | null {
    const hub = this.plexus?.awareness ?? null;
    if (hub != null) this.#ensureProgressCache();
    return hub;
  }

  // MobX: arm on the first `awareness` read so a later untracked read still
  // sees the last frame. Dispose on done — a sealed lane is frozen; do not
  // keep a reaction per expectation for the life of the document.
  #ensureProgressCache(): void {
    if (this.#progressCacheStarted) return;
    this.#progressCacheStarted = true;
    reaction(
      () => ({ done: this.isDone, frame: this.#liveProgressFrame() }),
      ({ done, frame }, _previous, self) => {
        if (frame !== null) this.lastProgress = frame;
        if (done) self.dispose();
      },
      { fireImmediately: true, equals: comparer.structural },
    );
  }

  #liveProgressFrame(): TReport | null {
    const hub = this.awareness;
    if (hub == null) return null;
    const frame = roleOf(hub, this.uuid);
    if (frame == null || frame === ROLE_LANE_OCCUPIED) return null;
    return frame as TReport;
  }

  /** Live progress as the fulfiller tells it. Awareness retract does not drop the last frame. */
  @computed
  get progressAwareness(): TReport | null {
    return this.#liveProgressFrame() ?? this.lastProgress;
  }

  /** Occupancy on the role map. Not a durable outcome. */
  @computed
  get workerPresent(): boolean {
    const hub = this.awareness;
    if (hub == null) return false;
    const value = roleOf(hub, this.uuid);
    return value !== undefined && value !== null;
  }

  get isDone(): boolean {
    return this.outcome != null;
  }

  /** Leaf. PEW does not parent PEW. */
  get work(): readonly WorkExpectation[] {
    return [this];
  }

  /**
   * Settles when {@link isDone}. Fulfills with {@link outcome} for both
   * `successful` and `failed` — failure is an outcome, not a rejection.
   * The fulfillment cannot be `this`: a thenable that resolves to itself
   * never settles (Promise unwraps `then` forever).
   */
  then<TFulfilled = ExpectationOutcome, TRejected = never>(
    onfulfilled?: ((value: ExpectationOutcome) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onrejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TFulfilled | TRejected> {
    return this.#settled().then(onfulfilled, onrejected);
  }

  catch<TRejected = never>(
    onrejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<ExpectationOutcome | TRejected> {
    return this.#settled().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<ExpectationOutcome> {
    return this.#settled().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return "WorkExpectation";
  }

  #settled(): Promise<ExpectationOutcome> {
    if (this.#settledPromise != null) return this.#settledPromise;
    this.#settledPromise = this.isDone
      ? Promise.resolve(this.#sealedOutcome())
      : when(() => this.isDone).then(() => this.#sealedOutcome());
    return this.#settledPromise;
  }

  #sealedOutcome(): ExpectationOutcome {
    invariant(this.outcome != null, "WorkExpectation settled without outcome");
    return this.outcome;
  }

  applySettlement(_result: TResult): void {}

  #parseOutcomeReport(): TReport | null {
    if (this.outcomeReport == null) return null;
    try {
      return JSON.parse(this.outcomeReport) as TReport | null;
    } catch {
      return null;
    }
  }

  /**
   * Durable outcome frame if written, else last progress seen.
   * {@link ROLE_LANE_OCCUPIED} is not a frame. Retract keeps the last frame.
   */
  @computed
  get report(): TReport | null {
    if (this.outcomeReport != null) return this.#parseOutcomeReport();
    return this.progressAwareness;
  }

  @syncing.action
  succeed(cause: EndCause, detail: string, outcomeReport: string, settlement?: { readonly result: TResult }): boolean {
    if (this.isDone) return false;
    if (settlement !== undefined) {
      try {
        this.applySettlement(settlement.result);
      } catch (error) {
        this.outcome = "failed";
        this.endCause = cause;
        this.endDetail = `apply_error: ${String(error)}`;
        this.outcomeReport = outcomeReport;
        this.markEnded();
        return true;
      }
    }
    this.outcome = "successful";
    this.endCause = cause;
    this.endDetail = detail;
    this.outcomeReport = outcomeReport;
    this.markEnded();
    return true;
  }

  @syncing.action
  fail(cause: EndCause, detail: string, outcomeReport: string): boolean {
    if (this.isDone) return false;
    this.outcome = "failed";
    this.endCause = cause;
    this.endDetail = detail;
    this.outcomeReport = outcomeReport;
    this.markEnded();
    return true;
  }
}

/** Open work whose parent sealed — honor does not start these. */
export function isTreeOrphan(node: WorkExpectation): boolean {
  if (node.isDone) return false;
  const parent = node.parent;
  if (parent === null) return false;
  if (parent instanceof WorkExpectation) return parent.isDone;
  if (parent instanceof Job) return parent.completed;
  return false;
}

/** Admits every WorkExpectation instantiation. */
export type AnyWorkExpectation = WorkExpectation<any, any>;
export type ResultOf<E extends AnyWorkExpectation> = Parameters<E["applySettlement"]>[0];
export type ReportOf<E extends AnyWorkExpectation> = Exclude<E["report"], null>;
