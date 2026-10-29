// args-failure-tracker — escalation state for the localized args-misuse door. A deliberate
// SIBLING of `FutilityTracker` (futility.ts) — same injection pattern, same export/import
// discipline for session round-trips — but the INVERSE gradient: futility's `seen` set is
// monotonic verbose-once-then-terse (repetition earns LESS teaching); this tracker's counter
// is monotonic terse-then-verbose (repetition earns MORE teaching, up to the L3 anti-guess
// script). Mixing the two state machines would corrupt both contracts, hence a separate file
// (design doc §2.4's "NOT in DoorSession" decision) rather than a shared class.
//
// NOT unified with FutilityTracker (design doc's "Known limits", deliberately deferred):
// futility watches SUCCESSFUL non-progress, this watches FAILURES — different reset triggers.

/** Serialized tracker state — session-store round-trip shape (mirrors `FutilityTracker`'s own
 *  `exportState`/`importState` precedent, additive `argsFailures` key on the SessionBlob). */
export interface ArgsFailureState {
  /** `[key, count]` pairs — `key` per {@link trackerKey}. */
  entries: ReadonlyArray<readonly [string, number]>;
}

/** Composite key for one (tool, param) counter: `${qualifiedName}\0${paramPathJoined}`, with
 *  `"⊥"` standing in for an UNLOCALIZED misuse — the ⊥ key escalates too: Level ⊥'s eventual
 *  "show everything" backstop needs its own counter, same monotone rule as a named param.
 *  A multi-segment path joins on `.` — the same dotted-path convention the
 *  own-decode humanizer's per-issue lines use (design doc §2.5). The NUL separator can appear
 *  in neither half (MCP tool names are `^[a-zA-Z0-9_-]+$` on the wire; a JSON string never
 *  carries a raw NUL), so `recordSuccess`'s prefix-clear cannot cross tools — a space or any
 *  printable separator would rest on the weaker assumption that no server slug or property
 *  name ever contains it. */
function trackerKey(qualifiedName: string, paramPath: readonly string[] | undefined): string {
  const paramPathJoined = paramPath && paramPath.length > 0 ? paramPath.join(".") : "⊥";
  return `${qualifiedName}\0${paramPathJoined}`;
}

/** The escalation level a rendered door shows — capped at 3 (design doc §2.3 Levels 1-3; a
 *  4th-and-later consecutive failure keeps rendering the L3 anti-guess script, never a L4). */
export type ArgsFailureLevel = 1 | 2 | 3;

const MAX_LEVEL: ArgsFailureLevel = 3;

/** Per-(tool,param) consecutive-misuse-failure counters, capped at {@link MAX_LEVEL}. */
export class ArgsFailureTracker {
  private readonly byToolParam = new Map<string, number>();

  /** Record one misuse failure for `(qualifiedName, paramPath)`; returns the level to render.
   *  Monotone 1→2→3, then holds at 3 (never a hash-dedup gate, unlike futility's
   *  `firedFutileHash`) — identical repeated retries count too: escalation exists precisely
   *  for the near-identical-retry case. `paramPath` absent ⇒ the `⊥` key. */
  recordFailure(qualifiedName: string, paramPath: readonly string[] | undefined): ArgsFailureLevel {
    const key = trackerKey(qualifiedName, paramPath);
    const level = Math.min((this.byToolParam.get(key) ?? 0) + 1, MAX_LEVEL) as ArgsFailureLevel;
    this.byToolParam.set(key, level);
    return level;
  }

  /** A SUCCESSFUL call of `qualifiedName` clears every one of ITS param counters (including its
   *  `⊥` counter) — the model has a working shape now; the next failure on this tool starts a
   *  fresh L1 lesson. Never touches a DIFFERENT tool's counters: the prefix match ends at the
   *  NUL separator, which no qualified name can contain (see {@link trackerKey}). */
  recordSuccess(qualifiedName: string): void {
    const prefix = `${qualifiedName}\0`;
    for (const key of this.byToolParam.keys()) {
      if (key.startsWith(prefix)) this.byToolParam.delete(key);
    }
  }

  /** Serialize every counter — session-store round-trip primitive (session-store.ts / the
   *  SessionBlob's additive `argsFailures` key, design doc §2.4). */
  exportState(): ArgsFailureState {
    return { entries: [...this.byToolParam.entries()] };
  }

  /** Replace the tracker's state WHOLESALE (a full rehydration, never a merge) — mirrors
   *  `DoorSession.importState`'s identical contract in doors.ts. An absent/empty `entries`
   *  (an old SessionBlob predating this key) restores an empty tracker, never an error — the
   *  additive-key tolerance design doc §2.4 requires. A counter that is not a valid
   *  {@link ArgsFailureLevel} (a tampered/corrupt blob: `0`, `-5`, `99`, `NaN`, `2.5`) is
   *  DISCARDED, not clamped — a discarded entry restores to "no history", a fresh L1 lesson,
   *  whereas clamping would fabricate an escalation level no failure ever earned. */
  importState(state: ArgsFailureState): void {
    this.byToolParam.clear();
    for (const [key, count] of state.entries) {
      if (Number.isInteger(count) && count >= 1 && count <= MAX_LEVEL) this.byToolParam.set(key, count);
    }
  }
}
