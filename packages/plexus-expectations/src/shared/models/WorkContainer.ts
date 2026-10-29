/**
 * Work graph node. `work` may be a synced list or a computed getter.
 * Walking `.work` from the document root is the whole out-reachable set.
 *
 * Brand is on this class — do not duck-type `.work`.
 *
 * Thenable. The fulfillment is not `this` — a thenable that resolves to itself
 * never settles. This class settles when `endedAtMs` is set, fulfills
 * `undefined`, and does not reject. {@link WorkExpectation} fulfills its
 * outcome. {@link Job} fulfills or rejects from `result`. The promise value
 * here is `unknown` so both stay containers.
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import { when } from "mobx";

export const workContainer: unique symbol = Symbol.for("work:container") as never;

/** Base promise value. An expectation narrows it to the outcome; a job narrows it per class. */
export type WorkFulfillment = unknown;

@syncing("@inhuman.tools/plexus-expectations:WorkContainer")
export abstract class WorkContainer extends PlexusModel implements Promise<WorkFulfillment> {
  readonly [workContainer] = true as const;
  #settledPromise: Promise<WorkFulfillment> | null = null;

  /** Epoch ms. Write-once. BODY / actor start — not mint, not the guard. */
  @syncing accessor startedAtMs: number | null = null;
  /** Epoch ms. Write-once. Job complete / PEW succeed|fail. This class's thenable settles on this. */
  @syncing accessor endedAtMs: number | null = null;

  abstract readonly work: readonly WorkContainer[];

  markStarted(now = Date.now()): void {
    if (this.startedAtMs != null) return;
    this.startedAtMs = now;
  }

  markEnded(now = Date.now()): void {
    if (this.endedAtMs != null) return;
    this.endedAtMs = now;
  }

  /** Live: `now - startedAtMs`. Sealed: `endedAtMs - startedAtMs`. Null if start was never stamped. */
  durationMs(now = Date.now()): number | null {
    if (this.startedAtMs == null || !Number.isFinite(this.startedAtMs)) return null;
    const end =
      this.endedAtMs != null && Number.isFinite(this.endedAtMs) ? this.endedAtMs : now;
    return Math.max(0, end - this.startedAtMs);
  }

  then<TFulfilled = WorkFulfillment, TRejected = never>(
    onfulfilled?: ((value: WorkFulfillment) => TFulfilled | PromiseLike<TFulfilled>) | null,
    onrejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<TFulfilled | TRejected> {
    return this.#settled().then(onfulfilled, onrejected);
  }

  catch<TRejected = never>(
    onrejected?: ((reason: unknown) => TRejected | PromiseLike<TRejected>) | null,
  ): Promise<WorkFulfillment | TRejected> {
    return this.#settled().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<WorkFulfillment> {
    return this.#settled().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return "WorkContainer";
  }

  #settled(): Promise<WorkFulfillment> {
    if (this.#settledPromise != null) return this.#settledPromise;
    const fulfill = (): WorkFulfillment => undefined;
    this.#settledPromise =
      this.endedAtMs != null ? Promise.resolve(fulfill()) : when(() => this.endedAtMs != null).then(fulfill);
    return this.#settledPromise;
  }
}

/** Preorder walk of `.work`, cycle-safe. `item === container` stops a leaf `[this]` from recursing. */
export function* walkWork(container: WorkContainer, seen: Set<WorkContainer> = new Set()): Generator<WorkContainer> {
  for (const item of container.work) {
    if (seen.has(item)) continue;
    seen.add(item);
    yield item;
    if (item === container) continue;
    yield* walkWork(item, seen);
  }
}
