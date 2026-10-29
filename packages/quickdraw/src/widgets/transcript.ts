/**
 * Tape column chrome: band spacers and completion visibility.
 * No SessionTurn. Callers supply already-built children.
 */
import type { LayoutNode } from "../layout/index.js";

export type TranscriptBand = "input" | "work";

/**
 * Work-band slot. Thought and tool pack with each other; a 1-cell
 * margin sits against speech, prompt, and unslotted work.
 */
export type TranscriptSlot = "thought" | "speech" | "tool";

/** Thought and tool share a packed run; speech does not. */
function packs(slot?: TranscriptSlot): boolean {
  return slot === "thought" || slot === "tool";
}

export type TranscriptPart = {
  readonly band: TranscriptBand;
  readonly slot?: TranscriptSlot;
  readonly key: string;
  readonly node: LayoutNode;
};

export function spacerRow(key: string, cols: number): LayoutNode {
  return {
    type: "box",
    key,
    style: { height: 1, width: cols },
    children: [],
  };
}

function isGap(node: LayoutNode | undefined): boolean {
  return typeof node?.key === "string" && node.key.startsWith("gap:");
}

function pushGap(children: LayoutNode[], key: string, width: number): void {
  if (isGap(children.at(-1))) return;
  children.push(spacerRow(key, width));
}

export function composeWork(
  key: string,
  width: number,
  thought: LayoutNode | undefined,
  speech: LayoutNode | undefined,
): LayoutNode | null {
  if (thought === undefined && speech === undefined) return null;
  if (thought !== undefined && speech !== undefined) {
    return {
      type: "box",
      key: `${key}:content`,
      children: [thought, spacerRow(`${key}:thought-gap`, width), speech],
    };
  }
  return thought ?? speech ?? null;
}

/**
 * One completion's visible tape slots. Failed text stays speech; empty
 * failed speech uses the failure string. Empty live thought is not a tape
 * row — occupancy wait sits on `wait:pin` above the omnibox.
 */
export function completionSlots(input: {
  readonly live: boolean;
  readonly failed: boolean;
  readonly workerPresent: boolean;
  readonly homed?: boolean;
  readonly speech: string;
  readonly thought: string;
  readonly failure: string;
}): {
  readonly showThought: boolean;
  readonly emptyLiveThought: boolean;
  readonly bootstrapping: boolean;
  readonly showSpeech: boolean;
  readonly showFailure: boolean;
  readonly speechText: string;
  readonly failureText: string;
} {
  const homed = input.homed !== false;
  const speechText = input.speech === "" ? "" : input.speech;
  const failureText = input.failed && speechText === "" ? input.failure.trim() || "turn failed" : "";
  const showThought = input.thought.trim() !== "";
  const showSpeech = speechText !== "";
  const showFailure = failureText !== "";
  const empty = !showThought && !showSpeech && !showFailure && input.live && homed;
  const bootstrapping = empty && !input.workerPresent;
  const emptyLiveThought = empty && input.workerPresent;
  return {
    showThought,
    emptyLiveThought,
    bootstrapping,
    showSpeech,
    showFailure,
    speechText,
    failureText,
  };
}

export function hasThoughtRow(slots: ReturnType<typeof completionSlots>): boolean {
  return slots.showThought;
}

/** Each user floor can stick while its turn owns the top row. Recap chrome is not a box. */
function stickUserTurns(parts: readonly TranscriptPart[]): readonly TranscriptPart[] {
  if (!parts.some((part) => part.band === "input" && part.node.type === "box")) return parts;
  return parts.map((part) => {
    if (part.band !== "input" || part.node.type !== "box") return part;
    return { ...part, node: { ...part.node, style: { ...part.node.style, sticky: "top" } } };
  });
}

export function transcriptColumn(parts: readonly TranscriptPart[], width: number): LayoutNode {
  const seated = stickUserTurns(parts);
  const children: LayoutNode[] = [];
  let prev: TranscriptBand | null = null;
  let prevSlot: TranscriptSlot | undefined;
  for (let i = 0; i < seated.length; i++) {
    const part = seated[i]!;
    const next: TranscriptPart | undefined = seated[i + 1];
    if (prev !== null && prev !== part.band) {
      pushGap(children, `gap:${prev}-${part.band}:${part.key}`, width);
    }
    if (part.slot === "thought" && children.length > 0 && !packs(prevSlot)) {
      pushGap(children, `gap:thought-before:${part.key}`, width);
    } else if (part.slot === "tool" && children.length > 0 && !packs(prevSlot)) {
      pushGap(children, `gap:tools-before:${part.key}`, width);
    }
    children.push(part.node);
    if (part.slot === "thought" && !packs(next?.slot)) {
      pushGap(children, `gap:thought-after:${part.key}`, width);
    } else if (part.slot === "tool" && !packs(next?.slot)) {
      pushGap(children, `gap:tools-after:${part.key}`, width);
    }
    prev = part.band;
    prevSlot = part.slot;
  }
  return {
    type: "box",
    key: "transcript:body",
    style: { width },
    userSelect: "text",
    children,
  };
}
