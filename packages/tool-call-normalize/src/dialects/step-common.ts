/**
 * Shared helpers for Dialect.step() on markup dialects (hermes / longcat / qwen).
 *
 * Contract (buffer = full hold from open marker or incomplete open prefix):
 * - `consumed`: drop this many chars from the front of buffer (completed span or reject)
 * - `holding`: still inside a tool (or incomplete open) — stream must not paint
 * - `events`: provisional IR (index 0, id "step") — stream remaps ids/indices
 *
 * Name-certainty (§9.3):
 * - JSON forms: after `"name"` / `'name'` member parses
 * - Tagged qwen: at `<function=NAME>` open
 * - Tagged longcat: first non-empty name line (before arg tags)
 */

import { maskFences } from "../fence.js";
import type { NormalizeEvent, StreamStepResult, ValueDelimiter } from "../types.js";

export type MarkupStepState = {
  /** True once a complete open marker has been seen. */
  openSeen: boolean;
  /** Body after the open tag (may be partial). */
  body: string;
  /** Name when certain; null until then. */
  name: string | null;
  /** tool_call_start already emitted this call. */
  started: boolean;
  /** Last body length for which args_delta was emitted. */
  argsEmittedLen: number;
  /** Open tag spelling that matched (for diagnostics). */
  openTag: string;
};

export function createMarkupStepState(): MarkupStepState {
  return {
    openSeen: false,
    body: "",
    name: null,
    started: false,
    argsEmittedLen: 0,
    openTag: "",
  };
}

export function resetMarkupStepState(s: MarkupStepState): void {
  s.openSeen = false;
  s.body = "";
  s.name = null;
  s.started = false;
  s.argsEmittedLen = 0;
  s.openTag = "";
}

/** Longest open marker that is a prefix of buf (case-insensitive), complete or not. */
export function matchOpenPrefix(
  buf: string,
  openMarkers: string[],
): { tag: string; len: number; complete: boolean } | null {
  const lower = buf.toLowerCase();
  let best: { tag: string; len: number; complete: boolean } | null = null;
  for (const m of openMarkers) {
    const ml = m.toLowerCase();
    if (lower.startsWith(ml)) {
      const cand = { tag: m, len: m.length, complete: true as boolean };
      if (!best || cand.len > best.len) best = cand;
    } else if (ml.startsWith(lower) && lower.length > 0) {
      // incomplete open
      const cand = { tag: m, len: 0, complete: false as boolean };
      if (!best || (!best.complete && m.length > best.tag.length)) best = cand;
    }
  }
  return best;
}

/**
 * Pair open tag family with its close markers so nested dialects (qwen
 * `<tool_call>` wrapping `<function=…>`) do not close at the inner tag.
 * Falls back to all closes when no pair matches.
 */
export function closeMarkersForOpen(openTag: string, closeMarkers: string[]): string[] {
  const o = openTag.toLowerCase().replace(/>$/, "");
  const paired = closeMarkers.filter((c) => {
    const core = c.toLowerCase().replace(/^<\//, "<").replace(/>$/, "");
    // longcat variants share the "longcat" stem
    if (o.includes("longcat") && core.includes("longcat")) return true;
    // hermes / qwen wrapper
    if (o.startsWith("<tool_call") && core.startsWith("<tool_call")) return true;
    // qwen bare function=
    if (o.startsWith("<function") && core.startsWith("<function")) return true;
    return false;
  });
  return paired.length > 0 ? paired : closeMarkers;
}

/**
 * Multi-dialect fallback (no single resolved dialect — the
 * soft-modelHint / no-step streaming path in normalize-stream.ts's
 * `firstClosedToolEnd`). Kept hardcoded on purpose: that caller has no
 * single `Dialect` to read `valueDelimiters` off of. task D1's real fix is
 * `maskArgValues` below, driven by a dialect's OWN declared delimiters —
 * this function is not that fix and must not be extended per-dialect.
 */
export function maskArgValueInteriors(buf: string): string {
  let out = buf;
  out = out.replaceAll(/<longcat[_-]?arg[_-]?value\s*>[\s\S]*?<\/longcat[_-]?arg[_-]?value\s*>/gi, (m) =>
    " ".repeat(m.length),
  );
  out = out.replaceAll(/<parameter\s*=\s*[^>\s]+\s*>[\s\S]*?<\/parameter\s*>/gi, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Host-level argument-value masking (task D1), driven by a dialect's OWN
 * declared `valueDelimiters` — never per-dialect masking code. Replaces the
 * hardcoded longcat+qwen knowledge `maskArgValueInteriors` had baked in: a
 * third dialect that declares its value delimiter pair gets this for free.
 *
 * For every value occurrence (earliest open of any declared delimiter,
 * left to right):
 * - CLEAN — the value's own close arrives before any `outerCloseMarkers`
 *   occurrence (or none occurs at all): mask the INTERIOR only (same
 *   length spaces). The delimiter tags stay visible so a dialect's own
 *   field-parser can still find + capture this value — values themselves
 *   are always recovered from `ctx.original`, never from this masked text.
 * - POISONED — an outer close marker occurs before the value's own close:
 *   the entire match (tags included) is blanked. A value that contains
 *   what looks like the enclosing call's own close cannot be trusted for
 *   field-level parsing, so it must not be findable at all afterward.
 * - UNCLOSED — the value never closes within `text`: fail CLOSED (not
 *   open) — it swallows the remainder of `text`, tags included, so
 *   nothing past it (found or not) can register as a close.
 */
export function maskArgValues(text: string, valueDelimiters: ValueDelimiter[], outerCloseMarkers: string[]): string {
  if (valueDelimiters.length === 0 || !text) return text;
  let out = text;
  let cursor = 0;
  const lowerOuter = outerCloseMarkers.map((m) => m.toLowerCase());

  const findOuter = (from: number): number => {
    const lower = out.slice(from).toLowerCase();
    let best = -1;
    for (const m of lowerOuter) {
      if (!m) continue;
      const i = lower.indexOf(m);
      if (i !== -1 && (best < 0 || i < best)) best = i;
    }
    return best < 0 ? -1 : from + best;
  };

  while (cursor < out.length) {
    let bestOpen: { start: number; end: number; delim: ValueDelimiter } | null = null;
    for (const d of valueDelimiters) {
      const re = new RegExp(d.open.source, "i");
      const m = re.exec(out.slice(cursor));
      if (m) {
        const start = cursor + m.index;
        if (!bestOpen || start < bestOpen.start) {
          bestOpen = { start, end: start + m[0].length, delim: d };
        }
      }
    }
    if (!bestOpen) break;

    const closeRe = new RegExp(bestOpen.delim.close.source, "i");
    const closeM = closeRe.exec(out.slice(bestOpen.end));
    const ownCloseStart = closeM ? bestOpen.end + closeM.index : -1;
    const ownCloseEnd = closeM ? ownCloseStart + closeM[0].length : -1;
    const outerAt = findOuter(bestOpen.end);

    if (ownCloseStart >= 0 && (outerAt < 0 || ownCloseStart <= outerAt)) {
      // CLEAN: interior only, tags stay findable.
      out = out.slice(0, bestOpen.end) + " ".repeat(ownCloseStart - bestOpen.end) + out.slice(ownCloseStart);
      cursor = ownCloseEnd;
    } else if (ownCloseStart >= 0) {
      // POISONED: whole match (tags included) blanked.
      out = out.slice(0, bestOpen.start) + " ".repeat(ownCloseEnd - bestOpen.start) + out.slice(ownCloseEnd);
      cursor = ownCloseEnd;
    } else {
      // UNCLOSED: fail closed — swallow the remainder of text.
      out = out.slice(0, bestOpen.start) + " ".repeat(out.length - bestOpen.start);
      cursor = out.length;
    }
  }
  return out;
}

/** End offset (exclusive) of first close marker in buf, or -1. */
export function findCloseEnd(buf: string, closeMarkers: string[], valueDelimiters: ValueDelimiter[] = []): number {
  const scan = maskArgValues(buf, valueDelimiters, closeMarkers);
  const lower = scan.toLowerCase();
  let best = -1;
  for (const c of closeMarkers) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) {
      const end = i + c.length;
      if (best < 0 || end < best) best = end;
    }
  }
  return best;
}

/** Close marker length for the first close found (for body slicing). */
export function findCloseMarkerLen(
  buf: string,
  closeMarkers: string[],
  valueDelimiters: ValueDelimiter[] = [],
): number {
  const scan = maskArgValues(buf, valueDelimiters, closeMarkers);
  const lower = scan.toLowerCase();
  let bestI = -1;
  let bestLen = 0;
  for (const c of closeMarkers) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1 && (bestI < 0 || i < bestI)) {
      bestI = i;
      bestLen = c.length;
    }
  }
  return bestLen;
}

/**
 * JSON name-certainty: `"name": "foo"` or `'name': 'foo'` in body.
 * Does not require full JSON parse (args may still be streaming).
 */
export function extractJsonNameCertain(body: string): string | null {
  const dbl = /"name"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(body);
  if (dbl?.[1] != null) {
    try {
      return JSON.parse(`"${dbl[1]}"`) as string;
    } catch {
      return dbl[1];
    }
  }
  const sgl = /'name'\s*:\s*'((?:\\.|[^'\\])*)'/.exec(body);
  return sgl?.[1] ?? null;
}

/**
 * Longcat tagged: first non-empty line of body that is not an arg tag,
 * once we have a newline after it OR an arg tag follows (name line complete).
 */
export function extractLongcatTaggedName(body: string): string | null {
  // JSON form wins only when object-looking at start AND name member present
  // before any arg_key (avoid arg_value JSON false form — audit-012 L1).
  const trimmed = body.replace(/^\s+/, "");
  if (trimmed.startsWith("{")) {
    const beforeArg = body.split(/<longcat[_-]?arg[_-]?key/i)[0] ?? body;
    const jn = extractJsonNameCertain(beforeArg);
    if (jn) return jn;
  }
  const withoutArgs = body
    .replaceAll(/<longcat[_-]?arg[_-]?key[\s\S]*?<\/longcat[_-]?arg[_-]?key\s*>/gi, "")
    .replaceAll(/<longcat[_-]?arg[_-]?value[\s\S]*?<\/longcat[_-]?arg[_-]?value\s*>/gi, "");
  const lines = withoutArgs
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const nameLine = lines[0]!.replace(/^(function|tool|call)\s+/i, "").trim();
  if (!nameLine || nameLine.startsWith("{")) return null;
  // Name line complete when: more lines, or arg tag seen (same line OK), or
  // newline after name, or body ends with close marker after name only.
  const hasArg = /<longcat[_-]?arg[_-]?key/i.test(body);
  const hasNewlineAfterName = new RegExp(String.raw`^\s*${escapeRe(lines[0]!)}\s*\r?\n`, "i").test(body);
  // Same-line: `writefile <longcatargkey>` or `writefile</longcat…>`
  const sameLineArgOrClose = new RegExp(
    String.raw`^\s*${escapeRe(lines[0]!)}\s*(?:<longcat[_-]?arg[_-]?key|</longcat)`,
    "i",
  ).test(body);
  if (hasArg || hasNewlineAfterName || lines.length > 1 || sameLineArgOrClose) {
    return nameLine;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export function provisionalStart(name: string): NormalizeEvent {
  return {
    type: "tool_call_start",
    index: 0,
    id: "step",
    name,
  };
}

export function provisionalArgsDelta(delta: string): NormalizeEvent {
  return {
    type: "tool_call_args_delta",
    index: 0,
    id: "step",
    argumentsDelta: delta,
  };
}

/**
 * Drive markup step for open/close marker dialects.
 * `detectName(body, openTag)` returns name when certain.
 */
export function stepMarkup(
  state: MarkupStepState,
  buffer: string,
  opts: {
    openMarkers: string[];
    closeMarkers: string[];
    detectName: (body: string, openTag: string) => string | null;
    /** Dialect's own argument-value delimiter pairs (task D1). Default: none. */
    valueDelimiters?: ValueDelimiter[];
  },
): StreamStepResult {
  const events: NormalizeEvent[] = [];

  if (!buffer) {
    return { consumed: 0, events, holding: false };
  }

  // Incomplete open only
  if (state.openSeen) {
    // Re-derive body from full buffer (buffer always full hold from open)
    const open = matchOpenPrefix(buffer, opts.openMarkers);
    const openLen = open?.complete ? open.len : state.openTag.length;
    state.body = buffer.slice(openLen);
  } else {
    const open = matchOpenPrefix(buffer, opts.openMarkers);
    if (!open) {
      // Not a tool open — reject whole buffer as text (stream should not call us)
      return {
        consumed: buffer.length,
        events: [{ type: "text_delta", text: buffer }],
        holding: false,
      };
    }
    if (!open.complete) {
      return { consumed: 0, events, holding: true };
    }
    state.openSeen = true;
    state.openTag = open.tag;
    state.body = buffer.slice(open.len);
  }

  // Structure-only view for name/close scanning (masked same-length so
  // offsets transfer 1:1 to state.body): a body-internal fenced example
  // (batch's fence law applies inside a tool body too, not only at message
  // top level) must never mint a name from its fenced content, and an
  // unclosed run — still streaming in, genuinely ambiguous — fails CLOSED
  // here (mask through end of body) rather than open, so a bare fence-open
  // line (e.g. "```") is never read as a name before its own close (or the
  // call's own close) resolves what it actually was. Display previews
  // below still read the ORIGINAL `state.body` — masking is scan-only.
  const maskedBody = maskFences(state.body, { failClosed: true }).masked;

  // Name certainty → start
  if (!state.started) {
    const name = opts.detectName(maskedBody, state.openTag);
    if (name) {
      state.name = name;
      state.started = true;
      events.push(provisionalStart(name));
    }
  }

  // Close? Pair with open family (qwen wrap vs bare function).
  const closes = closeMarkersForOpen(state.openTag, opts.closeMarkers);
  const valueDelimiters = opts.valueDelimiters ?? [];
  const closeEnd = findCloseEnd(maskedBody, closes, valueDelimiters);
  if (closeEnd >= 0) {
    const open = matchOpenPrefix(buffer, opts.openMarkers);
    const openLen = open?.complete ? open.len : state.openTag.length || 0;
    const spanEnd = openLen + closeEnd;
    const closeLen = findCloseMarkerLen(maskedBody, closes, valueDelimiters);
    // Final name from body if start was late
    if (!state.started) {
      const name = opts.detectName(maskedBody.slice(0, closeEnd - closeLen), state.openTag);
      if (name) {
        state.name = name;
        state.started = true;
        events.push(provisionalStart(name));
      }
    }
    // Args preview of final body (display)
    const bodyOnly = state.body.slice(0, closeEnd - closeLen);
    if (state.started && bodyOnly.length > state.argsEmittedLen) {
      events.push(provisionalArgsDelta(bodyOnly.slice(state.argsEmittedLen)));
    }
    // Signal close: empty-args end; stream re-probes span for authoritative args
    events.push({
      type: "tool_call_end",
      index: 0,
      id: "step",
      name: state.name ?? "",
      arguments: "", // stream must replace via probe
    });
    const consumed = spanEnd;
    resetMarkupStepState(state);
    return { consumed, events, holding: false };
  }

  // Mid-body args preview
  if (state.started && state.body.length > state.argsEmittedLen) {
    events.push(provisionalArgsDelta(state.body.slice(state.argsEmittedLen)));
    state.argsEmittedLen = state.body.length;
  }

  return { consumed: 0, events, holding: true };
}
