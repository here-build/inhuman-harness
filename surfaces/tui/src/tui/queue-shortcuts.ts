/**
 * Busy-turn omnibox hint. Slash and ask covers own their own chords;
 * this list is only the leftover draft face.
 */
import { parseSuperKey, type SuperKey } from "@inhuman.tools/harness-model";
import type { ChromeHotkey } from "@inhuman.tools/quickdraw/layout";

import { HOTKEY_EVENT, superChord } from "./ask-shortcuts.js";

function hk(key: string, action: string, event: string): ChromeHotkey {
  return { key, action, event };
}

export function busyDraftShortcuts(input: {
  readonly draft: string;
  readonly queued: number;
  readonly retrying?: boolean;
  readonly superKey?: SuperKey;
}): ChromeHotkey[] | undefined {
  const retry = hk(superChord("Enter", parseSuperKey(input.superKey)), "retry now", HOTKEY_EVENT.retry);
  if (input.draft.trim() !== "") return [hk("Enter", "queue message", HOTKEY_EVENT.queueMessage)];
  if (input.queued > 0) {
    const steer = hk("Enter", "steer first", HOTKEY_EVENT.steerFirst);
    const retract = { key: "Esc", action: "retract last queued" };
    return input.retrying === true ? [steer, retry, retract] : [steer, retract];
  }
  if (input.retrying === true) return [retry];
  return undefined;
}
