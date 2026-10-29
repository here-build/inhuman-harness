/**
 * Host store for one watch bag. Baseline is the last *committed* item list at
 * an access key — identity is applied at observe time, not stored.
 *
 * `resetPeriod` starts a tick (clears pending + done). `commit` / `commitKeys` /
 * `abandon` seal it. A forgotten seal leaves the previous baseline (re-emit),
 * which is abandon. `doneRequested` / `doneResult` are last-write this period;
 * they do not stop a clock — the host reads them. `doneResult` is the bag
 * outcome when the predicate held and a result was passed.
 */
import type { SchemeValue } from "@here.build/arrival";

export class WatchBaseline {
  readonly #baselines = new Map<string, readonly SchemeValue[]>();
  readonly #pending = new Map<string, readonly SchemeValue[]>();
  #done = false;
  #doneResult: SchemeValue | undefined;

  peek(key: string): readonly SchemeValue[] | undefined {
    return this.#baselines.get(key);
  }

  observe(key: string, items: readonly SchemeValue[]): void {
    this.#pending.set(key, items);
  }

  resetPeriod(): void {
    this.#pending.clear();
    this.#done = false;
    this.#doneResult = undefined;
  }

  commit(): void {
    for (const [key, items] of this.#pending) this.#baselines.set(key, items);
    this.#pending.clear();
  }

  commitKeys(keys: readonly string[]): void {
    for (const key of keys) {
      const items = this.#pending.get(key);
      if (items !== undefined) this.#baselines.set(key, items);
    }
    this.#pending.clear();
  }

  abandon(): void {
    this.#pending.clear();
  }

  get doneRequested(): boolean {
    return this.#done;
  }

  get doneResult(): SchemeValue | undefined {
    return this.#doneResult;
  }

  noteDone(holds: boolean, result?: SchemeValue): void {
    this.#done = holds;
    this.#doneResult = holds ? result : undefined;
  }
}
