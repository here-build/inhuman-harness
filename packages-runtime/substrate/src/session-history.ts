// session-history — replayable record of successful top-level `(define ...)` statements.
//
// The persistent (ambient, scope) pair provides cross-call persistence for a single world. This
// module exists for resumability: a history of source text can be replayed against a fresh
// world's (ambient, scope) pair (new process, resumed session, etc.).
//
// Sibling to the type-hints context ring. They observe the same events but project different
// data (original source here vs. degraded `declare const ...` there).

export interface SessionHistoryEntry {
  /** The bound variable/function name (topLevelDefineName's extraction). */
  readonly name: string;
  /** The exact top-level `(define ...)` statement source, verbatim. */
  readonly source: string;
}

export interface SessionHistory {
  /** Record a top-level define whose own evaluation SUCCEEDED. Only call this for a
   *  statement that actually ran without error. Rebinding an existing name replaces its
   *  entry (last-wins) and moves it to the newest position — replay reproduces the
   *  session's FINAL binding for that name, not every historical rebind. */
  push(name: string, source: string): void;
  /** Entries in insertion (application) order. */
  entries(): readonly SessionHistoryEntry[];
  /** Replace the store wholesale with `entries`, verbatim (session restore). */
  restoreEntries(entries: readonly SessionHistoryEntry[]): void;
}

export function createSessionHistory(): SessionHistory {
  // Insertion-ordered store; rebind moves the name to newest (delete-then-set) — same
  // last-wins rule as context-ring.ts, independently implemented (see file header).
  const store = new Map<string, SessionHistoryEntry>();
  return {
    push(name, source) {
      if (store.has(name)) store.delete(name);
      store.set(name, { name, source });
    },
    entries() {
      return [...store.values()];
    },
    restoreEntries(entries) {
      store.clear();
      for (const entry of entries) store.set(entry.name, entry);
    },
  };
}

// ─── LocalBindingTracker — per-session LOCAL (non-top-level) binding occurrences ───
// SCOPE-CONFUSION DOOR (doors.ts's
// `scopeConfusionDoor`): a SIBLING store to `SessionHistory` above, tracking a DIFFERENT event —
// not a successful top-level `(define X ...)` (this file's main export), but every symbol bound
// in a NON-top-level lexical scope (a let/let*/letrec/letrec* binding, a lambda parameter, or a
// nested `(define X ...)`) that appeared in ANY submitted program's SOURCE this session,
// regardless of whether that statement itself succeeded — the SYNTAX is the signal ("you've used
// this name locally before"), not the runtime outcome (scope-scan.ts's `scanLocalBindings` is the
// v1 tokenizer-based scan manifold-tool.ts feeds this from every call's raw source). Recorded per
// CALL INDEX (manifold-tool.ts's per-tool call counter) so the door can report "N message(s) ago"
// and detect a REPEATED local-binding STYLE (≥2 occurrences) without forcing the model toward a
// global `(define)` (the spec's "don't force an implementation" special case).
export interface LocalBindingTracker {
  /** Record every locally-bound name this call's submitted program contained, tagged with
   *  `callIndex`. A name already recorded at THIS exact call index is not duplicated — multiple
   *  mentions within one call count as ONE occurrence (the spec's "N prior CALLS", not "N
   *  mentions"). */
  record(names: Iterable<string>, callIndex: number): void;
  /** Every call index (this session, oldest → newest) at which `name` was locally bound, or `[]`
   *  when it never was. */
  occurrences(name: string): readonly number[];
  /** Serialize the store wholesale — session-export primitive (session-store.ts). */
  exportState(): LocalBindingState;
  /** Replace the store wholesale (session restore) — a full rehydration, never a merge. */
  importState(state: LocalBindingState): void;
}

/** {@link LocalBindingTracker.exportState}'s plain-data shape: name → its recorded call
 *  indexes, oldest→newest. */
export type LocalBindingState = readonly (readonly [string, readonly number[]])[];

export function createLocalBindingTracker(): LocalBindingTracker {
  const store = new Map<string, number[]>();
  return {
    record(names, callIndex) {
      for (const name of names) {
        const list = store.get(name);
        if (list === undefined) store.set(name, [callIndex]);
        else if (list.at(-1) !== callIndex) list.push(callIndex);
      }
    },
    occurrences(name) {
      return store.get(name) ?? [];
    },
    exportState() {
      return [...store.entries()].map(([name, indexes]) => [name, [...indexes]]);
    },
    importState(state) {
      store.clear();
      for (const [name, indexes] of state) store.set(name, [...indexes]);
    },
  };
}
