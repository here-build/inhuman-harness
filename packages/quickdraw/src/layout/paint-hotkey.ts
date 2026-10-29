/**
 * Stored chords stay `Enter` / `Ctrl` / `Cmd`. Paint writes ⏎ / ⌃ / ⌘.
 * `Ctrl` is ⌃; `Cmd` is ⌘. No platform map — Super is often not forwarded.
 * Modifier chords keep a spacer (`⌃ ⏎`, not `⌃+⏎`).
 */

/** One chrome binding. Producers hand the full list; paint decides the strip. */
export type ChromeHotkey = {
  readonly key: string;
  readonly action: string;
  /** Named dispatch event. Paint ignores it; Tea fires it when the chord matches. */
  readonly event?: string;
};

function token(part: string): string {
  switch (part.toLowerCase()) {
    case "enter":
    case "return":
      return "⏎";
    case "shift":
      return "⇧";
    case "cmd":
    case "command":
    case "meta":
    case "super":
      return "⌘";
    case "ctrl":
    case "control":
      return "⌃";
    case "tab":
      return "⇥";
    case "escape":
    case "esc":
      return "Esc";
    default:
      return part;
  }
}

/** One chord (`Ctrl+Shift+Enter`, `control-x`, `C-x`). */
export function paintHotkeyChord(chord: string): string {
  const painted = chord.replaceAll(/[A-Z][A-Z0-9]*/gi, token);
  return painted
    .replaceAll(/(^|\+)C-/gi, (_, lead: string) => `${lead}⌃-`)
    .replaceAll("+", " ")
    .replaceAll("⌃-", "⌃");
}

/** Cmd / Ctrl / `C-x` — the held-modifier layer. Shift-only is not. */
export function isModChord(key: string): boolean {
  const k = key.trim().toLowerCase();
  return /^(cmd|command|meta|super|ctrl|control)([+-]|$)/.test(k) || k.startsWith("c-");
}

export type ChordMods = {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
};

function normalizeKeyName(part: string): string {
  const p = part.toLowerCase();
  if (p === "esc" || p === "escape") return "Escape";
  if (p === "enter" || p === "return") return "Enter";
  if (p === "tab") return "Tab";
  if (p === "space") return " ";
  if ([...part].length === 1) return p;
  return part;
}

/**
 * Parse a stored chord (`Ctrl+Enter`, `Cmd+Shift+Esc`, `control-x`, `C-x`).
 * Modifier-only tokens (`Ctrl`) return null.
 */
export function parseChord(chord: string): ChordMods | null {
  const raw = chord.trim();
  if (raw === "") return null;
  let body = raw;
  let ctrl = false;
  let alt = false;
  let meta = false;
  let shift = false;
  if (/^c-/i.test(body) && !/^(ctrl|control|cmd|command)([+-]|$)/i.test(body)) {
    ctrl = true;
    body = body.slice(2);
  }
  const parts = body.split(/[+-]/).filter((part) => part.length > 0);
  let key: string | undefined;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "cmd":
      case "command":
      case "meta":
      case "super":
        meta = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      default:
        key = normalizeKeyName(part);
    }
  }
  if (key === undefined) return null;
  return { key, ctrl, alt, meta, shift };
}

export function eventMatchesChord(
  event: {
    readonly key: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly alt?: boolean;
    readonly shift?: boolean;
  },
  chord: string,
): boolean {
  const parsed = parseChord(chord);
  if (parsed === null) return false;
  return (
    event.key.toLowerCase() === parsed.key.toLowerCase() &&
    (event.ctrl === true) === parsed.ctrl &&
    (event.meta === true) === parsed.meta &&
    (event.alt === true) === parsed.alt &&
    (event.shift === true) === parsed.shift
  );
}

export function formatHotkey(hotkey: ChromeHotkey): string {
  const key = hotkey.key.trim();
  const action = hotkey.action.trim();
  if (key.length === 0) return "";
  return action.length > 0 ? `${key}: ${action}` : key;
}

function moreToken(mods: readonly ChromeHotkey[]): string {
  const word = (mods[0]?.key ?? "").trim().split(/[+-]/, 1)[0] ?? "";
  switch (word.toLowerCase()) {
    case "cmd":
    case "command":
    case "meta":
    case "super":
      return "Cmd";
    default:
      return "Ctrl";
  }
}

/**
 * Two-level strip. When a list has both bare and Cmd/Ctrl chords, paint
 * the bare set plus `Ctrl: More` (or `Cmd: More` if those chords start
 * with Cmd) until the modifier is held, then only the Cmd/Ctrl set.
 */
export function revealHotkeys(
  hotkeys: readonly ChromeHotkey[],
  input: { readonly modHeld?: boolean } = {},
): ChromeHotkey[] {
  const defaults: ChromeHotkey[] = [];
  const mods: ChromeHotkey[] = [];
  for (const hotkey of hotkeys) {
    if (isModChord(hotkey.key)) mods.push(hotkey);
    else defaults.push(hotkey);
  }
  if (defaults.length === 0 || mods.length === 0) return [...hotkeys];
  if (input.modHeld === true) return mods;
  return [...defaults, { key: moreToken(mods), action: "More", event: "more" }];
}
