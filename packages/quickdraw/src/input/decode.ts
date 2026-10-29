/**
 * The single decoder — raw terminal bytes to `InputEvent`s.
 *
 * Extracted from `widgets/surface`, whose remaining half still imports the
 * deprecated kernel. Everything here is pure: no sockets, no timers, no state
 * beyond the `pending` string a caller threads back in. That purity is the
 * reason the package exists — a decoder that a host must build the kernel to
 * use is a decoder every host is tempted to reimplement, and F12 (two decoders
 * disagreeing about a split escape sequence) is what reimplementation cost the
 * last tree.
 *
 * The one environment read is `QD_NO_LAYOUT_TABLE`, the non-Latin layout
 * ladder's kill switch — table and the kitty flag-4 base-layout-key
 * precision layer above it both — read live so a caller can toggle it per
 * call.
 */
import { parseOscColorPayload } from "../capabilities/parse.js";
import type { Rgb } from "../lexicon/color.js";

export type InputEvent =
  | { type: "char"; ch: string }
  | { type: "enter"; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }
  | { type: "shift_enter" }
  | { type: "esc"; shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }
  /** Bare Tab — autocomplete / cycle (host maps to key "Tab"). Not a draft glyph. */
  | { type: "tab" }
  /** Shift+Tab — host hotkey (policy cycle). Not a draft glyph. */
  | { type: "shift_tab" }
  | { type: "backspace" }
  | { type: "delete" }
  /**
   * Caret motion. `select: true` when Shift is held — extend draft selection
   * (browser textarea law). Plain motion collapses the selection.
   */
  | { type: "up"; select?: boolean }
  | { type: "down"; select?: boolean }
  | { type: "left"; select?: boolean }
  | { type: "right"; select?: boolean }
  | { type: "home"; select?: boolean }
  | { type: "end"; select?: boolean }
  | { type: "page_up" }
  | { type: "page_down" }
  | { type: "word_left"; select?: boolean }
  | { type: "word_right"; select?: boolean }
  | { type: "word_backspace" }
  | { type: "kill_to_start" }
  | { type: "kill_to_end" }
  | { type: "ctrl_c" }
  /** Ctrl+X — product hotkey (e.g. connect/drop). Not a draft kill. */
  | { type: "ctrl_x" }
  /** Ctrl+O / Cmd+O — live tape density (tool rows). Not a frozen overlay. */
  | { type: "ctrl_o" }
  /** Ctrl+V — paste. Host fills the clipboard body and lowers to `paste`. */
  | { type: "ctrl_v" }
  /** Ctrl+Z / Cmd+Z — draft undo (host lowers to named key). */
  | { type: "undo" }
  /** Ctrl+Y / Ctrl+Shift+Z — draft redo. */
  | { type: "redo" }
  /** Cmd+A — select the whole draft. Ctrl+A stays readline Home. */
  | { type: "select_all" }
  /** Bracketed paste body (already unwrapped from CSI 200~/201~). */
  | { type: "paste"; text: string }
  /** Terminal gained focus (`CSI I` with ?1004h). */
  | { type: "focus_in" }
  /** Terminal lost focus (`CSI O` with ?1004h). */
  | { type: "focus_out" }
  /**
   * OSC 11 ground (boot leftover or a live theme change). Host attunes;
   * never a draft glyph.
   */
  | { type: "osc_ground"; rgb: Rgb }
  /** Mode 2031 notification. Re-query actual ground; the mode is not a color. */
  | { type: "theme_changed" }
  /**
   * SGR mouse (`?1000h`+`?1006h`). col/row are **1-based** terminal cells.
   * Prefer acting on `release` (press-drag is selection, not click).
   */
  | {
      type: "mouse";
      button: number;
      col: number;
      row: number;
      release: boolean;
    }
  | { type: "unknown"; raw: string }
  /** Kitty report-all-keys: Control / Super press or release. Not a draft glyph. */
  | { type: "mod"; persist: true; down: boolean };
export type ConsumeKeysResult = {
  events: InputEvent[];
  /** Incomplete ESC/CSI tail held for the next stdin chunk. */
  pending: string;
};

/**
 * xterm / fixterms / kitty modifier parameter → bit flags.
 * Encoding: mod param = 1 + bits, where
 *   shift=1 · alt=2 · ctrl=4 · super=8 · hyper=16 · meta=32 (kitty extended).
 * On macOS, **Command is super (bit 8)**. We fold super|hyper|meta into
 * `meta` so Cmd/Win/Super report the same as our chord layer's "command key".
 */
type Mod = {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  capsLock: boolean;
};

function parseMod(n: number | undefined): Mod {
  const bits = Math.max(0, (n ?? 1) - 1);
  return {
    shift: (bits & 1) !== 0,
    alt: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    // super (8) | hyper (16) | kitty-meta (32) — all "host command" class
    meta: (bits & (8 | 16 | 32)) !== 0,
    capsLock: (bits & 64) !== 0,
  };
}

/**
 * Letter chords: Ctrl keeps full readline map; Super/Cmd alone is macOS-native
 * undo/redo/select-all (never Cmd+C → quit, never steal system copy).
 */
function letterChord(keycode: number, mod: Mod): InputEvent | null {
  const key = keycode >= 65 && keycode <= 90 ? keycode + 32 : keycode;
  if (key < 97 || key > 122) return null;
  if (mod.meta && !mod.ctrl) {
    if (key === 97) return { type: "select_all" };
    if (key === 111) return { type: "ctrl_o" };
    if (key === 122) return mod.shift ? { type: "redo" } : { type: "undo" };
    if (key === 121) return { type: "redo" };
    return null;
  }
  if (mod.ctrl) return ctrlLetter(key, mod);
  return null;
}

/**
 * Kitty keyboard-protocol functional keys 57442–57452 we persist as `mod`:
 * LEFT/RIGHT Control, Super, Meta (even ids). Not an inclusive range —
 * Shift/Alt/Hyper occupy the gaps; `key >= 57442 && key <= 57452` would
 * persist those as chrome `mod` too.
 */
function kittyPersistMod(key: number): boolean {
  return key === 57_442 || key === 57_444 || key === 57_446 || key === 57_448 || key === 57_450 || key === 57_452;
}

/**
 * Flag-16 associated text (`CSI … ; mod ; code[:code…] u`). Control
 * codepoints are rejected — the spec forbids them in this field.
 */
function parseAssociatedText(field: string | undefined): string | null {
  if (field === undefined || field === "") return null;
  const cps: number[] = [];
  for (const part of field.split(":")) {
    if (part === "") return null;
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0x20 || n === 0x7f || (n >= 0x80 && n <= 0x9f)) {
      return null;
    }
    cps.push(n);
  }
  if (cps.length === 0) return null;
  try {
    return String.fromCodePoint(...cps);
  } catch {
    return null;
  }
}

function isCasedLetter(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * Insert glyph from an unshifted CSI-u identity. Associated text (flag 16)
 * wins — it is the OS glyph (Caps, layout, dead keys). Else: letters use
 * shift XOR Caps; Shift on punctuation uses the flag-4 shifted subfield.
 */
function resolveGlyph(main: number, mod: Mod, keyField: KittyKeyField | undefined): string | null {
  let ch: string;
  try {
    ch = String.fromCodePoint(main);
  } catch {
    return null;
  }
  const cased = isCasedLetter(ch);
  const caps = cased && mod.capsLock;
  const wantShift = mod.shift !== caps;
  if (!wantShift) return ch;
  const shifted = keyField?.shifted;
  if (shifted !== undefined && shifted !== main) {
    try {
      return String.fromCodePoint(shifted);
    } catch {
      return ch;
    }
  }
  if (cased) {
    const upper = ch.toUpperCase();
    if ([...upper].length === 1) return upper;
  }
  return ch;
}

/** Printable CSI-u / modifyOtherKeys body when report-all-keys is on. */
function csiPrintable(key: number, mod: Mod, keyField?: KittyKeyField, associated?: string | null): InputEvent | null {
  if (mod.ctrl || mod.alt || mod.meta) return null;
  if (associated != null && associated !== "") return { type: "char", ch: associated };
  if (key === 9) return tabFamily(mod);
  if (key < 32 || key === 127) return null;
  // Kitty flag 8 reports functional keys (modifiers, F-keys, media) as BMP
  // PUA (U+E000–U+F8FF). LEFT_ALT is 57443 — inserting it, then repeating
  // it, floods the draft and the composer grows like a scroll.
  if (key >= 0xe0_00 && key <= 0xf8_ff) return null;
  const glyph = resolveGlyph(key, mod, keyField);
  if (glyph === null) return null;
  return { type: "char", ch: glyph };
}

function arrowFromFinal(final: string, mod: Mod): InputEvent | null {
  const base =
    final === "A" || final === "a"
      ? "up"
      : final === "B" || final === "b"
        ? "down"
        : final === "C" || final === "c"
          ? "right"
          : final === "D" || final === "d"
            ? "left"
            : final === "H" || final === "h"
              ? "home"
              : final === "F" || final === "f"
                ? "end"
                : null;
  if (!base) return null;

  // Word / line motions from modifiers (macOS terminals + xterm).
  // Shift is orthogonal: it marks "extend selection" without changing the motion.
  const select = mod.shift || undefined;
  if (base === "left") {
    if (mod.meta || (mod.ctrl && !mod.alt)) return { type: "home", select };
    if (mod.alt) return { type: "word_left", select };
    return { type: "left", select };
  }
  if (base === "right") {
    if (mod.meta || (mod.ctrl && !mod.alt)) return { type: "end", select };
    if (mod.alt) return { type: "word_right", select };
    return { type: "right", select };
  }
  if (base === "home" || base === "end" || base === "up" || base === "down") {
    return { type: base, select };
  }
  return { type: base };
}

/** First decimal of a CSI field (strip kitty `:subfields`). */
function csiFieldMain(field: string | undefined): number | undefined {
  if (field === undefined || field === "") return undefined;
  const main = field.split(":")[0]!;
  if (main === "") return undefined;
  const n = Number(main);
  return Number.isFinite(n) ? n : undefined;
}

/** Event type subfield of modifiers (`mod:type`) — 3 = release. */
function csiEventType(field: string | undefined): number {
  if (!field) return 1;
  const parts = field.split(":");
  if (parts.length < 2 || parts[1] === "") return 1;
  const t = Number(parts[1]);
  return Number.isFinite(t) ? t : 1;
}

function truthyMods(mod: Mod): Partial<Mod> {
  return {
    ...(mod.shift ? { shift: true as const } : {}),
    ...(mod.alt ? { alt: true as const } : {}),
    ...(mod.ctrl ? { ctrl: true as const } : {}),
    ...(mod.meta ? { meta: true as const } : {}),
  };
}

/** CSI / modifyOtherKeys Enter keeps modifiers. C0 newline fallbacks stay `shift_enter`. */
function enterFamily(mod: Mod): InputEvent {
  return { type: "enter", ...truthyMods(mod) };
}

function escFamily(mod: Mod): InputEvent {
  return { type: "esc", ...truthyMods(mod) };
}

function tabFamily(mod: Mod): InputEvent {
  return mod.shift ? { type: "shift_tab" } : { type: "tab" };
}

function backspaceFamily(mod: Mod): InputEvent {
  if (mod.meta) return { type: "kill_to_start" };
  if (mod.alt) return { type: "word_backspace" };
  return { type: "backspace" };
}

/**
 * Map Ctrl(+Shift)/Meta+letter from CSI-u keycode (lowercase codepoint).
 * `mod` carries shift so Ctrl+Shift+Z is redo rather than undo.
 */
function ctrlLetter(keycode: number, mod: Mod): InputEvent | null {
  switch (keycode) {
    case 99:
      return { type: "ctrl_c" };
    case 120:
      return { type: "ctrl_x" };
    case 111:
      return { type: "ctrl_o" };
    case 118:
      return { type: "ctrl_v" };
    case 97:
      return { type: "home" };
    case 101:
      return { type: "end" };
    case 117:
      return { type: "kill_to_start" };
    case 107:
      return { type: "kill_to_end" };
    case 119:
      return { type: "word_backspace" };
    case 100:
      return { type: "delete" };
    case 106:
      return { type: "shift_enter" };
    case 109:
      // CSI-u 109 is Ctrl+M, not C0 CR. Enter preserves modifiers.
      return { type: "enter" };
    case 122:
      return mod.shift ? { type: "redo" } : { type: "undo" };
    case 121:
      return { type: "redo" };
    default:
      return null;
  }
}

// ── Non-Latin keyboard layouts (physical-key translation, Ctrl/Alt only) ────

/**
 * CSI-u reports the codepoint the OS layout actually produces, not the
 * physical key pressed. On a Cyrillic (ЙЦУКЕН) layout, Ctrl+С sends the
 * codepoint for Cyrillic "с" (CSI 1089;5u) — not Latin "c" — so the Latin
 * gate below (`key >= 97 && key <= 122`) never matches and the shortcut is
 * silently dropped. This table maps each non-Latin letter to the Latin key
 * sitting under the same finger, so Ctrl/Alt shortcuts work regardless of
 * the active layout.
 *
 * One Record per layout, keyed by name — a new layout is a new entry here,
 * not a new branch (see NON_LATIN_LAYOUTS / physicalLatinKeycode below).
 *
 * This table stays load-bearing even where kitty progressive-enhancement
 * flag 4 (report alternate keys) is negotiated: flag 4 reaches only a
 * minority of sessions (no multiplexer forwards it, several terminals never
 * request it, and iTerm2 requests it but drops the field on exactly the
 * layouts that need it — see baseLayoutKeycode). Flag 4's base-layout key
 * is a precision upgrade layered above this table, never a replacement for
 * it — see physicalLatinKeycode's precedence order.
 */
const RU_YCUKEN: Record<string, string> = {
  й: "q",
  ц: "w",
  у: "e",
  к: "r",
  е: "t",
  н: "y",
  г: "u",
  ш: "i",
  щ: "o",
  з: "p",
  х: "[",
  ъ: "]",
  ф: "a",
  ы: "s",
  в: "d",
  а: "f",
  п: "g",
  р: "h",
  о: "j",
  л: "k",
  д: "l",
  ж: ";",
  э: "'",
  я: "z",
  ч: "x",
  с: "c",
  м: "v",
  и: "b",
  т: "n",
  ь: "m",
  б: ",",
  ю: ".",
  ё: "`",
};

/** Add a layout by adding an entry here — no code changes needed elsewhere. */
const NON_LATIN_LAYOUTS: Record<string, Record<string, string>> = {
  ru_yciken: RU_YCUKEN,
};

/**
 * Flattened codepoint → Latin-key codepoint, built once from
 * NON_LATIN_LAYOUTS. Both cases of every letter map to the same lowercase
 * Latin target (`.toUpperCase()` derives the uppercase entry) since
 * downstream matching (ctrlLetter, etc.) only looks at lowercase 97-122.
 */
const LAYOUT_CODEPOINTS: Map<number, number> = (() => {
  const m = new Map<number, number>();
  for (const table of Object.values(NON_LATIN_LAYOUTS)) {
    for (const [ch, latin] of Object.entries(table)) {
      const latinCode = latin.codePointAt(0)!;
      m.set(ch.codePointAt(0)!, latinCode);
      const upper = ch.toUpperCase();
      if (upper !== ch) m.set(upper.codePointAt(0)!, latinCode);
    }
  }
  return m;
})();

/**
 * Kitty CSI-u key field (`parts[0]`) subfields: `unicode-key-code[:shifted-
 * key[:base-layout-key]]`. Flag 4 (report alternate keys) is what populates
 * subfield 2 — the physical key's codepoint in the terminal's *base* layout,
 * resolved by the terminal itself rather than a static table here. Absent
 * on every terminal that doesn't request/honor flag 4, and — critically —
 * absent on iTerm2 for exactly the Cyrillic case we need it for (see
 * baseLayoutKeycode below).
 */
type KittyKeyField = { main: number; shifted?: number; base?: number };

function parseKittyKeyField(field: string | undefined): KittyKeyField | undefined {
  if (field === undefined || field === "") return undefined;
  const subs = field.split(":");
  const main = Number(subs[0]);
  if (!Number.isFinite(main)) return undefined;
  const toNum = (s: string | undefined): number | undefined => {
    if (s === undefined || s === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  return { main, shifted: toNum(subs[1]), base: toNum(subs[2]) };
}

/**
 * Precision layer above the static layout table: the kitty flag-4
 * base-layout-key subfield, when present and the emitter looks conformant.
 *
 * Two failure shapes this guards against, both researched and binding (do
 * not re-derive):
 *  - **Absence is normal, not an error.** No multiplexer forwards flag 4;
 *    most terminals never requested it; iTerm2 requests it but derives the
 *    subfield from the *current* layout with modifiers stripped, so on a
 *    Cyrillic layout it emits nothing for exactly the keys that need it.
 *    Absence always falls through — to the static table, silently.
 *  - **`main == shifted` marks a nonconformant emitter.** A terminal that
 *    echoes the same codepoint for both subfields isn't computing the
 *    shifted variant at all, so its base-layout claim can't be trusted
 *    either — fall through to the table rather than act on a fabricated
 *    value. (Only rejects when a shifted subfield is actually present;
 *    subfield 1 being merely absent is the ordinary case above, not this
 *    one.)
 *
 * Never branch on negotiated capabilities (a terminal can echo flags it
 * doesn't honor) — only on this field's actual shape.
 */
function baseLayoutKeycode(keyField: KittyKeyField | undefined): number | null {
  if (keyField?.base === undefined) return null;
  if (keyField.shifted !== undefined && keyField.shifted === keyField.main) return null;
  return keyField.base;
}

/**
 * Resolve the physical Latin keycode for a Ctrl/Alt/Meta chord, in
 * precedence order: base-layout key (flag 4, when present and sane) →
 * static layout table → raw codepoint. NEVER applies without ctrl/alt/meta
 * — bare typing (no modifier) always passes `rawKey` through untouched, so
 * normal composing on a Cyrillic/etc. layout reaches the composer exactly
 * as typed. QD_NO_LAYOUT_TABLE=1 disables the whole ladder (base-layout key
 * included, not just the table) — read live, not cached, so callers/tests
 * can toggle it per-call.
 */
function physicalLatinKeycode(rawKey: number, keyField: KittyKeyField | undefined, mod: Mod): number {
  // Ctrl/Alt/Super(Cmd) chords need the physical Latin key under the finger.
  if (!mod.ctrl && !mod.alt && !mod.meta) return rawKey;
  if (process.env.QD_NO_LAYOUT_TABLE === "1") return rawKey;
  const base = baseLayoutKeycode(keyField);
  if (base !== null) return base;
  return LAYOUT_CODEPOINTS.get(rawKey) ?? rawKey;
}

/**
 * Decode CSI params + final byte.
 * Covers: arrows, ~ editing keys, kitty/fixterms CSI u, xterm modifyOtherKeys (27;mod;key~).
 */
function mapCsi(params: string, final: string): InputEvent | null {
  if (final === "n" && (params === "?997;1" || params === "?997;2")) return { type: "theme_changed" };
  const parts = params.length > 0 ? params.split(";") : [];
  const p0 = csiFieldMain(parts[0]);
  const p1 = csiFieldMain(parts[1]);
  const p2 = csiFieldMain(parts[2]);
  const eventType = csiEventType(parts[1] ?? parts[0]);
  // Persist-modifier release must reach chrome; other releases stay silent.
  if (eventType === 3) {
    if (final === "u" && kittyPersistMod(csiFieldMain(parts[0]) ?? 0)) {
      return { type: "mod", persist: true, down: false };
    }
    return null;
  }

  // Focus report (?1004h): bare CSI I / CSI O only — not CSI 1;2I etc.
  if (final === "I" && parts.length === 0) return { type: "focus_in" };
  if (final === "O" && parts.length === 0) return { type: "focus_out" };

  // SGR mouse: CSI < btn ; col ; row M (press) / m (release)
  // Wheel: button 64 = up, 65 = down (bit 6 set). Keep full code.
  if ((final === "M" || final === "m") && params.startsWith("<")) {
    const fields = params.slice(1).split(";");
    const btn = Number(fields[0]);
    const col = Number(fields[1]);
    const row = Number(fields[2]);
    if (Number.isFinite(btn) && Number.isFinite(col) && Number.isFinite(row) && col >= 1 && row >= 1) {
      return {
        type: "mouse",
        button: Math.floor(btn),
        col: Math.floor(col),
        row: Math.floor(row),
        release: final === "m",
      };
    }
    return null;
  }

  // Cursor / editing keys: CSI A–D / H / F, optionally CSI 1;<mod>A–D
  if ("ABCDHFf".includes(final)) {
    if (parts.length >= 2) return arrowFromFinal(final, parseMod(p1));
    if (parts.length === 1 && p0 !== undefined && p0 > 1 && p0 < 20) {
      return arrowFromFinal(final, parseMod(p0));
    }
    return arrowFromFinal(final, parseMod(1));
  }

  // Kitty / fixterms CSI u: CSI <keycode>[;mod] u
  // Shift+Enter: CSI 13;2u · Ctrl+C: CSI 99;5u · Cmd+Z: CSI 122;9u (super)
  if (final === "u") {
    const keyField = parseKittyKeyField(parts[0]);
    const rawKey = keyField?.main ?? p0 ?? 0;
    const mod = parseMod(p1 ?? 1);
    // Non-Latin layout (e.g. ЙЦУКЕН Ctrl+С = CSI 1089;5u) → physical Latin
    // key before any of the matching below — see physicalLatinKeycode.
    // Precedence: flag-4 base-layout key (keyField.base) → static table →
    // raw codepoint.
    const key = physicalLatinKeycode(rawKey, keyField, mod);
    const associated = parseAssociatedText(parts[2]);
    if (kittyPersistMod(rawKey)) return { type: "mod", persist: true, down: true };
    if (key === 13) return enterFamily(mod);
    if (key === 27) return escFamily(mod);
    if (key === 127) return backspaceFamily(mod);
    if (key === 9) return tabFamily(mod);
    // Ctrl+letter (full map) or Super/Cmd+Z/Y (undo/redo only).
    const chord = letterChord(key, mod);
    if (chord) return chord;
    // report_all_keys: plain / shift-only letters arrive as CSI-u too.
    // Identity stays unshifted (`key` / `rawKey`); insert uses associated
    // text, then shifted subfield, then shift XOR Caps on letters.
    return csiPrintable(rawKey, mod, keyField, associated);
  }

  // ~ family: CSI n~ · CSI n;<mod>~ · CSI 27;<mod>;<key>~ (modifyOtherKeys)
  if (final === "~") {
    // xterm modifyOtherKeys: CSI 27 ; <mod> ; <keycode> ~
    if (p0 === 27 && p2 !== undefined) {
      const mod = parseMod(p1);
      const key = p2;
      if (key === 13) return enterFamily(mod);
      if (key === 27) return escFamily(mod);
      if (key === 127 || key === 8) return backspaceFamily(mod);
      const chord = letterChord(key, mod);
      if (chord) return chord;
      return csiPrintable(key, mod);
    }

    const code = p0 ?? 0;
    const mod = parseMod(p1);
    const PAGE_UP = 5;
    const PAGE_DOWN = 6;
    const ENTER = 13;
    switch (code) {
      case 1:
      case 7:
        return mod.alt ? { type: "word_left" } : { type: "home" };
      case 4:
      case 8:
        return mod.alt ? { type: "word_right" } : { type: "end" };
      case 3:
        return { type: "delete" };
      case PAGE_UP:
        return { type: "page_up" };
      case PAGE_DOWN:
        return { type: "page_down" };
      case ENTER:
        return enterFamily(mod);
      case 200:
      case 201:
        // Bracketed paste markers handled in consumeKeys (need body)
        return null;
      default:
        return null;
    }
  }

  const BACK_TAB = "Z";
  if (final === BACK_TAB) return { type: "shift_tab" };

  return null;
}

export function normalizePaste(text: string): string {
  let t = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  // Leading vs trailing: strip leading *blank lines* only (first content
  // line keeps indent for the dedent pass). Trailing strips newlines +
  // spaces/tabs at end of paste.
  t = t.replace(/^(?:[ \t]*\n)+/u, "").replace(/[\n \t]+$/u, "");
  if (!t) return "";

  const lines = t.split("\n");
  let minIndent: number | null = null;
  for (const line of lines) {
    if (/^[ \t]*$/.test(line)) continue; // blank / whitespace-only: ignore
    const m = /^[ \t]*/.exec(line);
    const n = m ? m[0].length : 0;
    if (minIndent === null || n < minIndent) minIndent = n;
  }
  if (minIndent !== null && minIndent > 0) {
    return lines
      .map((line) => {
        if (/^[ \t]*$/.test(line)) return "";
        return line.slice(minIndent!);
      })
      .join("\n");
  }
  return t;
}

/**
 * Max OSC body length (bytes after `ESC ]`) before an unterminated sequence is
 * abandoned. Capability replies (OSC 10/11 rgb, …) are tens of bytes; without
 * this bound a lone malformed `ESC ]…` with no BEL/ST holds every subsequent
 * keystroke in `pending` forever (unlike lone-ESC, which the host can flush).
 * Fail-safe: drop the runaway OSC prefix and resume decoding at the bound.
 */
export const MAX_OSC_BODY = 512;

// Ctrl-Z in raw mode → undo, never SIGTSTP.
// macOS TTY: readline C0 stands in for Cmd-* (Ctrl-U = Cmd-Backspace).
// Ctrl-D always emits `delete` (forward-delete). Cooked EOT/EOF is not this path.
const C0_EVENTS: Partial<Record<number, InputEvent>> = {
  0x01: { type: "home" },
  0x04: { type: "delete" },
  0x05: { type: "end" },
  0x0b: { type: "kill_to_end" },
  0x0f: { type: "ctrl_o" },
  0x15: { type: "kill_to_start" },
  0x16: { type: "ctrl_v" },
  0x17: { type: "word_backspace" },
  0x18: { type: "ctrl_x" },
  0x19: { type: "redo" },
  0x1a: { type: "undo" },
};

/**
 * Stream-friendly raw stdin → InputEvents.
 * Incomplete ESC/CSI at the end is returned in `pending` (never inserted as text).
 */
function pushOscGround(out: InputEvent[], body: string): void {
  if (!body.startsWith("11;")) return;
  const rgb = parseOscColorPayload(body.slice(3));
  if (rgb) out.push({ type: "osc_ground", rgb });
}

export function consumeKeys(raw: string, pending = ""): ConsumeKeysResult {
  const s = pending + raw;
  const out: InputEvent[] = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);

    // ESC / CSI / SS3 / meta
    if (ch === "\u001B") {
      if (i + 1 >= s.length) {
        // Lone ESC at end of buffer — could be a real Esc keypress, or the
        // first byte of a CSI/SS3 sequence split across stdin chunks (arrow
        // keys arrive split under load: "\x1b" then "[C"). consumeKeys can
        // never tell those apart from the bytes alone, so it always holds —
        // resolving the ambiguity after a short quiet window is the HOST's
        // job (see flushPendingEsc). [F12]
        return { events: out, pending: s.slice(i) };
      }

      const n1 = s[i + 1]!;

      // OSC: ESC ] … BEL | ST (ESC \). Capability probes (OSC 11 ground, OSC 10
      // fg, OSC 52 replies if any host echoes them) land on stdin; without this
      // branch, ESC+] is treated as meta+']' (two bytes swallowed) and the
      // payload `11;rgb:…` is typed into the draft.
      if (n1 === "]") {
        let j = i + 2;
        const bodyStart = j;
        while (j < s.length) {
          // Bound: abandon runaway / unterminated OSC and resume decoding.
          if (j - bodyStart >= MAX_OSC_BODY) {
            i = j;
            break;
          }
          const c = s[j]!;
          // BEL terminator
          if (c === "\u0007") {
            pushOscGround(out, s.slice(bodyStart, j));
            i = j + 1;
            break;
          }
          // ST terminator: ESC \
          if (c === "\u001B" && j + 1 < s.length && s[j + 1] === "\\") {
            pushOscGround(out, s.slice(bodyStart, j));
            i = j + 2;
            break;
          }
          // Nested ESC without ST — hold (could be incomplete ST)
          if (c === "\u001B") {
            // Still respect the body bound if the held OSC is already huge.
            if (j - bodyStart >= MAX_OSC_BODY) {
              i = j;
              break;
            }
            return { events: out, pending: s.slice(i) };
          }
          j++;
        }
        if (j >= s.length) {
          // incomplete OSC under the body bound — wait for BEL/ST
          if (j - bodyStart >= MAX_OSC_BODY) {
            // body already maxed with no terminator: drop it, clear pending
            i = j;
            continue;
          }
          return { events: out, pending: s.slice(i) };
        }
        continue;
      }

      if (n1 === "[") {
        let j = i + 2;
        while (j < s.length) {
          const c = s.charCodeAt(j);
          // final byte of CSI: 0x40–0x7E
          if (c >= 0x40 && c <= 0x7e) {
            const params = s.slice(i + 2, j);
            const final = s[j]!;

            // Bracketed paste: CSI 200~ … body … CSI 201~
            if (final === "~" && csiFieldMain(params.split(";")[0]) === 200) {
              const bodyStart = j + 1;
              const endMark = "\u001B[201~";
              const endAt = s.indexOf(endMark, bodyStart);
              if (endAt === -1) {
                return { events: out, pending: s.slice(i) };
              }
              const text = normalizePaste(s.slice(bodyStart, endAt));
              if (text.length > 0) out.push({ type: "paste", text });
              i = endAt + endMark.length;
              break;
            }
            // Stray paste-end
            if (final === "~" && csiFieldMain(params.split(";")[0]) === 201) {
              i = j + 1;
              break;
            }

            const ev = mapCsi(params, final);
            if (ev) out.push(ev);
            // else swallow unknown CSI (never inject residue as chars)
            i = j + 1;
            break;
          }
          // param/intermediate bytes: 0x20–0x3F (includes digits ; : < = > ?)
          if (c < 0x20 || c > 0x3f) {
            // malformed — drop ESC and continue
            i += 1;
            break;
          }
          j++;
        }
        if (j >= s.length) {
          // incomplete CSI
          return { events: out, pending: s.slice(i) };
        }
        continue;
      }

      // SS3: ESC O A|B|C|D|H|F
      if (n1 === "O") {
        if (i + 2 >= s.length) return { events: out, pending: s.slice(i) };
        const f = s[i + 2]!;
        const ev = arrowFromFinal(f, {
          shift: false,
          alt: false,
          ctrl: false,
          meta: false,
          capsLock: false,
        });
        if (ev) out.push(ev);
        i += 3;
        continue;
      }

      // Meta/Alt + key (common on macOS Option-as-Meta)
      if (n1 === "\u007F" || n1 === "\b") {
        out.push({ type: "word_backspace" });
        i += 2;
        continue;
      }
      // Alt+Enter → newline (Terminal.app Option-as-Meta workaround for Shift+Enter)
      if (n1 === "\r" || n1 === "\n") {
        out.push({ type: "shift_enter" });
        i += 2;
        continue;
      }
      if (n1 === "b" || n1 === "B") {
        out.push({ type: "word_left" });
        i += 2;
        continue;
      }
      if (n1 === "f" || n1 === "F") {
        out.push({ type: "word_right" });
        i += 2;
        continue;
      }
      // Unknown meta+printable — swallow pair (never inject ESC residue as text)
      if (n1 >= " " && n1 !== "\u007F") {
        i += 2;
        continue;
      }

      out.push({ type: "esc" });
      i += 1;
      continue;
    }

    // Ctrl-J (LF) → shift_enter: portable Shift+Enter. CR → enter; CRLF is one submit.
    if (ch === "\r") {
      out.push({ type: "enter" });
      i += s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      out.push({ type: "shift_enter" });
      i += 1;
      continue;
    }
    if (ch === "\u007F" || ch === "\b") {
      out.push({ type: "backspace" });
      i += 1;
      continue;
    }
    if (ch === "\u0003") {
      out.push({ type: "ctrl_c" });
      i += 1;
      continue;
    }
    const c0 = C0_EVENTS[code];
    if (c0) {
      out.push({ ...c0 });
      i += 1;
      continue;
    }

    if (ch === "\t") {
      out.push({ type: "tab" });
      i += 1;
      continue;
    }

    if (ch >= " ") {
      out.push({ type: "char", ch });
      i += 1;
      continue;
    }

    // Other C0 — ignore (never surface as unknown text)
    i += 1;
  }

  return { events: out.length > 0 ? out : [], pending: "" };
}

/**
 * Resolve a held ESC after the host's short quiet-window timeout elapses
 * with no further bytes. consumeKeys never does this itself — it cannot
 * distinguish "no more bytes are coming" from "more are about to arrive" —
 * so the timer belongs to the host (main.ts / storybook's main.ts both use
 * ~30ms). Only a bare "\x1b" tail resolves; any other pending shape
 * (incomplete CSI, empty) is returned untouched — it still needs more bytes,
 * or there was nothing pending to begin with.
 */
export function flushPendingEsc(pending: string): ConsumeKeysResult {
  if (pending === "\u001B") return { events: [{ type: "esc" }], pending: "" };
  return { events: [], pending };
}
