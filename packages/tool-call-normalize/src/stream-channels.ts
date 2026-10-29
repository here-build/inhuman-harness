/**
 * Live stream channels (2b-3):
 * - think tags → reasoning_delta (tags swallowed)
 * - unterminated think closes at high-precision tool open (§8 parity)
 * - fenced regions → text only; toolSuppress so absorb won't tool-hold
 *
 * audit-011 C3/C4. Keep state machine small and line-oriented for fences.
 * OD-1: open fence paints body as text; unbalanced fail-open is EOS assemble.
 */
import { TOOL_OPEN_HOLD_PREFIXES, toolOpenRe } from "./think.js";
import type { NormalizeEvent } from "./types.js";

const DEFAULT_THINK = ["think", "thinking", "reason", "reasoning"];

function tagAlts(tags: string[]): string {
  return tags.map((t) => t.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|");
}

export type ChannelState = {
  channel: "prose" | "reasoning";
  /** incomplete suffix held across chunks */
  hold: string;
  /** open fence run char + min length, or null */
  fence: { ch: string; n: number } | null;
  thinkTags: string[];
  /**
   * True iff the last character actually painted/consumed (across every
   * feedChannels call so far) was a newline — i.e. the NEXT character
   * would be the first of a fresh line. A candidate fence delimiter is
   * only a real CommonMark fence when it sits at true line start; buf's
   * own position 0 is only a trustworthy line start when this is true —
   * a chunk boundary can otherwise land buf's start mid-line (prior,
   * same-line characters were already painted in an earlier call), which
   * would otherwise misread a mid-line backtick run as a fence open/close
   * purely because it happens to open the CURRENT buffer.
   */
  atLineStart: boolean;
};

export function createChannelState(thinkTags?: string[]): ChannelState {
  return {
    channel: "prose",
    hold: "",
    fence: null,
    thinkTags: thinkTags?.length ? thinkTags : [...DEFAULT_THINK],
    atLineStart: true,
  };
}

type Out = NormalizeEvent & { type: "text_delta" | "reasoning_delta" };

function emit(state: ChannelState, text: string): Out | null {
  if (!text) return null;
  // inside fence always prose display
  if (state.fence || state.channel === "prose") {
    return { type: "text_delta", text };
  }
  return { type: "reasoning_delta", text };
}

/**
 * emit() + line-start bookkeeping. Every character that reaches the user
 * (or the reasoning channel) MUST pass through here, never raw `emit()`,
 * or `atLineStart` silently goes stale and the fence detector regresses to
 * trusting buf's own position 0 as a line start unconditionally.
 *
 * "At line start" survives a run of pure indentation: a fence opener may
 * be preceded by 0–3 spaces (matchFenceLine's own `( {0,3})`), and on a
 * one-char-at-a-time stream those leading spaces are painted through here
 * ONE AT A TIME, each in their own call, before the fence run itself has
 * even arrived — collapsing atLineStart to false the instant any text
 * (including a lone leading space) is painted would make an indented
 * fence opener unrecognizable on exactly the split that most needs it.
 * Only non-whitespace content — or a `\n` resetting the count — actually
 * leaves the "still might be a fence indent" state.
 */
function paint(state: ChannelState, text: string): Out | null {
  const ev = emit(state, text);
  if (text) {
    const lastNl = text.lastIndexOf("\n");
    state.atLineStart =
      lastNl === -1 ? state.atLineStart && /^[ \t]*$/.test(text) : /^[ \t]*$/.test(text.slice(lastNl + 1));
  }
  return ev;
}

/** Line-start fence open/close: optional indent 0–3 then ``` or ~~~ */
function matchFenceLine(line: string): { kind: "open" | "close"; ch: string; n: number; full: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const run = m[1]!;
  return {
    kind: "open", // caller decides open vs close from state
    ch: run[0]!,
    n: run.length,
    full: line,
  };
}

/**
 * Process piece; yields deltas. Returns whether tool holds must be suppressed.
 */
export function* feedChannels(state: ChannelState, piece: string): Generator<Out, { toolSuppress: boolean }> {
  let buf = state.hold + piece;
  state.hold = "";

  const alts = tagAlts(state.thinkTags);
  const openThinkRe = new RegExp(String.raw`<(${alts})\b[^>]*>`, "gi");
  const closeThinkRe = new RegExp(String.raw`</(${alts})\s*>`, "gi");

  // Work line-by-line for fences; think tags can be mid-line.
  while (buf.length > 0) {
    // Incomplete trailing special: hold
    const holdAt = incompleteSuffix(buf, state);
    if (holdAt < buf.length) {
      const safe = buf.slice(0, holdAt);
      state.hold = buf.slice(holdAt);
      buf = safe;
      if (buf.length === 0) break;
    }

    if (state.fence) {
      // consume until a line that closes this fence
      const nl = buf.indexOf("\n");
      const line = nl === -1 ? buf : buf.slice(0, nl);
      const rest = nl === -1 ? "" : buf.slice(nl + 1);
      // buf's own start is only a real line start when atLineStart says so
      // (a chunk boundary can otherwise land here mid fence-body-line).
      const fm = state.atLineStart ? matchFenceLine(line.trimEnd().replace(/\r$/, "")) : null;
      // emit the line (+ newline if present)
      const chunk = nl < 0 ? line : `${line}\n`;
      const ev = paint(state, chunk);
      if (ev) yield ev;
      if (
        fm &&
        fm.ch === state.fence.ch &&
        fm.n >= state.fence.n &&
        // closer is whole line after indent (info string empty or only spaces)
        /^[ \t]*[`~]{3,}[ \t]*$/.test(line)
      ) {
        state.fence = null;
      }
      buf = rest;
      if (nl < 0) break;
      continue;
    }

    // Not in fence: earliest of think open/close, tool open (ends unterminated think), fence line
    openThinkRe.lastIndex = 0;
    closeThinkRe.lastIndex = 0;
    const om = openThinkRe.exec(buf);
    const cm = closeThinkRe.exec(buf);

    // §8 parity: unterminated think closes at first high-precision tool marker
    const toolM = state.channel === "reasoning" ? toolOpenRe("i").exec(buf) : null;

    let fenceAt = -1;
    let fenceRun: { ch: string; n: number } | null = null;
    {
      let pos = 0;
      while (pos <= buf.length) {
        const lineEnd = buf.indexOf("\n", pos);
        const line = lineEnd === -1 ? buf.slice(pos) : buf.slice(pos, lineEnd);
        const trimmed = line.replace(/\r$/, "");
        // pos 0 is only a real line start when atLineStart says so — a
        // chunk boundary can otherwise land buf's start mid-line (prior
        // same-line prose already painted in an earlier call). Every
        // later "line" here follows a real "\n" found within buf itself,
        // so it's always a genuine line start regardless.
        const fm = pos > 0 || state.atLineStart ? matchFenceLine(trimmed) : null;
        if (fm) {
          fenceAt = pos;
          fenceRun = { ch: fm.ch, n: fm.n };
          break;
        }
        if (lineEnd === -1) break;
        pos = lineEnd + 1;
      }
    }

    type Hit =
      | { k: "to"; at: number; len: number }
      | { k: "tc"; at: number; len: number }
      | { k: "toolEndThink"; at: number }
      | { k: "fe"; at: number; ch: string; n: number; lineLen: number };

    let hit: Hit | null = null;
    if (om?.index !== undefined) {
      hit = { k: "to", at: om.index, len: om[0].length };
    }
    if (cm?.index !== undefined && (!hit || cm.index < hit.at)) {
      hit = { k: "tc", at: cm.index, len: cm[0].length };
    }
    if (toolM?.index !== undefined && (!hit || toolM.index < hit.at)) {
      hit = { k: "toolEndThink", at: toolM.index };
    }
    if (fenceAt >= 0 && fenceRun) {
      const lineEnd = buf.indexOf("\n", fenceAt);
      const lineLen = lineEnd === -1 ? buf.length - fenceAt : lineEnd + 1 - fenceAt;
      if (!hit || fenceAt < hit.at) {
        hit = {
          k: "fe",
          at: fenceAt,
          ch: fenceRun.ch,
          n: fenceRun.n,
          lineLen,
        };
      }
    }

    if (!hit) {
      const ev = paint(state, buf);
      if (ev) yield ev;
      buf = "";
      break;
    }

    if (hit.at > 0) {
      const ev = paint(state, buf.slice(0, hit.at));
      if (ev) yield ev;
    }

    if (hit.k === "to") {
      state.channel = "reasoning";
      buf = buf.slice(hit.at + hit.len);
      continue;
    }
    if (hit.k === "tc") {
      state.channel = "prose";
      buf = buf.slice(hit.at + hit.len);
      continue;
    }
    if (hit.k === "toolEndThink") {
      // Close reasoning; leave tool marker in buf for prose / absorb tool-hold
      state.channel = "prose";
      buf = buf.slice(hit.at);
      continue;
    }
    // fence open
    const lineText = buf.slice(hit.at, hit.at + hit.lineLen);
    const ev = paint(state, lineText);
    if (ev) yield ev;
    state.fence = { ch: hit.ch, n: hit.n };
    buf = buf.slice(hit.at + hit.lineLen);
  }

  return { toolSuppress: state.fence !== null };
}

/**
 * Non-mutating peek: does `text` close the ALREADY-OPEN `fence` (the same
 * closing rule feedChannels' own in-fence branch uses), and if so at what
 * (exclusive) offset? Returns null when the fence does not close within
 * `text` — OD-1 fail-open: the whole of `text` is still fence body, same
 * conclusion feedChannels itself would reach if fed this text.
 *
 * For absorb() (normalize-stream.ts): a piece can ARRIVE while
 * `channels.fence` is already true and ALSO carry that fence's own close
 * partway through — everything through the close is unconditionally fence
 * body, but whatever follows was never inside the fence and must get a
 * normal shot at tool-marker scanning rather than being textified along
 * with it. This lets the caller find that split point without running (or
 * duplicating) the real, state-mutating feedChannels pass.
 */
export function peekFenceClose(text: string, fence: { ch: string; n: number }, atLineStart: boolean): number | null {
  let pos = 0;
  let lineIsStart = atLineStart;
  while (pos <= text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const hasNl = lineEnd !== -1;
    const line = hasNl ? text.slice(pos, lineEnd) : text.slice(pos);
    if (lineIsStart) {
      // Mirror incompleteSuffix: a trailing run of the fence's OWN char
      // with no newline after it yet might still be extending (a chunk
      // boundary could add more of the same char) — defer rather than
      // decide, exactly like the real hold does before feedChannels ever
      // sees this text.
      const stillGrowing = !hasNl && line.length > 0 && line.at(-1) === fence.ch;
      if (!stillGrowing) {
        const fm = matchFenceLine(line.replace(/\r$/, ""));
        if (fm && fm.ch === fence.ch && fm.n >= fence.n && /^[ \t]*[`~]{3,}[ \t]*$/.test(line)) {
          return hasNl ? lineEnd + 1 : text.length;
        }
      }
    }
    if (!hasNl) return null;
    pos = lineEnd + 1;
    lineIsStart = true;
  }
  return null;
}

export function* flushChannelHold(state: ChannelState): Generator<Out> {
  if (!state.hold) return;
  const ev = paint(state, state.hold);
  state.hold = "";
  if (ev) yield ev;
}

function incompleteSuffix(buf: string, state: ChannelState): number {
  // If ends with partial think tag / fence / tool open, hold it across chunks.
  // Tool open hold matters most in reasoning (pass mode / feedChannels-only paths)
  // so a split `<tool` + `_call>` still ends think at the complete marker.
  let holdFrom = buf.length;
  const tails: string[] = ["<", "</"];
  // Trailing run of backticks or tildes: fences are ANY run length ≥ 3, so a
  // run could still be extending (a 5th/6th backtick may be in the next
  // chunk) — hold the WHOLE contiguous run, never just a fixed 1-3 char
  // suffix. A fixed-length tail list (the previous "`"/"``"/"```" entries)
  // only ever holds the last ≤3 chars: a run of exactly 4+ would have its
  // leading char(s) released as "safe" on their own, fragmenting one
  // physical fence-delimiter line across two feedChannels calls and losing
  // the true run length (`fm.n`) the fence open/close comparison needs.
  if (buf.length > 0) {
    const last = buf.at(-1)!;
    if (last === "`" || last === "~") {
      let runStart = buf.length;
      while (runStart > 0 && buf[runStart - 1] === last) runStart--;
      holdFrom = Math.min(holdFrom, runStart);
    }
  }
  for (const t of state.thinkTags) {
    for (let i = 1; i < t.length + 2; i++) {
      tails.push(`<${t.slice(0, i)}`);
      tails.push(`</${t.slice(0, i)}`);
    }
  }
  for (const p of TOOL_OPEN_HOLD_PREFIXES) {
    for (let i = 1; i <= p.length; i++) {
      tails.push(p.slice(0, i));
    }
  }
  const lower = buf.toLowerCase();
  for (const t of tails) {
    const tl = t.toLowerCase();
    for (let k = 1; k <= tl.length; k++) {
      if (lower.endsWith(tl.slice(0, k))) {
        holdFrom = Math.min(holdFrom, buf.length - k);
      }
    }
  }
  return holdFrom;
}
