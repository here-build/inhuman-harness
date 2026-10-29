/**
 * Session-list label. The acting model writes it as a side-channel tool
 * call on the turn; display derives from surviving tape. Manual rename
 * lives on the session and outranks derivation.
 */
import {
  clampChars,
  isTitledOnlyCompletion as isTitledOnly,
  METADATA_SAME_ROUND_TEXT,
  SESSION_TITLE_MAX_CHARS,
  spokenResponseText,
} from "@inhuman.tools/activity";
import { prompt } from "@inhuman.tools/harness-commons";
import { computed, type IComputedValue } from "mobx";

import { CONTEXT_NEED_TOOL_NAME } from "./context-need.js";
import type { SessionRoot } from "./SessionRoot.js";
import { SessionSystemPrompt } from "./SessionSystemPrompt.js";
import { SessionTurn } from "./turn/session-turn.js";
import type { SessionUnit } from "./turn/types.js";

export {
  clampChars,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  UPDATE_METADATA_TOOL_NAME,
} from "@inhuman.tools/activity";

export const GLANCE_LAST_PROMPT_MAX_CHARS = 160;
export const GLANCE_ASK_DESCRIPTION_MAX_CHARS = 80;
export const GLANCE_ASK_LINE_MAX_CHARS = 120;
const FALLBACK_TITLE_MAX_CHARS = 48;
/** context_need is not a titled-only follow-up: an empty answer keeps the loop in the orchestrator; speech seals. */
const NO_FOLLOWUP_SIDE_CHANNEL_NAMES: ReadonlySet<string> = new Set([CONTEXT_NEED_TOOL_NAME]);

/** Catalog flags determine processing; names do not override admitted facts. */
export function jobTriggersReactLoop(job: {
  readonly name?: string;
  readonly triggersReactLoop?: boolean | null;
}): boolean {
  return job.triggersReactLoop !== false;
}

/** Host system line when the model titled in a round by itself. */
export const METADATA_SAME_ROUND_NOTE = prompt.system`${METADATA_SAME_ROUND_TEXT}`;

export function isTitledOnlyCompletion(chunk: {
  readonly responseText: string;
  readonly responseCalls: readonly { readonly name: string; readonly isSideChannel?: boolean }[];
}): boolean {
  return isTitledOnly(chunk, NO_FOLLOWUP_SIDE_CHANNEL_NAMES);
}

/**
 * A round whose only calls are `context_need`.
 * Empty speech keeps the loop. Speech seals it. Any other tool is not this case.
 */
export function contextNeedRound(chunk: {
  readonly responseText: string;
  readonly responseCalls: readonly { readonly name: string }[];
}): "keep" | "seal" | "other" {
  if (chunk.responseCalls.length === 0) return "other";
  if (!chunk.responseCalls.every((call) => call.name === CONTEXT_NEED_TOOL_NAME)) return "other";
  return spokenResponseText(chunk.responseText) === "" ? "keep" : "seal";
}

/** Collapse whitespace, then code-point clamp. No ellipsis. */
export function flattenOverviewLine(text: string, max: number): string {
  return clampChars(text.replaceAll(/\s+/g, " ").trim(), max);
}

const oldestPromptCache = new WeakMap<SessionTurn, IComputedValue<string>>();

/** Newest non-empty-after-trim `SessionTurn.prompt`. Whitespace-only newest is skipped. */
export function latestUserPrompt(unit: SessionUnit | null): string {
  const seen = new Set<SessionUnit>();
  let cell = unit;
  while (cell instanceof SessionTurn && !seen.has(cell)) {
    seen.add(cell);
    const trimmed = cell.prompt.trim();
    if (trimmed !== "") return clampChars(trimmed.replaceAll(/\s+/g, " ").trim(), GLANCE_LAST_PROMPT_MAX_CHARS);
    cell = cell.turnTail;
  }
  return "";
}

function oldestTurnPrompt(head: SessionTurn): string {
  let box = oldestPromptCache.get(head);
  if (box === undefined) {
    box = computed(() => {
      let oldest = "";
      const seen = new Set<SessionUnit>();
      let cell: SessionTurn | SessionSystemPrompt | null = head;
      while (cell instanceof SessionTurn && !seen.has(cell)) {
        seen.add(cell);
        if (cell.prompt.trim() !== "") oldest = cell.prompt;
        cell = cell.turnTail;
      }
      return oldest;
    });
    oldestPromptCache.set(head, box);
  }
  return box.get();
}

export function sessionDisplayTitle(root: Pick<SessionRoot, "manualTitle" | "head">): string {
  const manual = clampChars(root.manualTitle.trim(), SESSION_TITLE_MAX_CHARS);
  if (manual !== "") return manual;
  const titled = root.head?.metadata?.title;
  if (titled !== undefined) return titled;
  // Oldest prompt with text. A whitespace-only prompt does not title.
  const oldest = root.head instanceof SessionTurn ? oldestTurnPrompt(root.head) : "";
  const line =
    oldest
      .split(/\r?\n/)
      .map((row) => row.trim())
      .find((row) => row.length > 0) ?? "";
  const collapsed = line.replaceAll(/\s+/g, " ");
  if (collapsed.length <= FALLBACK_TITLE_MAX_CHARS) return collapsed;
  const cut = [...collapsed].slice(0, FALLBACK_TITLE_MAX_CHARS).join("");
  const space = cut.lastIndexOf(" ");
  const base = space > FALLBACK_TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut;
  return `${base.replace(/[ ,.;:—-]+$/u, "")}…`;
}
