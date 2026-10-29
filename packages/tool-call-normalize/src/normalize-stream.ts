import { argsEqual } from "./dedup.js";
import { ensureBuiltins, getDialect, listDialects } from "./dialects/registry.js";
import { maskArgValueInteriors } from "./dialects/step-common.js";
import { mintId } from "./ids.js";
import { streamFinishReason } from "./ir.js";
import { normalizeMessageImpl } from "./normalize-message.js";
import { createMarkerScanner } from "./scan.js";
import { createChannelState, feedChannels, flushChannelHold, peekFenceClose } from "./stream-channels.js";
import {
  type Dialect,
  type NormalizeEvent,
  type NormalizeOptions,
  type OpenAiChatChunk,
  type RawSpan,
  type ToolCall,
  NormalizeError,
} from "./types.js";

/**
 * Resolve dialect for live step() SM.
 * Forced dialect only — soft modelHint must NOT lock step to one dialect
 * while hold is a multi-dialect union (audit-014 H2). Soft hint still
 * affects EOS/probe extract via normalizeMessage soft-fallback.
 */
function resolveStepDialect(opts: NormalizeOptions): Dialect | null {
  ensureBuiltins();
  if (opts.dialect && opts.dialect !== "auto") {
    return getDialect(opts.dialect) ?? null;
  }
  return null;
}

function dialectOpenMarkers(id: string | undefined): string[] | null {
  if (!id) return null;
  const d = getDialect(id);
  if (!d) return null;
  if (d.openMarkers?.length) return d.openMarkers;
  if (d.markers?.length) return d.markers;
  return null;
}

function dialectCloseMarkers(id: string | undefined): string[] | null {
  if (!id) return null;
  const d = getDialect(id);
  return d?.closeMarkers?.length ? d.closeMarkers : null;
}

/**
 * Open markers for hold (audit-014 H2 / L2).
 * - Forced dialect → that dialect only.
 * - Else → **union of all allowStreamAuto** dialects (hint does NOT narrow hold).
 * Hint still biases extract/step via resolveStepDialect; hold must not paint.
 */
function toolOpenMarkers(opts: NormalizeOptions): string[] {
  ensureBuiltins();
  if (opts.dialect && opts.dialect !== "auto") {
    return dialectOpenMarkers(opts.dialect) ?? ["<tool_call>"];
  }
  return streamAutoOpenUnion();
}

function toolCloseMarkers(opts: NormalizeOptions): string[] {
  ensureBuiltins();
  if (opts.dialect && opts.dialect !== "auto") {
    return (
      dialectCloseMarkers(opts.dialect) ?? [
        "</tool_call>",
        "</longcat_tool_call>",
        "</longcattoolcall>",
        "</longcat-tool-call>",
      ]
    );
  }
  return streamAutoCloseUnion();
}

function streamAutoOpenUnion(): string[] {
  const union = new Set<string>();
  for (const d of listDialects()) {
    if (!d.allowStreamAuto) continue;
    for (const m of d.openMarkers?.length ? d.openMarkers : d.markers) {
      union.add(m);
    }
  }
  if (union.size === 0) {
    for (const id of ["longcat", "qwen_xml", "hermes"] as const) {
      for (const m of dialectOpenMarkers(id) ?? []) union.add(m);
    }
  }
  return [...union];
}

function streamAutoCloseUnion(): string[] {
  const union = new Set<string>();
  for (const d of listDialects()) {
    if (!d.allowStreamAuto) continue;
    for (const m of d.closeMarkers ?? []) union.add(m);
  }
  if (union.size === 0) {
    for (const id of ["longcat", "qwen_xml", "hermes"] as const) {
      for (const m of dialectCloseMarkers(id) ?? []) union.add(m);
    }
  }
  return [...union];
}

/**
 * End offset of first complete tool block in `slice`, or -1 if none.
 * Pairs close family with the open prefix of `slice` when possible (qwen wrap).
 */
function firstClosedToolEnd(slice: string, closeMarkers?: string[]): number {
  const allCloses = closeMarkers?.length
    ? closeMarkers
    : ["</tool_call>", "</longcat_tool_call>", "</longcattoolcall>", "</longcat-tool-call>", "</function>"];
  // Detect open family from hold prefix
  const lowerStart = slice.slice(0, 48).toLowerCase();
  let closes = allCloses;
  if (lowerStart.startsWith("<tool_call")) {
    closes = allCloses.filter((c) => c.toLowerCase().includes("tool_call"));
  } else if (lowerStart.startsWith("<function")) {
    closes = allCloses.filter((c) => c.toLowerCase().includes("function"));
  } else if (lowerStart.includes("longcat")) {
    closes = allCloses.filter((c) => c.toLowerCase().includes("longcat"));
  }
  if (closes.length === 0) closes = allCloses;
  let best = -1;
  // Skip close markers inside arg_value / parameter (audit-014 structure-blind)
  const lower = maskArgValueInteriors(slice).toLowerCase();
  for (const c of closes) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) {
      const end = i + c.length;
      if (best < 0 || end < best) best = end;
    }
  }
  return best;
}

/**
 * Stream session: feed chunks, then close for EOS meta/finish.
 * Used by collectStreamSync (batch assemble path) and live ingest/close consumers.
 */
export function createStreamSession(opts: NormalizeOptions = {}): {
  ingest: (chunk: string | OpenAiChatChunk) => Generator<NormalizeEvent, void, unknown>;
  close: () => Generator<NormalizeEvent, void, unknown>;
} {
  NormalizeError.invariant(
    (opts.nativePolicy ?? "merge") !== "rescan",
    "rescan_not_streamable",
    "nativePolicy rescan is batch-only; use merge or skip on createStreamSession",
  );

  const mode = opts.mode ?? "repair";
  // Hoist strict_without_tools so live probe cannot run without a catalog
  NormalizeError.invariant(mode !== "strict" || opts.tools, "strict_without_tools", "mode strict requires tools[]");

  const nativePolicy = opts.nativePolicy ?? "merge";
  const idStyle = opts.idStyle ?? "stable";
  const markers = toolOpenMarkers(opts);
  const closeMarkers = toolCloseMarkers(opts);
  const maxBuf = opts.maxBufferChars ?? 256_000;
  /** Single resolved dialect with step() — forced dialect or modelHint. */
  const stepDialect = resolveStepDialect(opts);
  const useStep = !!(stepDialect?.step && stepDialect.createStreamState);
  let stepState: unknown = useStep ? stepDialect!.createStreamState!() : null;
  /**
   * Live start already emitted via step (name-certain before close).
   * On close we emit args_delta + end with the same id/index.
   * Object bag: nested generators confuse TS narrowing on a bare `let`.
   */
  const liveStep = {
    call: null as null | { index: number; id: string; name: string },
  };

  // pass: no content tool scan — stream text as-is (still strip think for channel)
  // detect: same live path as repair for deltas, but assemble won't rewrite tools
  //   (we still recover tools in assemble for meta; detect mode batch leaves tool_calls alone)
  // For stream simplicity: pass ⇒ skip content tool hold entirely.

  /** Full original content for EOS assemble (think tags + tool markup). */
  let recoveryText = "";
  let hold = "";
  /**
   * Explicit mode-switching FST (T3) — the same shape as a VT/ANSI escape
   * parser or the HTML5 tokenizer: `ground` paints text, `maybe_open` is a
   * BET that a bounded speculative suffix is growing into a tool-open
   * marker, `inside` is a confirmed open marker capturing its body until a
   * close (or an abort back to ground). Every transition lives at the site
   * that drives it (a scanner match, a dialect step, or an abort); nothing
   * re-derives the mode by re-inspecting `hold`.
   *
   * No fourth `maybe_close` state: unlike the open boundary, there is no
   * bounded-lookahead decision at the close boundary — `inside` must retain
   * its ENTIRE captured span (dialects need the full body to parse/mask
   * argument values), so "waiting for a close" is not a distinct persisted
   * state, just `inside` continuing to accumulate. It is bounded only by
   * the capture-phase guard (`maxBuf`, T4), never by a paint-safe suffix.
   */
  type ToolHoldMode = "ground" | "maybe_open" | "inside";
  // Named `holdMode` (not `mode`) — `mode` is already the caller's
  // repair/strict/detect/pass normalize mode declared above; this is a
  // completely separate axis (the tool-hold FST's own state tag).
  let holdMode: ToolHoldMode = "ground";
  /**
   * Ground/maybe_open lookahead (T4): T1's Aho-Corasick scanner answers
   * "did a marker just complete" and "how much of the tail must still be
   * held" from ONE automaton pass — no separate suffix-scan loop, and a
   * marker split across any chunk boundary still matches because the
   * automaton state carries the partial match forward between `feed()`
   * calls. `feed()` is called with each new piece exactly once (never
   * re-fed), so its match/holdLength always reflect exactly `hold + this
   * piece` without rescanning bytes already scanned in a prior absorb()
   * call (T3: no rescan, no second pass, state carries the context).
   * Reset exactly when `holdMode` returns to "ground" (hold drained to
   * ""), which re-bases the scanner's own coordinate system to align with
   * the fresh span starting there.
   */
  const openScanner = createMarkerScanner(markers);
  /**
   * `openScanner`'s own offsets (`match.start`/`match.end`) are absolute
   * since its last `reset()` — i.e. relative to the START of the current
   * ground span, not to the current `hold`. Every safe-painted prefix
   * shrinks `hold` without shrinking the scanner's cumulative count (the
   * automaton has no notion of forgetting a prefix), so the two coordinate
   * systems diverge by exactly the amount painted away so far. This tracks
   * that divergence; `scan.match.start - scannerPaintedLen` converts a
   * scanner offset back to a `hold`-relative (combined-relative) one.
   * Reset to 0 in lockstep with `openScanner.reset()`.
   */
  let scannerPaintedLen = 0;
  /**
   * Absolute offset (into the concatenated raw input text of the whole
   * stream) of index 0 of `hold`. Invariant: hold always holds the trailing
   * unresolved suffix of everything ingested so far, so this is updated
   * in lockstep with every `hold` mutation below (span ledger — task C1).
   */
  let holdAbsStart = 0;
  /** skip content tool-scan after first native name (skip policy latch). */
  let skipContentScan = false;
  const nativeTools: ToolCall[] = [];
  /** IR indices for natives that already have a committed name (for collision). */
  const nativeNameAtIndex = new Map<number, string>();
  let finishIn: string | null | undefined = opts.finishReasonIn;
  let reasoning = "";
  const channels = createChannelState(opts.thinkTags);

  /** First-committer registry: tools already emitted as IR this generation. */
  const committed: Array<{ name: string; arguments: string }> = [];
  let irIndex = 0;

  /**
   * R1: THE single resolver of a captured span's fate, and THE single
   * writer of `recoveryText`. THE LAW (C1): every character the model
   * produced lands in exactly one bucket — painted-as-text,
   * part-of-a-tool-call-span, or explicitly-dropped — never two, never
   * zero. Every terminal disposition of a held span (the maxBuf abort,
   * both the step()-driven close and the non-step firstClosedToolEnd
   * fallback, and the EOS orphan/lost-bet drains in close()) MUST route
   * through this function to reach `recoveryText` or to register a
   * "call" fate — nothing else in this file may touch `recoveryText`
   * directly.
   *
   * fate="call" is a hard law, enforced by the type overload itself: it
   * takes no `text`/`toRecovery` argument, because a call-fate span was
   * already independently emitted as IR (tool_call_start/args_delta/end
   * via emitToolIr) — feeding the same characters into `recoveryText`
   * would let the EOS assemble's structure-blind extract() rediscover and
   * re-execute them as a second call (the exact phantom-double-call this
   * function exists to make unexpressible, not merely absent).
   *
   * `committedSpans` backs a runtime assertion mirroring assertIrOrdering
   * (ir.ts): two committed spans that overlap — regardless of fate — is
   * the double-accounting the law forbids, and throws immediately instead
   * of being silently absorbed by the isCommitted() name+args dedup
   * downstream (a safety net, not a guarantee).
   */
  const committedSpans: Array<RawSpan & { fate: "text" | "call" | "dropped" }> = [];
  function commit(span: RawSpan, fate: "call"): void;
  function commit(span: RawSpan, fate: "text" | "dropped", text: string, toRecovery: boolean): void;
  function commit(span: RawSpan, fate: "text" | "call" | "dropped", text?: string, toRecovery?: boolean): void {
    if (span.start >= span.end) return; // zero-width: no characters, nothing to resolve.
    for (const prior of committedSpans) {
      NormalizeError.invariant(
        span.start >= prior.end || prior.start >= span.end,
        "double_commit",
        `span [${span.start},${span.end}) fate=${fate} overlaps already-` +
          `committed span [${prior.start},${prior.end}) fate=${prior.fate} — ` +
          `every character must resolve to exactly one fate (text, call, or ` +
          `dropped), never two`,
      );
    }
    committedSpans.push({ start: span.start, end: span.end, fate });
    if (fate === "call") return;
    if (toRecovery) recoveryText += text ?? "";
  }

  const isCommitted = (name: string, args: string): boolean =>
    committed.some((c) => c.name === name && argsEqual(c.arguments, args));

  /**
   * @param skipIfCommitted — true at EOS (dedup natives vs already-live content).
   *   false for recovered content spans so identical parallel recovered tools both emit
   *   (batch multiset parity; only native∩recovered collapses).
   * @param alreadyStarted — step already emitted start; only args+end (same id).
   */
  const emitToolIr = function* (
    tc: ToolCall,
    partial?: boolean,
    skipIfCommitted = true,
    alreadyStarted?: { index: number; id: string },
    /** Raw-input offsets of the span this call was recovered from (task C1). */
    span?: RawSpan,
  ): Generator<NormalizeEvent, void, unknown> {
    if (skipIfCommitted && isCommitted(tc.function.name, tc.function.arguments)) {
      return;
    }
    if (alreadyStarted) {
      // ONE MINT SITE (task I1): `alreadyStarted.id` is the provisional id
      // handed out at tool_call_start, before arguments existed — it is
      // NEVER the final id, on any idStyle. The final id is decided here,
      // exactly once, from the same (index, name, arguments, idStyle)
      // tuple normalizeMessage's batch mint uses (processRawCalls), so
      // stream and batch agree for idStyle "stable" (content-hash) without
      // the two paths needing to coordinate. `tc.id` (from the internal
      // probeSpan call) is discarded, not reused: probeSpan mints against
      // its own span-local index restarting at 0, which is only ever
      // correct by coincidence — `alreadyStarted.index` is the real,
      // stream-global position.
      //
      // Correlation across the lifecycle (start -> args_delta -> end) is
      // `index`, not `id` — `index` is assigned once at start and never
      // changes (assertIrOrdering enforces exactly one open/close per
      // index); `id` is allowed, by design, to differ between the
      // provisional value shown at `tool_call_start` and the final value
      // minted here. No consumer in this codebase keys off `id` to
      // correlate start with end: `assembleEvents` (ir.ts) reads `id` only
      // off `tool_call_end`; `tool_call_start`/`tool_call_args_delta`
      // ids are display-only.
      const finalId = mintId(alreadyStarted.index, tc.function.name, tc.function.arguments || "{}", idStyle, false);
      committed.push({
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
      yield {
        type: "tool_call_args_delta",
        index: alreadyStarted.index,
        id: finalId,
        argumentsDelta: tc.function.arguments,
      };
      yield {
        type: "tool_call_end",
        index: alreadyStarted.index,
        id: finalId,
        name: tc.function.name,
        arguments: tc.function.arguments,
        partial: partial ? true : undefined,
        span,
      };
      return;
    }
    const index = irIndex++;
    // Prefer provider/native id when present. Else mint from stream irIndex
    // (probe restarts mint at 0 per span — do not trust probe-only ids for recovered).
    const looksProbeMinted = !tc.id || /^call_[0-9a-f]{8,}$/i.test(tc.id); // stable hash from probe index 0
    const id = looksProbeMinted
      ? mintId(index, tc.function.name, tc.function.arguments || "{}", idStyle, false)
      : tc.id;
    committed.push({
      name: tc.function.name,
      arguments: tc.function.arguments,
    });
    yield {
      type: "tool_call_start",
      index,
      id,
      name: tc.function.name,
      span,
    };
    yield {
      type: "tool_call_args_delta",
      index,
      id,
      argumentsDelta: tc.function.arguments,
    };
    yield {
      type: "tool_call_end",
      index,
      id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      partial: partial ? true : undefined,
      span,
    };
  };

  /** Live probe uses the caller's real mode (strict must gate). */
  const probeSpan = (span: string) =>
    normalizeMessageImpl(
      { content: span, tool_calls: [] },
      {
        ...opts,
        mode,
        nativePolicy: "merge",
        finishReasonIn: null,
      },
    );

  /**
   * Prose/reasoning live emit via think+fence channels; also commits the
   * span to recoveryText (fate="text", always recovered — see `commit`).
   */
  const flushLive = function* (chunk: string, span: RawSpan): Generator<NormalizeEvent, void, unknown> {
    if (!chunk) return;
    commit(span, "text", chunk, true);
    const gen = feedChannels(channels, chunk);
    let step = gen.next();
    while (!step.done) {
      yield step.value;
      step = gen.next();
    }
  };

  /** Live text only (no recovery append) — reject-replay of suppressed spans. */
  const emitLiveOnly = function* (chunk: string): Generator<NormalizeEvent, void, unknown> {
    if (!chunk) return;
    const gen = feedChannels(channels, chunk);
    let step = gen.next();
    while (!step.done) {
      yield step.value;
      step = gen.next();
    }
  };

  /**
   * The "text" fate of the abort law (T2/T3): a held span is a BET that
   * resolves to exactly one fate, text or call, never both, never neither.
   * This is the shared abort-to-ground transition for the "text" fate —
   * commit `chunk` to user-visible content, in the position it actually
   * occurred, and advance the span cursor past it. Every non-ground state
   * that can lose its bet without ever reaching name-certainty (a
   * maybe_open speculative prefix invalidated by a fence, or an EOS
   * lost-bet) funnels through here rather than inlining flushLive +
   * holdAbsStart bookkeeping at each call site.
   */
  const commitToText = function* (chunk: string): Generator<NormalizeEvent, void, unknown> {
    if (!chunk) return;
    const span: RawSpan = { start: holdAbsStart, end: holdAbsStart + chunk.length };
    yield* flushLive(chunk, span);
    holdAbsStart = span.end;
  };

  const absorb = function* (piece: string): Generator<NormalizeEvent, void, unknown> {
    if (!piece) return;
    // pass mode or skip latch: no content tool hold — keep all text live
    if (skipContentScan || mode === "pass") {
      const span: RawSpan = { start: holdAbsStart, end: holdAbsStart + piece.length };
      yield* flushLive(piece, span);
      // Bypasses hold entirely — advance the ledger cursor past it (C1).
      holdAbsStart = span.end;
      return;
    }

    // Peek fence suppress: if channels are inside a fence, don't tool-hold
    // for content that's still inside it. But a piece that ARRIVES while
    // fenced may also carry that SAME fence's own close partway through —
    // whatever follows the close was never fence body and must get a
    // normal shot at tool-marker scanning, not be blindly textified along
    // with the fence body ahead of it (that let a real call starting right
    // after an in-progress fence closes mid-chunk go unrecognized live,
    // then resurface a second time via the EOS assemble's own rediscovery —
    // painted as raw text AND emitted as a call). `peekFenceClose` finds
    // that boundary without mutating channels state; `commitToText` below
    // still does the real, mutating feedChannels pass over the fence-body
    // slice (so channels.fence really does clear), and only the remainder
    // — genuinely never inside the fence — re-enters normal scanning.
    // A speculative marker-prefix hold from a PRIOR call (e.g. a lone "<"
    // that might have started "<tool_call>") is not tool markup once we're
    // fenced either — it lands in the same paint (abort law: text fate) so
    // it lands in its original position instead of straggling to a later
    // flush (fence/hermes chunk-boundary corruption: "Do<tool_call" instead
    // of "Done.<tool_call").
    // channels.hold (stream-channels.ts's OWN pending-run buffer — e.g. an
    // ambiguous trailing backtick run not yet known to have stopped
    // growing) sits BEFORE whatever's about to be fed to it: feedChannels
    // re-prepends it internally on the next real call, so a peek must
    // prepend it too to see the same text feedChannels would, then convert
    // the returned offset back to combined-relative before slicing (never
    // feed channelsHoldLen twice — commitToText below intentionally never
    // includes it, only `combined`).
    const peekClose = (combined: string): number | null => {
      const channelsHoldLen = channels.hold.length;
      const abs = peekFenceClose(channels.hold + combined, channels.fence!, channels.atLineStart);
      return abs === null ? null : Math.max(0, abs - channelsHoldLen);
    };

    let rest: string;
    if (channels.fence) {
      const combined = hold + piece;
      hold = "";
      holdMode = "ground";
      const closeAt = peekClose(combined);
      if (closeAt === null) {
        // OD-1: fence doesn't close within what we have yet — all of it
        // is fence body, still text, nothing here to re-scan yet.
        yield* commitToText(combined);
        return;
      }
      yield* commitToText(combined.slice(0, closeAt));
      rest = combined.slice(closeAt);
    } else {
      rest = piece;
    }

    while (rest.length > 0) {
      // re-check fence after partial flushes (same drain — belt and braces).
      if (channels.fence) {
        const combined = hold + rest;
        hold = "";
        holdMode = "ground";
        const closeAt = peekClose(combined);
        if (closeAt === null) {
          yield* commitToText(combined);
          return;
        }
        yield* commitToText(combined.slice(0, closeAt));
        rest = combined.slice(closeAt);
        if (rest.length === 0) return;
        continue;
      }

      if (holdMode !== "inside") {
        // GROUND / MAYBE_OPEN: bounded-lookahead marker scan (T4). A fresh
        // span starts exactly when holdMode is "ground" (hold drained to
        // "") — rebase the scanner's own coordinate system there. When
        // holdMode is "maybe_open", the scanner already carries the
        // in-progress match state from the previous absorb() call; feeding
        // it only the NEW piece (never `hold` again) is what makes this a
        // single O(n) pass instead of a rescan.
        if (holdMode === "ground") {
          openScanner.reset();
          scannerPaintedLen = 0;
        }
        const holdBefore = hold;
        const scan = openScanner.feed(rest);
        const combined = holdBefore + rest;
        rest = "";

        if (scan.match) {
          // Transition: ground/maybe_open -> inside. `scan.match.start` is
          // absolute since the scanner's last reset; convert back to a
          // combined-relative offset by subtracting everything already
          // painted away this span (see `scannerPaintedLen`).
          const openAt = scan.match.start - scannerPaintedLen;
          if (openAt > 0) {
            const preSpan: RawSpan = { start: holdAbsStart, end: holdAbsStart + openAt };
            yield* flushLive(combined.slice(0, openAt), preSpan);
          }
          // Both branches below start at `openAt` within `combined` —
          // advance the cursor once, before the branch (C1 ledger).
          holdAbsStart += openAt;

          if (channels.fence) {
            // Abort transition (text fate): painting the pre-marker text
            // just entered a fence. A fenced "<tool_call>" is not a tool
            // open, it's fence body that happens to spell one — veto the
            // candidate transition to `inside`. Do NOT textify the whole
            // remainder here: the fence may close within it, and whatever
            // follows the close deserves a live marker scan (a decoy call
            // inside the fence followed by a real call after it took two
            // fates — painted raw AND rediscovered by the EOS assemble). Route
            // back to the loop-top fence gate, the one site that splits at
            // the close via peekFenceClose.
            hold = "";
            holdMode = "ground";
            rest = combined.slice(openAt);
            continue;
          }

          hold = combined.slice(openAt);
          holdMode = "inside";
          // Tool marker ends unterminated think for channel state (absorb
          // path holds the marker outside feedChannels).
          if (channels.channel === "reasoning") {
            channels.channel = "prose";
          }
        } else {
          // No marker yet. `scan.holdLength` bounds the speculative tail to
          // at most (longest marker length - 1) chars — everything before
          // it is provably not part of any still-incomplete marker attempt
          // and is safe to paint immediately (T4).
          const safeEnd = combined.length - scan.holdLength;
          const safe = combined.slice(0, safeEnd);
          hold = combined.slice(safeEnd);
          const safeSpan: RawSpan = { start: holdAbsStart, end: holdAbsStart + safeEnd };
          holdAbsStart += safeEnd;
          scannerPaintedLen += safeEnd;
          if (safe) yield* flushLive(safe, safeSpan);
          holdMode = hold ? "maybe_open" : "ground";

          // Abort transition (text fate): the speculative prefix we're
          // still holding is a bet that outside-fence text keeps growing
          // into a marker. If painting `safe` just flipped us into a
          // fence, that bet is void — fence body is never tool-scanned.
          // Route the stranded hold back through the loop-top fence gate
          // (the same site as every other in-fence paint) so it lands in
          // its original position — not a later flush across a chunk
          // boundary (the fence/hermes byte-reorder) — and is never blind
          // to a fence close hiding inside it.
          if (channels.fence && hold) {
            const strand = hold;
            hold = "";
            holdMode = "ground";
            rest = strand;
            continue;
          }
        }
      }

      if (holdMode === "inside") {
        hold += rest;
        rest = "";
        if (hold.length > maxBuf) {
          yield {
            type: "error",
            message: "maxBufferChars exceeded while holding tool markup",
            recoverable: true,
          };
          // Abort law: this span is bound to call-or-drop, never text, once
          // it is confidently a tool-call attempt — never both dropped AND
          // painted (that double-account is exactly what the C1 ledger
          // catches). A live-started call (name already certain) always
          // drops. Otherwise — the common single-chunk overflow shape,
          // where the buffer floods past maxBuf before step() ever runs —
          // peek the dialect's name-certainty against the caller's own
          // catalog: with no catalog we have no basis to judge this was
          // ever a real call, so the safe default is to show the raw text;
          // with a catalog, a confidently-named span is treated the same
          // as any other validation failure (silently dropped, not leaked
          // as markup).
          const abortSpan: RawSpan = {
            start: holdAbsStart,
            end: holdAbsStart + hold.length,
          };
          let dropCall: { index: number; id: string; name: string } | null = null;
          if (liveStep.call) {
            dropCall = liveStep.call;
            liveStep.call = null;
          } else if (useStep && stepDialect?.step && stepState != null && opts.tools?.length) {
            const peeked = stepDialect.step(stepState, hold, { original: hold });
            const startEv = peeked.events.find(
              (e): e is Extract<NormalizeEvent, { type: "tool_call_start" }> => e.type === "tool_call_start",
            );
            if (startEv?.name) {
              const index = irIndex++;
              const id = mintId(index, startEv.name, "{}", idStyle, true);
              dropCall = { index, id, name: startEv.name };
              yield {
                type: "tool_call_start",
                index,
                id,
                name: startEv.name,
                span: { start: holdAbsStart, end: holdAbsStart },
              };
            }
          }
          if (dropCall === null) {
            // emitLiveOnly (not flushLive): the span must not also reach the
            // EOS assemble — recoveryText must never carry an aborted span, or
            // the structure-blind assemble-time extract() could re-discover a
            // "closed" call from it (audit-S2: the very overflow that forced
            // this abort may itself be the byte that would have closed the
            // block).
            commit(abortSpan, "text", hold, false);
            yield* emitLiveOnly(hold);
          } else {
            yield {
              type: "tool_call_drop",
              index: dropCall.index,
              id: dropCall.id,
              name: dropCall.name,
              reason: "aborted",
              span: abortSpan,
            };
            // toRecovery=false: recoveryText must never carry an aborted
            // span, or the structure-blind assemble-time extract() could
            // re-discover a "closed" call from it (audit-S2: the very
            // overflow that forced this abort may itself be the byte that
            // would have closed the block). Still routed through `commit`
            // so the span is on the ledger for the overlap invariant.
            commit(abortSpan, "dropped", hold, false);
          }
          holdAbsStart = abortSpan.end;
          hold = "";
          // Abort transition: inside -> ground. This maxBuf trip is the
          // CAPTURE-phase guard (T4) — a runaway tool body, not a general
          // stream valve; ground/maybe_open are never subject to it (they
          // are already bounded by the scanner's holdLength).
          holdMode = "ground";
          if (useStep && stepDialect?.createStreamState) {
            stepState = stepDialect.createStreamState();
          }
          continue;
        }

        // 2b-1: dialect.step() when single dialect resolved — name-certain start
        // mid-hold; close still probes for authoritative args (ladder).
        if (useStep && stepDialect?.step && stepState != null) {
          const stepped = stepDialect.step(stepState, hold, {
            original: hold,
          });
          // OD-1 / conservation: if step already reject-replayed text, do not
          // paint the same span again after probe/close.
          let stepPaintedText = false;
          for (const ev of stepped.events) {
            if (ev.type === "tool_call_start" && !liveStep.call) {
              // Gate-partition: name-only rejects → no start. We only start
              // when name is certain; requireKnown runs at probe close.
              const index = irIndex++;
              const id = mintId(index, ev.name, "{}", idStyle, true);
              liveStep.call = { index, id, name: ev.name };
              // Anchor only (zero-width): the call's true extent isn't known
              // until close — see the authoritative span on tool_call_end.
              yield {
                type: "tool_call_start",
                index,
                id,
                name: ev.name,
                span: { start: holdAbsStart, end: holdAbsStart },
              };
            } else if (ev.type === "tool_call_args_delta" && liveStep.call && ev.argumentsDelta) {
              // Preview only — do not commit
              yield {
                type: "tool_call_args_delta",
                index: liveStep.call.index,
                id: liveStep.call.id,
                argumentsDelta: ev.argumentsDelta,
              };
            } else if (ev.type === "text_delta" && ev.text) {
              // step reject-replay (not a tool open)
              yield* emitLiveOnly(ev.text);
              stepPaintedText = true;
            }
            // tool_call_end from step is a close signal — handled below via consumed
          }

          if (stepped.consumed > 0) {
            const spanStart = holdAbsStart;
            const span = hold.slice(0, stepped.consumed);
            const spanEnd = holdAbsStart + stepped.consumed;
            const rawSpan: RawSpan = { start: spanStart, end: spanEnd };
            // C1: recoveryText/captured gets this span ONLY if its eventual
            // fate is NOT "call" — a span already committed live (start +
            // args + end already emitted via emitToolIr below) must never
            // also reach the EOS assemble, or the assemble's own extract() rediscovers
            // the same characters as a SECOND tool call (the n1-repro-a
            // phantom-double-call this task fixes). Each terminal branch
            // below appends to recoveryText itself when its fate is
            // text/dropped; the call-fate branch deliberately does not.
            hold = hold.slice(stepped.consumed);
            holdAbsStart = spanEnd;
            // Still capturing -> stay inside; consumed a full span -> the
            // close transition below resolves fate and returns to ground.
            holdMode = stepped.holding ? "inside" : "ground";
            if (!stepped.holding) {
              // Closed span: authoritative probe (schema / requireKnown)
              const started = liveStep.call;
              liveStep.call = null;
              if (useStep && stepDialect.createStreamState) {
                stepState = stepDialect.createStreamState();
              }
              if (mode === "repair" || mode === "strict") {
                const alone = probeSpan(span);
                if (alone.tool_calls.length > 0) {
                  commit(rawSpan, "call"); // fate = call — never captured (see comment above).
                  for (let i = 0; i < alone.tool_calls.length; i++) {
                    const tc = alone.tool_calls[i]!;
                    const partial = alone.meta.partial.includes(i);
                    const matchStart =
                      started && (started.name === tc.function.name || alone.tool_calls.length === 1)
                        ? started
                        : undefined;
                    yield* emitToolIr(tc, partial, false, matchStart, rawSpan);
                  }
                } else if (started) {
                  // start without end → drop (gate after start). Name-certainty
                  // law (C1/T2): this span already reached "inside" and had a
                  // name parsed — it is machinery, never prose, so it is
                  // NEVER painted, matching the batch path's unconditional
                  // cleanupContent() strip of every toolSpan regardless of
                  // why it was rejected. toRecovery=false: recoveryText must
                  // never carry a name-certain dropped span, or the EOS
                  // assemble's own extract() would rediscover + re-drop the same
                  // characters (a redundant meta.dropped entry), mirroring
                  // the maxBuf dropCall precedent above.
                  yield {
                    type: "tool_call_drop",
                    index: started.index,
                    id: started.id,
                    name: started.name,
                    reason: "unknown_name",
                    span: rawSpan,
                  };
                  commit(rawSpan, "dropped", span, false);
                } else if (!stepPaintedText) {
                  // Never name-certain: content conservation — only if step
                  // did not already paint.
                  yield* emitLiveOnly(span);
                  commit(rawSpan, "text", span, true);
                }
              } else if (mode === "detect") {
                if (started) {
                  // Name-certainty law: dropped machinery, never painted —
                  // see the repair/strict branch above for the rationale.
                  yield {
                    type: "tool_call_drop",
                    index: started.index,
                    id: started.id,
                    name: started.name,
                    reason: "unknown_name",
                    span: rawSpan,
                  };
                  commit(rawSpan, "dropped", span, false);
                } else {
                  if (!stepPaintedText) yield* emitLiveOnly(span);
                  commit(rawSpan, "text", span, true);
                }
              }
              // remainder after span may contain next open
              if (hold) {
                rest = hold + rest;
                hold = "";
                holdMode = "ground";
              }
            }
            continue;
          }
          if (stepped.holding) break;
          // step not holding and consumed 0 — fall through to close-marker path
        }

        const closeEnd = firstClosedToolEnd(hold, closeMarkers);
        if (closeEnd >= 0) {
          const spanStart = holdAbsStart;
          const span = hold.slice(0, closeEnd);
          const spanEnd = holdAbsStart + closeEnd;
          const rawSpan: RawSpan = { start: spanStart, end: spanEnd };
          // R1: symmetric with the step-close path above — recoveryText is
          // written ONLY once the fate is known (via `commit`), never
          // unconditionally up front. A "call" fate is never captured, or
          // the EOS assemble's own extract() would rediscover + re-execute the
          // same characters as a second call (the phantom-double-call this
          // fallback path used to be able to produce).
          rest = hold.slice(closeEnd) + rest;
          hold = "";
          holdAbsStart = spanEnd;
          // Close transition: inside -> ground (non-step fallback path).
          holdMode = "ground";
          const started = liveStep.call;
          liveStep.call = null;

          // 2b-4: live probe on closed span (repair/strict only)
          if (mode === "repair" || mode === "strict") {
            const alone = probeSpan(span);
            if (alone.tool_calls.length > 0) {
              commit(rawSpan, "call"); // fate = call — never captured.
              for (let i = 0; i < alone.tool_calls.length; i++) {
                const tc = alone.tool_calls[i]!;
                const partial = alone.meta.partial.includes(i);
                const matchStart = started && alone.tool_calls.length === 1 ? started : undefined;
                // Content spans: always emit (multiset); track for EOS native dedup
                yield* emitToolIr(tc, partial, false, matchStart, rawSpan);
              }
            } else if (started) {
              // Name-certainty law (C1/T2): a live-started call rejected by
              // the probe (unknown name) is dropped machinery, never
              // painted — symmetric with the step-close path above and with
              // the batch path's unconditional cleanupContent() strip.
              // toRecovery=false: never let the EOS assemble rediscover + re-drop
              // the same span (redundant meta.dropped entry).
              yield {
                type: "tool_call_drop",
                index: started.index,
                id: started.id,
                name: started.name,
                reason: "unknown_name",
                span: rawSpan,
              };
              commit(rawSpan, "dropped", span, false);
            } else {
              // Never name-certain: content conservation — unknown/unparseable
              // markup was always prose, live text now.
              yield* emitLiveOnly(span);
              commit(rawSpan, "text", span, true);
            }
          } else if (mode === "detect") {
            // detect: leave markup as live text; no recovered execute —
            // EXCEPT a name-certain drop, which follows the same
            // never-painted law as repair/strict above.
            if (started) {
              yield {
                type: "tool_call_drop",
                index: started.index,
                id: started.id,
                name: started.name,
                reason: "unknown_name",
                span: rawSpan,
              };
              commit(rawSpan, "dropped", span, false);
            } else {
              yield* emitLiveOnly(span);
              commit(rawSpan, "text", span, true);
            }
          }
          continue;
        }
        break;
      }
    }
  };

  function* ingest(chunk: string | OpenAiChatChunk): Generator<NormalizeEvent, void, unknown> {
    if (typeof chunk === "string") {
      yield* absorb(chunk);
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      yield* absorb(delta.content);
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      yield { type: "reasoning_delta", text: delta.reasoning_content };
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        // Index-collision law (H6): name on an index that already has a
        // different name opens a new IR call (Ollama pins index: 0).
        let idx = tc.index ?? nativeTools.length;
        const incomingName = typeof tc.function?.name === "string" ? tc.function.name : "";
        if (
          incomingName &&
          nativeNameAtIndex.has(idx) &&
          nativeNameAtIndex.get(idx) !== incomingName &&
          // only collide when the slot already finished a name (non-empty)
          nativeNameAtIndex.get(idx) !== ""
        ) {
          // If the existing name is a proper prefix of incoming, treat as
          // name accumulation (H7 split fragments), not a new call.
          const prev = nativeNameAtIndex.get(idx)!;
          if (incomingName.startsWith(prev) || prev.startsWith(incomingName)) {
            // accumulate below
          } else {
            idx = nativeTools.length;
          }
        }

        while (nativeTools.length <= idx) {
          nativeTools.push({
            id: `call_${nativeTools.length}`,
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const cur = nativeTools[idx]!;
        if (tc.id) cur.id = tc.id;

        if (incomingName) {
          const prev = cur.function.name;
          // H7: accumulate split name fragments
          if (!prev) {
            cur.function.name = incomingName;
          } else if (incomingName.startsWith(prev)) {
            cur.function.name = incomingName;
          } else if (!prev.startsWith(incomingName) && prev !== incomingName) {
            // non-prefix different name on same index after reassignment
            cur.function.name = incomingName;
          }
          nativeNameAtIndex.set(idx, cur.function.name);
          if (nativePolicy === "skip") {
            skipContentScan = true;
          }
        }

        if (typeof tc.function?.arguments === "string") {
          cur.function.arguments += tc.function.arguments;
        }
      }
    }
    if (choice?.finish_reason) finishIn = choice.finish_reason;
  }

  function* close(): Generator<NormalizeEvent, void, unknown> {
    // EOS: release incomplete tool hold + channel hold into recovery / live
    // Open start without end is illegal IR — drop before reject-replay
    const orphanStart = liveStep.call;
    liveStep.call = null;
    if (orphanStart) {
      // C1 law: a name-certain call is bound to call-or-drop, never text —
      // once tool_call_start went live, painting the same span as prose
      // would double-account it (dropped AND painted). Drop only; hand the
      // raw text to the EOS assemble below (unpainted) so an independent
      // partial recovery can still surface, but never as visible content.
      const span: RawSpan = { start: holdAbsStart, end: holdAbsStart + hold.length };
      yield {
        type: "tool_call_drop",
        index: orphanStart.index,
        id: orphanStart.id,
        name: orphanStart.name,
        reason: "truncated",
        span,
      };
      commit(span, "dropped", hold, true);
      holdAbsStart = span.end;
      hold = "";
      // Abort transition (drop fate): inside -> ground at EOS.
      holdMode = "ground";
    } else if (hold) {
      // Never name-certain: a lost bet commits to text (S2/abort law) —
      // reject-replay the incomplete markup as live content + recovery.
      const strand = hold;
      hold = "";
      holdMode = "ground";
      yield* commitToText(strand);
    }
    yield* flushChannelHold(channels);

    const nativesForAssemble = nativeTools.filter((t) => t.function.name);
    const assembleOpts = {
      ...opts,
      mode: mode === "pass" ? ("pass" as const) : mode === "detect" ? ("detect" as const) : mode,
      nativePolicy: skipContentScan || mode === "pass" ? ("skip" as const) : nativePolicy,
      finishReasonIn: finishIn,
    };

    const resultFinal = normalizeMessageImpl(
      {
        content: recoveryText,
        tool_calls: nativesForAssemble,
        reasoning_content: reasoning || null,
      },
      assembleOpts,
    );

    // EOS: emit any assemble tools not already live-committed (natives + missed recovered).
    // First-committer: content-recovered tools already in `committed` win over duplicates.
    const emitTools =
      mode === "pass" || mode === "detect"
        ? resultFinal.tool_calls.filter((tc) =>
            nativesForAssemble.some((n) => n.id === tc.id || n.function.name === tc.function.name),
          )
        : resultFinal.tool_calls;

    for (const emitTool of emitTools) {
      const tc = emitTool!;
      const isPartial =
        mode !== "pass" &&
        mode !== "detect" &&
        resultFinal.meta.partial.includes(resultFinal.tool_calls.findIndex((t) => t.id === tc.id));
      yield* emitToolIr(tc, isPartial);
    }

    // Tools found for finish_reason: committed set or assemble
    const toolsFound = committed.length > 0 || resultFinal.tool_calls.length > 0;

    yield { type: "meta", meta: resultFinal.meta };
    yield {
      type: "finish",
      finish_reason: streamFinishReason(resultFinal.finish_reason, toolsFound),
    };
  }

  return { ingest, close };
}

/** Collect IR events from a sync chunk iterable (single-chunk batch assemble path). */
export function collectStreamSync(
  chunks: Iterable<string | OpenAiChatChunk>,
  opts: NormalizeOptions = {},
): NormalizeEvent[] {
  const session = createStreamSession(opts);
  const out: NormalizeEvent[] = [];
  for (const chunk of chunks) {
    for (const ev of session.ingest(chunk)) out.push(ev);
  }
  for (const ev of session.close()) out.push(ev);
  return out;
}
