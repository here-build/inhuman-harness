/**
 * Bypass-detection settings for unattended runs. Defaults match the owner's decision: a check after
 * 3 consecutive or 20 total denials, a hard stop after 60 (`null` turns it off), and a check that
 * cannot be made twice stops the run (fail closed; `stopOnDoubleFail: false` continues instead).
 *
 * Layering: the first of managed.set > session > user > dist that names a field wins; the project
 * layer and managed.require can only tighten (lower thresholds, a stop that is on stays on).
 */
import type { AuthorizationConfig } from "./config.js";
import type { Layers } from "./resolve.js";

export type Escalation = {
  readonly consecutiveDenials: number;
  readonly totalDenials: number;
  /** How many of the latest calls (denied or not) the bypass judge sees. */
  readonly window: number;
  readonly hardStopTotal: number | null;
  readonly stopOnDoubleFail: boolean;
  readonly bypassCheck: boolean;
};

export const DEFAULT_ESCALATION: Escalation = {
  consecutiveDenials: 3,
  totalDenials: 20,
  window: 20,
  hardStopTotal: 60,
  stopOnDoubleFail: true,
  bypassCheck: true,
};

function pick<K extends keyof NonNullable<AuthorizationConfig["escalate"]>>(
  cfgs: ReadonlyArray<AuthorizationConfig | undefined>,
  key: K,
): NonNullable<AuthorizationConfig["escalate"]>[K] | undefined {
  for (const cfg of cfgs) {
    const value = cfg?.escalate?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function escalationOf(layers: Layers): Escalation {
  const loosen = [layers.managedSet, layers.session, layers.user];
  const tighten = [layers.managedRequire, layers.project];
  const lowest = (base: number, key: "consecutiveDenials" | "totalDenials" | "window"): number => {
    let value = pick(loosen, key) ?? base;
    for (const cfg of tighten) {
      const t = cfg?.escalate?.[key];
      if (t !== undefined) value = Math.min(value, t);
    }
    return value;
  };
  let hardStopTotal = pick(loosen, "hardStopTotal");
  if (hardStopTotal === undefined) hardStopTotal = DEFAULT_ESCALATION.hardStopTotal;
  for (const cfg of tighten) {
    const t = cfg?.escalate?.hardStopTotal;
    // A tighten layer can lower the cap or turn a missing one on; it cannot turn the stop off.
    if (typeof t === "number") hardStopTotal = hardStopTotal === null ? t : Math.min(hardStopTotal, t);
  }
  let stopOnDoubleFail = pick(loosen, "stopOnDoubleFail") ?? DEFAULT_ESCALATION.stopOnDoubleFail;
  let bypassCheck = loosen.map((cfg) => cfg?.judge?.bypass?.enabled).find((v) => v !== undefined) ?? true;
  for (const cfg of tighten) {
    if (cfg?.escalate?.stopOnDoubleFail === true) stopOnDoubleFail = true;
    if (cfg?.judge?.bypass?.enabled === true) bypassCheck = true;
  }
  return {
    consecutiveDenials: lowest(DEFAULT_ESCALATION.consecutiveDenials, "consecutiveDenials"),
    totalDenials: lowest(DEFAULT_ESCALATION.totalDenials, "totalDenials"),
    window: lowest(DEFAULT_ESCALATION.window, "window"),
    hardStopTotal,
    stopOnDoubleFail,
    bypassCheck,
  };
}
