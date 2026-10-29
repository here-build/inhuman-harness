// context-ring — recent successful top-level `(define …)` for type-hint context.
//
// Tool-valued defines (those referencing `/`-qualified tool symbols) are stored as
// `declare const name: unknown` at insertion so bad tool types cannot poison diagnostics.
//
// The ring is size-bounded to keep re-lowering cheap.

import type { ContextRing } from "./types.js";

/** {@link ContextRing}'s frozen contract (types.ts) has no export/restore seam — implementers
 *  change that file only by amending the design doc first. This is a STRUCTURAL superset (extra
 *  methods `ContextRing`'s own consumers never call), not a modification of the frozen shape:
 *  every existing `ContextRing`-typed consumer keeps working unchanged. `exportEntries` returns
 *  the ALREADY-DEGRADED (name, storedEntry) pairs verbatim — a tool-valued define's
 *  `declare const x: unknown` stand-in, not the original source — so `restoreEntries` never
 *  re-runs the tool-symbol detection (the session-export primitive, session-store.ts). */
export interface SerializableContextRing extends ContextRing {
  exportEntries(): readonly (readonly [string, string])[];
  restoreEntries(entries: Iterable<readonly [string, string]>): void;
}

/** ~8k-char total cap (G13.3). "~8k" — the eviction target; entries() stays at/under it. */
const MAX_TOTAL_CHARS = 8000;

/** Detects `/`-qualified tool symbols for tool-valued define degradation.
 *
 *  Over-degrading (treating a define that merely contains a tool-shaped literal as tool-valued)
 *  is safe — it produces no hint rather than a wrong one.
 *
 *  Limitation for slugless single-server bindings is closed when `knownToolNames` is supplied. */
const TOOL_SYMBOL = /[A-Z][\w.-]*\/[\w.-]+/i;

/** Token-boundary chars for {@link knownToolPattern} — byte-identical to session-history.ts's
 *  own copy (duplicated, not imported, matching this pair's existing `TOOL_SYMBOL` convention):
 *  the actual Scheme-reader token separators, so a roster name matches only as its OWN symbol,
 *  never as a substring of an unrelated longer identifier (`click` inside
 *  `double-click-handler`). */
const BEFORE = String.raw`(?:^|[\s()\[\]{}'\`,])`;
const AFTER = String.raw`(?:$|[\s()\[\]{}])`;

/** The ROSTER-BASED half of tool-valued detection (see `TOOL_SYMBOL`'s blind-spot doc above):
 *  a token-boundary-aware regex matching any of `names` as a whole symbol, or `undefined` when
 *  `names` is empty (no roster supplied — the caller falls back to `TOOL_SYMBOL` alone).
 *  Escapes each name defensively:
 *  a real bound tool's qualified name is wire-constrained to `^[a-zA-Z0-9_-]+$` (bind.ts) and
 *  so never actually needs it, but nothing here can enforce that on a misbehaving upstream
 *  server — a regex-metacharacter name should degrade to "doesn't match", never a malformed
 *  pattern or a thrown `SyntaxError`. */
function knownToolPattern(names: Iterable<string>): RegExp | undefined {
  const escaped = [...new Set(names)]
    .filter((n) => n.length > 0)
    .map((n) => n.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
  return escaped.length > 0 ? new RegExp(`${BEFORE}(?:${escaped.join("|")})${AFTER}`) : undefined;
}

/** `knownToolNames` — the REAL bound-tool roster (manifold-tool.ts's `toolSchemas.keys()`),
 *  when the caller has one — closes `TOOL_SYMBOL`'s slugless-binding blind spot (see its doc
 *  above) without weakening the existing shape heuristic (both checks OR together). Optional and
 *  defaulted to empty so every existing direct caller (this package's own unit tests, which
 *  construct a ring with no env/roster at all) keeps working unchanged. Note this is a
 *  constructor-only parameter — {@link ContextRing}'s `push`/`entries` contract (the part
 *  documented as frozen) is untouched. */
export function createContextRing(knownToolNames: Iterable<string> = []): SerializableContextRing {
  // Insertion-ordered store; rebind moves the name to newest (delete-then-set).
  const store = new Map<string, string>();
  const knownPattern = knownToolPattern(knownToolNames);

  const totalChars = (): number => {
    let sum = 0;
    for (const entry of store.values()) sum += entry.length;
    return sum;
  };

  return {
    push(name, source) {
      const isToolValued = TOOL_SYMBOL.test(source) || (knownPattern?.test(source) ?? false);
      const entry = isToolValued ? `declare const ${name}: unknown` : source;
      if (store.has(name)) store.delete(name); // rebind → last-wins, refreshed to newest
      store.set(name, entry);
      // FIFO eviction: drop the oldest until under the cap; never evict the just-pushed newest.
      while (totalChars() > MAX_TOTAL_CHARS && store.size > 1) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    entries() {
      return [...store.values()];
    },
    exportEntries() {
      return [...store.entries()];
    },
    restoreEntries(entries) {
      store.clear();
      for (const [name, entry] of entries) store.set(name, entry);
    },
  };
}
