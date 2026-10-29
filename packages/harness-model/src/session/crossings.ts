/**
 * One program run's crossing identity. A fan starts every callback in index
 * order and then waits, so a later call inside a callback is minted in whichever
 * element finished first. The window path is claimed when the call starts, and
 * the counter under it is per run, so a replay demands the same child the live
 * run minted.
 */
import type { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import type { ToolCallJob } from "./jobs/ToolCallJob.js";

type Ledger = {
  origin: number;
  epoch: number;
  readonly counts: Map<string, number>;
  readonly consumed: Set<ToolCallJob>;
};

const ledgers = new WeakMap<object, Ledger>();
const replaying = new WeakSet<object>();

/** The replay's emission. The daemon's emission is a different object, so a live mint is not refused. */
export function markReplaying(emission: object): void {
  replaying.add(emission);
}

export function isReplaying(emission: object): boolean {
  return replaying.has(emission);
}

function ledgerOf(emission: object): Ledger {
  let ledger = ledgers.get(emission);
  if (ledger === undefined) {
    ledger = { origin: 0, epoch: 0, counts: new Map(), consumed: new Set() };
    ledgers.set(emission, ledger);
  }
  return ledger;
}

function epochOf(track: string): number | undefined {
  if (track === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(track);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "number") return undefined;
  return parsed[0];
}

/**
 * The open tick's epoch. Children already stamped at `origin` keep theirs
 * (a resume). Otherwise it is one past every earlier child, so a tick that
 * mints nothing does not reuse the previous tick's paths.
 */
export function crossingEpoch(job: ProgrammaticJob, origin: number): number {
  for (const child of job.toolCalls.slice(origin)) {
    const epoch = epochOf(child.track);
    if (epoch !== undefined) return epoch;
  }
  let max = -1;
  for (const child of job.toolCalls.slice(0, origin)) {
    const epoch = epochOf(child.track);
    if (epoch !== undefined && epoch > max) max = epoch;
  }
  return max + 1;
}

/** How far this epoch's children extend. The next tick starts there. */
export function crossingOriginAfter(job: ProgrammaticJob, origin: number, epoch: number): number {
  let next = origin;
  for (const child of job.toolCalls.slice(origin)) {
    if (epochOf(child.track) !== epoch) break;
    next += 1;
  }
  return next;
}

/** `reset` drops counts from a previous tick. A source body continues the load that opened the ledger. */
export function armCrossings(emission: object, origin: number, epoch: number, reset: boolean): void {
  const ledger = ledgerOf(emission);
  ledger.origin = origin;
  ledger.epoch = epoch;
  if (!reset) return;
  ledger.counts.clear();
  ledger.consumed.clear();
}

export function crossingWindow(ctx: {
  readonly closureCall?: { readonly coordinate: { readonly ordinalPath: readonly number[] } };
  readonly runCtx: {
    readonly ambient: { readonly closureCall?: { readonly coordinate: { readonly ordinalPath: readonly number[] } } };
  };
}): readonly number[] {
  return ctx.closureCall?.coordinate.ordinalPath ?? ctx.runCtx.ambient.closureCall?.coordinate.ordinalPath ?? [];
}

/** `[origin, …window, n]`. `n` is how many crossings this window has already started. */
export function claimCrossing(emission: object, window: readonly number[]): string {
  const ledger = ledgerOf(emission);
  const key = `${ledger.epoch}:${window.join(".")}`;
  const n = ledger.counts.get(key) ?? 0;
  ledger.counts.set(key, n + 1);
  return JSON.stringify([ledger.epoch, ...window, n]);
}

export function takeCrossing(job: ProgrammaticJob, emission: object, path: string): ToolCallJob | undefined {
  const ledger = ledgerOf(emission);
  for (const child of job.toolCalls.slice(ledger.origin)) {
    if (ledger.consumed.has(child) || child.track !== path) continue;
    ledger.consumed.add(child);
    return child;
  }
  return undefined;
}

export function crossingPending(job: ProgrammaticJob, emission: object, path: string): boolean {
  const ledger = ledgerOf(emission);
  return job.toolCalls.slice(ledger.origin).some((child) => child.track === path && !ledger.consumed.has(child));
}
