export type ThinkSplit = {
  content: string;
  reasoning: string;
  /** Would-be tool markers inside reasoning (for toolsInThinkingCount). */
  reasoningToolHits: number;
};

const DEFAULT_TAGS = ["think", "thinking", "reason", "reasoning"];

/**
 * High-precision tool open markers (§8 / §9.4): unterminated think closes here.
 * Shared by batch splitThink and live stream-channels.
 */
export const TOOL_OPEN_RE_SOURCE = String.raw`<tool_call\b|<longcat[_-]?tool[_-]?call\b|<function\s*=|\[TOOL_CALLS\]`;

/** Fresh regex each call (global lastIndex is mutable). */
export function toolOpenRe(flags = "i"): RegExp {
  return new RegExp(TOOL_OPEN_RE_SOURCE, flags);
}

/**
 * Incomplete open prefixes to hold across stream chunks (defense in depth).
 * Keep in sync with TOOL_OPEN_RE_SOURCE forms.
 */
export const TOOL_OPEN_HOLD_PREFIXES: string[] = [
  "<tool_call",
  "<longcat_tool_call",
  "<longcat-tool-call",
  "<longcattoolcall",
  "<function=",
  "<function =",
  "[TOOL_CALLS]",
  "[tool_calls]",
];

function tagAlts(tags: string[]): string {
  return tags.map((t) => t.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|");
}

/** Count high-precision tool open markers in text. */
export function countToolMarkers(text: string): number {
  return (text.match(toolOpenRe("gi")) ?? []).length;
}

/**
 * Split think channel from content. Always strips tags from content.
 * Unterminated: close reasoning at first tool open marker.
 */
export function splitThink(content: string, thinkTags: string[] = DEFAULT_TAGS): ThinkSplit {
  if (!content) {
    return { content: "", reasoning: "", reasoningToolHits: 0 };
  }
  const alts = tagAlts(thinkTags.length > 0 ? thinkTags : DEFAULT_TAGS);
  const openRe = new RegExp(String.raw`<(${alts})\b[^>]*>`, "i");
  const closeRe = new RegExp(String.raw`</(${alts})\s*>`, "i");

  const reasoningParts: string[] = [];
  let remaining = content;
  let out = "";

  // Handle open-implied: closer without opener
  const firstClose = remaining.search(closeRe);
  const firstOpen = remaining.search(openRe);
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    const m = remaining.match(closeRe)!;
    const idx = remaining.indexOf(m[0]!);
    reasoningParts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx + m[0]!.length);
  }

  while (remaining.length > 0) {
    const om = remaining.match(openRe);
    if (om?.index === undefined) {
      out += remaining;
      break;
    }
    out += remaining.slice(0, om.index);
    remaining = remaining.slice(om.index + om[0].length);
    const cm = remaining.match(closeRe);
    if (cm?.index !== undefined) {
      reasoningParts.push(remaining.slice(0, cm.index));
      remaining = remaining.slice(cm.index + cm[0].length);
      continue;
    }
    // unterminated: close at first tool marker or EOS
    const toolHit = remaining.search(toolOpenRe("i"));
    if (toolHit >= 0) {
      reasoningParts.push(remaining.slice(0, toolHit));
      remaining = remaining.slice(toolHit);
    } else {
      reasoningParts.push(remaining);
      remaining = "";
    }
  }

  const reasoning = reasoningParts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
  return {
    content: out,
    reasoning,
    reasoningToolHits: countToolMarkers(reasoning),
  };
}

export function mergeReasoning(input: string | null | undefined, extracted: string): string | null {
  const a = (input ?? "").trim();
  const b = extracted.trim();
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a === b || a.endsWith(b)) return a;
  return `${a}\n${b}`;
}
