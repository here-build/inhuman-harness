import { eventMatchesChord } from "@inhuman.tools/quickdraw/layout";
import { describe, expect, it } from "vitest";

import { askCoverShortcuts, HOTKEY_EVENT, isPersistMod } from "../ask-shortcuts.js";

describe("ask cover shortcuts", () => {
  it("matches persist-mod and enumerates cover chords", () => {
    const [allow, deny] = askCoverShortcuts({ comment: true });
    expect({
      persistMod: {
        ctrl: isPersistMod({ ctrl: true }),
        meta: isPersistMod({ meta: true }),
        metaCmd: isPersistMod({ meta: true }, "cmd"),
        ctrlCmd: isPersistMod({ ctrl: true }, "cmd"),
      },
      chords: {
        empty: askCoverShortcuts({ comment: false }),
        remember: askCoverShortcuts({ comment: false, remember: "`git push` (any other arguments)" }),
        // a soft-deny offers nothing to remember: no remember chords, never an "Always"
        softDeny: askCoverShortcuts({ comment: false, remember: "" }),
        persistDeny: askCoverShortcuts({ comment: false, persistDeny: true }),
        widen: askCoverShortcuts({ comment: false, widen: "../docs" }),
        commentWiden: askCoverShortcuts({ comment: true, widen: "../docs" }),
        comment: askCoverShortcuts({ comment: true }),
        commentCmd: askCoverShortcuts({ comment: true, superKey: "cmd" }),
      },
      commentMatch: {
        allowEvent: allow?.event,
        ctrlEnter: eventMatchesChord({ key: "Enter", ctrl: true }, allow?.key ?? ""),
        enter: eventMatchesChord({ key: "Enter" }, allow?.key ?? ""),
        ctrlEsc: eventMatchesChord({ key: "Escape", ctrl: true }, deny?.key ?? ""),
      },
    }).toEqual({
      persistMod: { ctrl: true, meta: false, metaCmd: true, ctrlCmd: false },
      chords: {
        empty: [
          { key: "Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        remember: [
          { key: "Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          {
            key: "Ctrl+Enter",
            action: "Remember `git push` (any other arguments) this session",
            event: HOTKEY_EVENT.allowSession,
          },
          {
            key: "Ctrl+Shift+Enter",
            action: "Remember `git push` (any other arguments) in this project (7 days)",
            event: HOTKEY_EVENT.allowAlways,
          },
          { key: "Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        softDeny: [
          { key: "Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        persistDeny: [
          { key: "Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Esc", action: "Deny", event: HOTKEY_EVENT.deny },
          { key: "Ctrl+Esc", action: "Deny this session", event: HOTKEY_EVENT.denySession },
          { key: "Ctrl+Shift+Esc", action: "Deny forever", event: HOTKEY_EVENT.denyAlways },
        ],
        widen: [
          { key: "Enter", action: "Allow once", event: HOTKEY_EVENT.allow },
          { key: "Ctrl+Enter", action: "Treat ../docs as part of this session", event: HOTKEY_EVENT.allowWiden },
          { key: "Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        commentWiden: [
          { key: "Ctrl+Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Ctrl+Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        comment: [
          { key: "Ctrl+Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Ctrl+Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
        commentCmd: [
          { key: "Cmd+Enter", action: "Allow", event: HOTKEY_EVENT.allow },
          { key: "Cmd+Esc", action: "Deny", event: HOTKEY_EVENT.deny },
        ],
      },
      commentMatch: {
        allowEvent: HOTKEY_EVENT.allow,
        ctrlEnter: true,
        enter: false,
        ctrlEsc: true,
      },
    });
  });
});
