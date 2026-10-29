import { describe, expect, it } from "vitest";

import {
  eventMatchesChord,
  formatHotkey,
  paintHotkeyChord,
  parseChord,
  revealHotkeys,
  type ChromeHotkey,
} from "../paint-hotkey.js";

const allow = (key: string, action: string): ChromeHotkey => ({ key, action });

describe("paintHotkeyChord", () => {
  it("maps Enter / Shift / Tab / Esc", () => {
    expect(paintHotkeyChord("Enter")).toBe("⏎");
    expect(paintHotkeyChord("Shift+Enter")).toBe("⇧ ⏎");
    expect(paintHotkeyChord("Tab")).toBe("⇥");
    expect(paintHotkeyChord("escape")).toBe("Esc");
  });

  it("maps Ctrl to ⌃ and Cmd to ⌘ with no platform map", () => {
    expect(paintHotkeyChord("Ctrl+Enter")).toBe("⌃ ⏎");
    expect(paintHotkeyChord("Ctrl+Shift+Enter")).toBe("⌃ ⇧ ⏎");
    expect(paintHotkeyChord("Cmd+Enter")).toBe("⌘ ⏎");
    expect(paintHotkeyChord("Ctrl+C")).toBe("⌃ C");
    expect(paintHotkeyChord("control-x")).toBe("⌃x");
    expect(paintHotkeyChord("C-x")).toBe("⌃x");
  });

  it("reveals Cmd/Ctrl chords only while the modifier is held", () => {
    const mixed = [
      allow("Enter", "Allow"),
      allow("Ctrl+Enter", "Allow this session"),
      allow("Ctrl+Shift+Enter", "Always allow"),
      allow("Esc", "Deny"),
    ];
    expect(revealHotkeys(mixed).map(formatHotkey)).toEqual(["Enter: Allow", "Esc: Deny", "Ctrl: More"]);
    expect(revealHotkeys(mixed, { modHeld: true }).map(formatHotkey)).toEqual([
      "Ctrl+Enter: Allow this session",
      "Ctrl+Shift+Enter: Always allow",
    ]);
    expect(revealHotkeys([allow("Enter", "Allow"), allow("Esc", "Deny")]).map(formatHotkey)).toEqual([
      "Enter: Allow",
      "Esc: Deny",
    ]);
    expect(revealHotkeys([allow("Ctrl+Enter", "Allow"), allow("Ctrl+Esc", "Deny")]).map(formatHotkey)).toEqual([
      "Ctrl+Enter: Allow",
      "Ctrl+Esc: Deny",
    ]);
    expect(revealHotkeys([allow("Enter", "Allow"), allow("Cmd+Enter", "Always")]).map(formatHotkey)).toEqual([
      "Enter: Allow",
      "Cmd: More",
    ]);
  });
});

describe("eventMatchesChord", () => {
  it("matches Ctrl/Cmd/Shift Enter and Esc exactly", () => {
    expect(eventMatchesChord({ key: "Enter", ctrl: true }, "Ctrl+Enter")).toBe(true);
    expect(eventMatchesChord({ key: "Enter" }, "Ctrl+Enter")).toBe(false);
    expect(eventMatchesChord({ key: "Enter", ctrl: true, shift: true }, "Ctrl+Enter")).toBe(false);
    expect(eventMatchesChord({ key: "Enter", ctrl: true, shift: true }, "Ctrl+Shift+Enter")).toBe(true);
    expect(eventMatchesChord({ key: "Enter", meta: true }, "Cmd+Enter")).toBe(true);
    expect(eventMatchesChord({ key: "Enter", ctrl: true }, "Cmd+Enter")).toBe(false);
    expect(eventMatchesChord({ key: "Escape", ctrl: true }, "Ctrl+Esc")).toBe(true);
    expect(eventMatchesChord({ key: "Escape" }, "Ctrl+Esc")).toBe(false);
    expect(eventMatchesChord({ key: "Enter", shift: true }, "Shift+Enter")).toBe(true);
  });

  it("accepts control-x / C-x catalog spelling", () => {
    expect(eventMatchesChord({ key: "x", ctrl: true }, "control-x")).toBe(true);
    expect(eventMatchesChord({ key: "x", ctrl: true }, "C-x")).toBe(true);
    expect(eventMatchesChord({ key: "x" }, "control-x")).toBe(false);
    expect(parseChord("Ctrl")).toBeNull();
  });
});
