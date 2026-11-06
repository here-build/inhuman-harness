/**
 * Observe-on-demand Arrival exec. The box is a MobX atom: first observer
 * arms membraneClosure tracking; last observer tears the reaction down.
 */
import { exec, type ExecOptions } from "@here.build/arrival";
import { comparer, createAtom, type IAtom, type IObservable, Reaction, runInAction } from "mobx";

export type ComputedExecOptions = Omit<ExecOptions, "membraneClosure">;

type Observed = IObservable & {
  reportObserved?: () => boolean;
  get?: () => unknown;
};

export class ComputedExecBox<T> {
  readonly #source: string;
  readonly #opts: ComputedExecOptions;
  readonly #atom: IAtom;
  #value: T | undefined;
  #generation = 0;
  #controller: AbortController | null = null;
  #rx: Reaction | null = null;
  #probe: Reaction | null = null;

  constructor(source: string, opts: ComputedExecOptions) {
    this.#source = source;
    this.#opts = opts;
    this.#atom = createAtom(
      "computedExec",
      () => this.#start(),
      () => this.#stop(),
    );
  }

  get(): T | undefined {
    this.#atom.reportObserved();
    return this.#value;
  }

  #start(): void {
    this.#controller = new AbortController();
    this.#rx = new Reaction("computedExec.deps", () => void this.#run(), undefined, false);
    this.#probe = new Reaction("computedExec.probe", () => undefined, undefined, false);
    void this.#run();
  }

  #stop(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = null;
    this.#rx?.dispose();
    this.#rx = null;
    this.#probe?.dispose();
    this.#probe = null;
  }

  async #run(): Promise<void> {
    const rx = this.#rx;
    const probe = this.#probe;
    const controller = this.#controller;
    if (rx === null || probe === null || controller === null) return;

    const generation = (this.#generation += 1);
    const held = new Set<Observed>();

    try {
      const values: T[] = await exec(this.#source, {
        ...this.#opts,
        signal: AbortSignal.any([this.#opts.signal, controller.signal].filter((v) => v !== undefined)),
        membraneClosure: <R>(work: () => R): R => {
          let result!: R;
          probe.track(() => {
            result = work();
          });
          for (const dep of probe.observing_) held.add(dep);
          return result;
        },
      });
      if (generation !== this.#generation || controller.signal.aborted) return;

      rx.track(() => {
        // Every held atom. Returning after the first drops `rows.keys` / `row.name`.
        for (const dep of held) {
          if (typeof dep.reportObserved === "function") {
            dep.reportObserved();
            continue;
          }
          dep.get?.();
        }
      });

      const next = values.at(-1);
      if (comparer.structural(next, this.#value)) return;
      runInAction(() => {
        this.#value = next;
        this.#atom.reportChanged();
      });
    } catch {
      if (generation !== this.#generation || controller.signal.aborted) return;
    }
  }
}
