/**
 * Local servers as a live offer list. Observable state that wakes only while
 * something observes it (the orchestrator's catalog mirror): probe once on
 * wake, then re-probe on an interval for as long as a client is looking at
 * the driver. Nobody looking, nothing observing: no timer.
 */
import { step } from "@inhuman.tools/harness-diagnostics";
import type { DriverOffer } from "@inhuman.tools/plexus-expectations/driver";
import {
  comparer,
  type IObservableValue,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  reaction,
  runInAction,
} from "mobx";

import { probeLocalOffers } from "./presence.js";

/** Re-probe period while a client looks at the driver. */
export const LOCAL_PROBE_INTERVAL_MS = 4_000;

export function detectedLocalOffers(options: {
  readonly looking: () => boolean;
  readonly fetch?: () => typeof fetch;
  readonly intervalMs?: number;
}): IObservableValue<readonly DriverOffer[]> {
  const { looking, fetch: fetchOf = () => fetch, intervalMs = LOCAL_PROBE_INTERVAL_MS } = options;
  const box = observable.box<readonly DriverOffer[]>([], { deep: false, equals: comparer.structural });
  let sleep: (() => void) | undefined;
  onBecomeObserved(box, () => {
    let awake = true;
    let busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const found = await probeLocalOffers(fetchOf());
        if (awake) runInAction(() => box.set(found));
      } finally {
        busy = false;
      }
    };
    const arm = (on: boolean): void => {
      clearInterval(timer);
      timer = on ? setInterval(() => void run(), intervalMs) : undefined;
      timer?.unref();
    };
    step("openai-compat local offers wake");
    void run();
    arm(looking());
    const stopWatching = reaction(looking, (on) => {
      if (on) void run();
      arm(on);
    });
    sleep = () => {
      awake = false;
      stopWatching();
      arm(false);
    };
  });
  onBecomeUnobserved(box, () => {
    step("openai-compat local offers sleep");
    sleep?.();
    sleep = undefined;
  });
  return box;
}
