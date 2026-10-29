// futility — detects repeated non-progress tool calls and queues advisory notes.
//
// Watches per-qualified-tool a small ring of (argsHash, normalized-resultHash). When the same
// (or shape-identical) result comes back repeatedly, a "futile retry" or "duplicate call" door
// is queued.
//
// The actual tool result always flows through untouched; the note is appended afterwards by
// the caller.

import { duplicateCallDoor, type Door, futileRetryDoor } from "./doors.js";

/** Ring-buffer depth per tool. ~6 is enough to see the "last 3 identical" window plus a couple of
 *  distinct-result calls before/after, and keeps per-session memory trivially bounded. */
const RING_SIZE = 6;

/** Canonical-UUID and long-hex/hash runs: stripped WHOLE (a request id, session token, git sha,
 *  md5) so two otherwise-identical bodies differing only by such a token hash the same. Length ≥12
 *  keeps it clear of English words (a 12-letter all-hex word is essentially impossible). */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX_RUN = /[0-9a-f]{12,}/g;
const WHITESPACE = /\s+/g;

/** Normalize a result's rawest text to a shape-only key: lowercase, strip UUIDs / long hex runs
 *  (so request ids / session tokens / git shas wash out), collapse whitespace. Two results that
 *  differ only in such volatile tokens normalize identically — the point: detect a tool that is
 *  returning the SAME SHAPE of answer regardless of input.
 *
 *  DELIBERATELY does NOT strip digit runs (C1,
 *  experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §C).
 *  Digits are frequently the PAYLOAD, not a volatile token: file sizes, counts, ids, prices.
 *  `get_file_info`'s pure labels+digits body (no path echo) normalized three genuinely different
 *  files to the same shape key under the old digit-stripping rule, firing the futility door on
 *  legitimately distinct results. Audited across 178 trajectories: digit-stripping never enabled
 *  a single TRUE positive (every real one was byte-identical prose with no digits at all —
 *  bot-detection pages, "No objects found", empty memory) — it only manufactured false ones. */
export function normalizeResultText(raw: string): string {
  return raw.toLowerCase().replaceAll(UUID, "").replaceAll(HEX_RUN, "").replaceAll(WHITESPACE, " ").trim();
}

/** FNV-1a over a string → a compact base-36 tag. Only equality matters here (no crypto), so a fast
 *  32-bit hash keeps ring entries tiny while collisions are astronomically unlikely to matter for
 *  a per-session window of a handful of calls. */
function hashString(s: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i++) {
    // Pre-existing FNV-1a body, a pure relocation from arrival-manifold/src/futility.ts. FNV-1a
    // is defined over UTF-16 code units here (not code points), and codePointAt would silently
    // change the hash for astral-plane input — only equality matters (see this function's doc
    // comment), never a specific value.
    // eslint-disable-next-line unicorn/prefer-code-point
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(36);
}

/** Stable JSON of the call args (sorted keys) so `{a,b}` and `{b,a}` hash the same. The membrane
 *  builds args by iterating the tool's fixed param order, so this is already deterministic per
 *  tool; the sort is belt-and-braces. A value that will not stringify falls back to String(). */
function argsKey(args: Record<string, unknown>): string {
  try {
    // Pre-existing key-sort, a pure relocation from arrival-manifold/src/futility.ts. The
    // contract is only "the same arg set always sorts the same way" (a stable hash key), not a
    // specific locale-aware ordering, and `sort()`'s in-place mutation is discarded immediately
    // (a fresh array from `Object.keys`) — swapping to `toSorted`/`localeCompare` risks a
    // hash-value drift for non-ASCII property names with no behavioral upside.

    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(args);
  }
}

/** The rawest text form of an upstream result. bind.ts sees the value AFTER unwrapToolResult, so a
 *  bare string stays as-is (the most common degraded-body shape) and everything else is
 *  JSON.stringify'd; an unstringifiable/undefined value falls back to String(). */
function resultText(rawResult: unknown): string {
  if (typeof rawResult === "string") return rawResult;
  try {
    return JSON.stringify(rawResult) ?? String(rawResult);
  } catch {
    return String(rawResult);
  }
}

export interface RingEntry {
  argsHash: string;
  resultHash: string;
  /** The `beginCall()` generation this entry was recorded under (C1b,
   *  experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §C/ADDENDUM
   *  — trigger surgery). Statements within ONE program are written by the model
   *  WITHOUT having seen any of their sibling results yet, so repeated/identical results among
   *  them are not an INFORMED retry — the door's whole premise. Both triggers below require the
   *  entries they fire on to span at least 2 DISTINCT call ids, exactly mirroring the existing
   *  `distinctArgs >= 2` requirement one level up. */
  callId: number;
}

export interface ToolState {
  ring: RingEntry[];
  /** The result hash of the previous record — a change RESETS the re-fire gate (a tool that
   *  recovered, then degrades again, may fire once more). */
  lastResultHash?: string;
  /** The result hash each trigger last fired on, so an unchanged run does not re-fire (no door
   *  spam on the 4th/5th identical call — the terse repeat rides DoorSession's verbosity gate). */
  firedFutileHash?: string;
  firedDuplicateHash?: string;
}

/** {@link FutilityTracker.exportState}'s plain-data shape — every tool's ring state, keyed by
 *  qualified tool name. Pending (not-yet-drained) doors are deliberately NOT included: they are
 *  per-call, in-flight advisory notes, not session-lived teaching state (matching the "drain
 *  before the call returns" contract every real caller already honors). */
export type FutilityState = readonly (readonly [string, ToolState])[];

/** A door queued for the current manifold call, tagged with the tool it concerns (for renderNote's
 *  telemetry line). */
export interface PendingDoor {
  tool: string;
  door: Door;
}

/** Per-process tracker. Injected into both the binding membrane (recording site) and the
 * runner (drain site) so state survives world rebuilds. */
export class FutilityTracker {
  private readonly byTool = new Map<string, ToolState>();
  private readonly pending: PendingDoor[] = [];
  /** Current `beginCall()` generation — see {@link RingEntry.callId}'s doc. Starts at 0 so a
   *  caller that never calls `beginCall()` (every pre-C1b direct `record()` caller, e.g. this
   *  file's own older tests) gets every entry tagged with the SAME id, which is exactly the
   *  "same program" shape — a deliberate, not accidental, default: batching entries without an
   *  explicit call boundary must never silently regain the old (unsafe) cross-entry firing. */
  private callId = 0;

  /** `ringSize` — injected constructor option, never a code fork. Defaults to {@link RING_SIZE}. */
  constructor(private readonly ringSize: number = RING_SIZE) {}

  /** Mark the start of a new program/call (runner.ts calls this once per `run()`, mirroring
   *  `AttachmentSink.beginCall`). Every `record()` until the next `beginCall()` shares this id —
   *  the boundary C1b's triggers key off to tell "several statements in one program" apart from
   *  "several separate, model-observed retries". */
  beginCall(): void {
    this.callId += 1;
  }

  /** Record one successful upstream call. Called at the membrane AFTER the result is in hand and
   *  BEFORE it is returned — recording never modifies or delays the value. Evaluates the two
   *  triggers and queues at most one door for this record (futility subsumes a bare duplicate). */
  record(qualifiedName: string, args: Record<string, unknown>, rawResult: unknown): void {
    const resultHash = hashString(normalizeResultText(resultText(rawResult)));
    const argsHash = hashString(argsKey(args));
    const state = this.byTool.get(qualifiedName) ?? { ring: [] };
    this.byTool.set(qualifiedName, state);

    // The buffer's contents changed to a different result → clear the re-fire gate.
    if (state.lastResultHash !== undefined && state.lastResultHash !== resultHash) {
      state.firedFutileHash = undefined;
      state.firedDuplicateHash = undefined;
    }
    state.lastResultHash = resultHash;

    state.ring.push({ argsHash, resultHash, callId: this.callId });
    if (state.ring.length > this.ringSize) state.ring.shift();

    const n = state.ring.length;

    // TRIGGER 1 — degraded tool: the last 3 results are hash-identical while ≥2 DISTINCT argsHashes
    // AND ≥2 DISTINCT callIds appear among them (the tool is insensitive to input ACROSS genuinely
    // separate, model-observed attempts — never merely several statements one program wrote blind
    // to each other's outcome; C1b). Fires at most once per identical run.
    if (n >= 3) {
      const last3 = state.ring.slice(-3);
      const sameResult = last3.every((e) => e.resultHash === resultHash);
      const distinctArgs = new Set(last3.map((e) => e.argsHash)).size;
      const distinctCalls = new Set(last3.map((e) => e.callId)).size;
      if (sameResult && distinctArgs >= 2 && distinctCalls >= 2 && state.firedFutileHash !== resultHash) {
        state.firedFutileHash = resultHash;
        this.pending.push({ tool: qualifiedName, door: futileRetryDoor(qualifiedName) });
        return; // one door per record — the stronger degraded-tool signal wins over a bare repeat
      }
    }

    // TRIGGER 2 — pure repeat: the last 2 calls share BOTH argsHash and resultHash, AND belong to
    // DIFFERENT calls (C1b — two statements in one program sharing args+result is not a repeat the
    // model chose to make; it never saw the first one's result before writing the second). Fires
    // at most once per identical run (needs only 1 distinct argsHash, so a constant tool hit with
    // the SAME args fires THIS but never trigger 1).
    if (n >= 2) {
      const [a, b] = state.ring.slice(-2);
      if (
        a!.argsHash === b!.argsHash &&
        a!.resultHash === b!.resultHash &&
        a!.callId !== b!.callId &&
        state.firedDuplicateHash !== resultHash
      ) {
        state.firedDuplicateHash = resultHash;
        this.pending.push({ tool: qualifiedName, door: duplicateCallDoor(qualifiedName) });
      }
    }
  }

  /** Drain the doors queued since the last drain (one manifold call's worth). Empties the queue. */
  drainPending(): PendingDoor[] {
    return this.pending.splice(0);
  }

  /** Serialize every tool's ring state — session-export primitive (session-store.ts). Pending
   *  (undrained) doors are deliberately excluded — see {@link FutilityState}'s doc. */
  exportState(): FutilityState {
    return [...this.byTool.entries()].map(([name, state]) => [name, { ...state, ring: [...state.ring] }]);
  }

  /** Replace the tracker's per-tool ring state wholesale (session restore) — a full rehydration,
   *  never a merge. Pending doors are untouched (there is nothing to restore for them). */
  importState(state: FutilityState): void {
    this.byTool.clear();
    for (const [name, toolState] of state) this.byTool.set(name, { ...toolState, ring: [...toolState.ring] });
  }
}
