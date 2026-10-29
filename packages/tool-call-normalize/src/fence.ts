/**
 * Mask balanced ``` and ~~~ fences for tool scan.
 * Same-length replacement with spaces so offsets stay identity.
 *
 * Open / close use CommonMark-ish line prefix: optional blockquote `>`s,
 * then 0–3 spaces, then a run of 3+ backticks or tildes. Closer run length
 * must be ≥ opener. Mid-line open only after a tool-tag close `>` that ends
 * a known open-tag pattern (audit-007 F1 / audit-008 G1–G3).
 */

export type FenceMask = {
  masked: string;
};

const LINE_PREFIX = /^(?:> ?)*[ \t]{0,3}/;
const FENCE_RUN = /(`{3,}|~{3,})/;

/** Does `text` at `idx` start a fence run with valid line prefix? */
function fenceAtLine(text: string, idx: number): { fence: string; afterOpen: number } | null {
  // find start of line
  let lineStart = idx;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart--;
  const lineHead = text.slice(lineStart, idx);
  if (!LINE_PREFIX.test(lineHead) || LINE_PREFIX.exec(lineHead)![0].length !== lineHead.length) {
    return null;
  }
  const m = FENCE_RUN.exec(text.slice(idx));
  if (!m || m.index !== 0) return null;
  const fence = m[1]!;
  return { fence, afterOpen: idx + fence.length };
}

/** Mid-line open after a tool arg open-tag close: ...arg_value>``` or ...parameter=x> ``` */
function midLineToolTagOpen(text: string, idx: number): { fence: string; afterOpen: number } | null {
  if (idx === 0 || text[idx - 1] !== ">") return null;
  // Require the `>` to close a tool-ish open tag, not `</think>` / `</p>`.
  // `before` ends at the `>` (exclusive of fence start at idx).
  const before = text.slice(Math.max(0, idx - 80), idx);
  if (!/<(?:longcat[_-]?arg[_-]?value\s*|parameter\s*=[^>]*)>$/i.test(before)) {
    return null;
  }
  const m = FENCE_RUN.exec(text.slice(idx));
  if (!m || m.index !== 0) return null;
  return { fence: m[1]!, afterOpen: idx + m[1]!.length };
}

export function maskFences(
  text: string,
  opts?: {
    /**
     * Default (false/omitted) is "unbalanced fail-open": a fence run with
     * no discovered close is left untouched, matching the whole-message
     * batch scan where the complete text is always available and an
     * unpaired run really is just stray backticks.
     *
     * `failClosed: true` is for scanning a body that is STILL STREAMING IN
     * (dialect step()'s in-progress hold): an unclosed run there is
     * genuinely ambiguous — it may still be extended by the next chunk, or
     * turn into a real fence once its own close arrives — so mask from the
     * run's open through the end of `text` (defer the decision) rather
     * than leaving it unmasked (which would let e.g. a bare "```" line
     * read as a tool-call name line before its surrounding fence is known
     * to exist).
     */
    failClosed?: boolean;
  },
): FenceMask {
  if (!text) return { masked: text };
  const matches: Array<{ start: number; end: number }> = [];
  const opens: Array<{
    start: number;
    fence: string;
    afterOpen: number;
    ch: string;
    n: number;
  }> = [];

  // Scan for candidate open positions: line-start fence or mid-line after tool tag
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "`" && ch !== "~") continue;
    // skip if previous char is same (mid-run)
    if (i > 0 && text[i - 1] === ch) continue;
    const atLine = fenceAtLine(text, i);
    const mid = atLine ? null : midLineToolTagOpen(text, i);
    const hit = atLine ?? mid;
    if (!hit) continue;
    opens.push({
      start: i,
      fence: hit.fence,
      afterOpen: hit.afterOpen,
      ch: hit.fence[0]!,
      n: hit.fence.length,
    });
    // advance past this run
    i = hit.afterOpen - 1;
  }

  const used = new Set<number>();
  for (let i = 0; i < opens.length; i++) {
    if (used.has(i)) continue;
    const o = opens[i]!;
    // skip info string until newline
    let contentStart = o.afterOpen;
    while (contentStart < text.length && text[contentStart] !== "\n" && text[contentStart] !== "\r") {
      contentStart++;
    }
    if (text[contentStart] === "\r") contentStart++;
    if (text[contentStart] === "\n") contentStart++;

    // Find matching close: line-prefix + same char run of length ≥ open
    let closeStart = -1;
    let closeEnd = -1;
    let pos = contentStart;
    while (pos < text.length) {
      // jump to next potential fence char
      const idxTick = text.indexOf(o.ch, pos);
      if (idxTick === -1) break;
      // skip mid-run
      if (idxTick > 0 && text[idxTick - 1] === o.ch) {
        pos = idxTick + 1;
        continue;
      }
      const closeHit = fenceAtLine(text, idxTick);
      if (closeHit && closeHit.fence[0] === o.ch && closeHit.fence.length >= o.n) {
        closeStart = idxTick;
        closeEnd = closeHit.afterOpen;
        // absorb trailing whitespace/newline
        while (closeEnd < text.length && (text[closeEnd] === " " || text[closeEnd] === "\t")) closeEnd++;
        if (text[closeEnd] === "\r") closeEnd++;
        if (text[closeEnd] === "\n") closeEnd++;
        break;
      }
      pos = idxTick + 1;
    }
    if (closeStart < 0) {
      if (opts?.failClosed) {
        // Defer: mask from the unclosed open through end of text (§ above).
        for (let j = i + 1; j < opens.length; j++) {
          if (opens[j]!.start >= o.start) used.add(j);
        }
        matches.push({ start: o.start, end: text.length });
        used.add(i);
      }
      continue; // unbalanced fail-open (default)
    }
    for (let j = i + 1; j < opens.length; j++) {
      if (opens[j]!.start >= o.start && opens[j]!.start < closeEnd) used.add(j);
    }
    matches.push({ start: o.start, end: closeEnd });
    used.add(i);
  }

  if (matches.length === 0) return { masked: text };
  const chars = text.split("");
  for (const { start, end } of matches) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return { masked: chars.join("") };
}
