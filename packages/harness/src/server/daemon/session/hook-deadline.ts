/**
 * A plugin boundary hook holds its turn open while it runs, so it gets a
 * deadline, and a stop request outranks it. Liveness is never left to a
 * promise the plugin controls.
 */
import { when } from "mobx";

/** Session or kernel kv, in milliseconds. */
export const PLUGIN_HOOK_TIMEOUT_KV = "plugin.hook-timeout-ms";
export const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 60_000;

/** Session kv wins over kernel kv; a value that is not a positive number is ignored. */
export function pluginHookTimeoutMs(...kvs: ReadonlyArray<Readonly<Record<string, string>> | undefined>): number {
  for (const kv of kvs) {
    const raw = kv?.[PLUGIN_HOOK_TIMEOUT_KV]?.trim() ?? "";
    if (raw === "") continue;
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return DEFAULT_PLUGIN_HOOK_TIMEOUT_MS;
}

export type Bounded<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "timeout" }
  | { readonly kind: "stopped" };

export type HookBound = {
  readonly ms: number;
  /** Ends the wait early: the turn's cancel request. Absent for a hook that must run on cancel. */
  readonly stopped?: () => boolean;
};

/**
 * Wait for `work`, but not past the deadline and not past a stop request.
 * The work itself is not cancelled (a plugin promise has no abort): it is
 * abandoned, and its late result or rejection is dropped.
 */
export function bounded<T>(work: Promise<T>, bound: HookBound): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: () => void = () => {};
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop();
      run();
    };
    timer = setTimeout(() => finish(() => resolve({ kind: "timeout" })), bound.ms);
    if (bound.stopped != null) {
      stop = when(bound.stopped, () => finish(() => resolve({ kind: "stopped" })));
    }
    work.then(
      (value) => finish(() => resolve({ kind: "done", value })),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
