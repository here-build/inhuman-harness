/**
 * TTY lifecycle: ordered setup/teardown for alt-screen apps.
 * Single owner of mode brackets. Leave-alt is LAST.
 */

const ENTER_ALT = "\u001B[?1049h";
const ERASE_DISPLAY = "\u001B[2J";
const CUP_HOME = "\u001B[H";

export type TtyOptions = {
  /** Mode 2026 synchronized output — env-flag only for MVP (no DECRQM probe) */
  sync2026?: boolean;
  hideCursor?: boolean;
  noWrap?: boolean;
};

export type TtySession = {
  readonly entered: boolean;
  /** Ordered enter sequences (for tests / write) */
  enterBytes(): string;
  /**
   * Just the input-mode brackets, closed — mouse, paste, focus, kitty,
   * modifyOtherKeys. The leading part of {@link exitBytes}, available on its own
   * because it has to be written EARLIER than the rest: a host that drops raw
   * mode first hands the shell a terminal still reporting mouse events, and the
   * SGR bytes for the next click land as garbage on the prompt. Idempotent
   * (DECRST of an already-reset mode is a no-op), so writing it here and again
   * inside `exitBytes` costs nothing and keeps one spelling of the bytes.
   */
  inputModesOffBytes(): string;
  /** Ordered teardown — leave-alt last */
  exitBytes(): string;
  /**
   * CUP park. CSI row;colH is 1-based — a 0-based write parks off-screen.
   * Clamps to ≥1.
   */
  parkCursor(row: number, col: number): string;
  markEntered(): void;
  markExited(): void;
};

/**
 * Build a session. Does not touch process.stdout — caller writes.
 * Teardown order (TERMINAL L2/L3):
 *  1. keyboard / paste modes off (kitty pop, modifyOtherKeys, bracketed paste)
 *  2. ?2026l if was on
 *  3. CSI r (release scroll region)
 *  4. ?7h autowrap on
 *  5. ?25h show cursor
 *  6. CUP bottom + CR LF
 *  7. ?1049l leave alt LAST
 *
 * Keyboard / focus opt-in (OpenTUI / Ink / crossterm / Bubble Tea pattern):
 *  - CSI > 4 ; 2 m — xterm modifyOtherKeys mode 2 (Shift+Enter on partial
 *    terminals). Must precede kitty setup: iTerm clears kitty flags when
 *    modifyOtherKeys is enabled.
 *  - CSI > 31 u then CSI = 31 ; 1 u — kitty progressive: flag 1
 *    (disambiguate) | 2 (press / repeat / release) | 4 (shifted / base
 *    layout keys) | 8 (report all keys as escape codes) | 16 (associated
 *    text). Push so `CSI < u` restores the prior entry; SET is the spec's
 *    primary request (terminals that ignore push). Flag 8 delivers
 *    **Cmd/Super+letter** (e.g. Cmd+Z → CSI 122;9u) and isolated
 *    Super/Control as `{ type: "mod" }` (`CSI 57444;9u` press — super bit
 *    set). Flag 8 also stops UTF-8 letters — flag 16 puts the OS glyph in
 *    CSI field 3 so Shift/Caps/layout stay insertable. Flag 4 is the
 *    shifted-subfield fallback when field 3 is absent. Flag 2 is the
 *    release (`:3`) so the chrome modifier layer can drop. Decoder must
 *    accept plain CSI-u printables when this is on.
 *  - CSI ? 2004 h — bracketed paste
 *  - CSI ? 1004 h — focus in/out (CSI I / CSI O)
 *  - CSI ? 1000 h + ? 1002 h + ? 1006 h — SGR mouse press/release plus
 *    cell-motion-while-held, for drag-select (never ?1003 any-motion flood)
 *  - CSI ? 1007 h — alternate scroll: alt-screen wheel → cursor keys when
 *    mouse reporting is inactive (macOS Option is the native bypass)
 */
/**
 * The input-mode brackets, closed. A free function rather than a method so
 * `exitBytes` can reuse it without a `this` binding a destructured caller would
 * lose.
 */
function inputModesOff(): string {
  return [
    "\u001B[?1006l", // SGR mouse off
    "\u001B[?1002l", // cell-motion off
    "\u001B[?1000l", // mouse tracking off
    "\u001B[?1003l", // any-motion off (defensive)
    "\u001B[?1007l", // alternate scroll off
    "\u001B[?1004l", // focus report off
    "\u001B[?2004l", // bracketed paste off
    "\u001B[<u", // kitty keyboard pop
    "\u001B[>4;0m", // modifyOtherKeys off
  ].join("");
}

export function createTtySession(opts: TtyOptions = {}): TtySession {
  let entered = false;
  const sync2026 = opts.sync2026 === true;
  const hideCursor = opts.hideCursor !== false;
  const noWrap = opts.noWrap !== false;

  return {
    get entered() {
      return entered;
    },
    markEntered() {
      entered = true;
    },
    markExited() {
      entered = false;
    },
    enterBytes() {
      const parts: string[] = [ENTER_ALT, ERASE_DISPLAY, CUP_HOME];
      if (hideCursor) parts.push("\u001B[?25l");
      if (noWrap) parts.push("\u001B[?7l");
      if (sync2026) parts.push("\u001B[?2026h");
      // Input enhancements — ignored by unsupported terminals.
      // Enable the fallback first: iTerm clears kitty flags on this request.
      parts.push(
        "\u001B[>4;2m",
        "\u001B[>31u",
        "\u001B[=31;1u",
        "\u001B[?2004h",
        "\u001B[?1004h",
        "\u001B[?1000h",
        "\u001B[?1002h",
        "\u001B[?1006h",
        "\u001B[?1007h",
      );
      return parts.join("");
    },
    inputModesOffBytes() {
      return inputModesOff();
    },
    exitBytes() {
      // 1 keyboard / paste / focus / mouse off before paint teardown
      const parts: string[] = [
        inputModesOff(),
        mousePointerBytes("default"),
        "\u001B[?2026l",
        "\u001B[r",
        "\u001B[?7h",
        "\u001B[?25h",
        "\u001B[999;1H\r\n",
        "\u001B[?1049l",
      ];
      return parts.join("");
    },
    parkCursor(row: number, col: number) {
      const r = Math.max(1, Math.floor(row));
      const c = Math.max(1, Math.floor(col));
      return `\u001B[${r};${c}H`;
    },
  };
}

/**
 * Host-owned 1003 any-motion. `enterBytes` never sends this — hover flood
 * is scoped to slash-complete presence, and to copy-toast after its 3s arm
 * (move dismisses the plaque). Written on the edge only.
 *
 * 1000/1002/1003 are mutually exclusive. `1003l` does not fall back to
 * press+drag tracking — it drops mouse reporting entirely, so the
 * terminal keeps the pointer (system selection, 1007 wheel-as-arrows)
 * until the next `1003h`. Off re-asserts the enterBytes mouse set.
 */
export function mouseAnyMotionBytes(on: boolean): string {
  if (on) return "\u001B[?1003h";
  return "\u001B[?1003l\u001B[?1000h\u001B[?1002h\u001B[?1006h";
}

/**
 * OSC 22 pointer shape (CSS cursor names; kitty / ghostty / xterm).
 * `pointer` = clickable hit (`intent: activate`). `default` restores the
 * I-beam / arrow. Written on the edge only — `enterBytes` never sends this.
 * `exitBytes` restores default so the shell does not inherit a hand.
 *
 * Rejected: a `cursor` field on LayoutNode. TTY shape is host-owned, same
 * as 1003; the layout already says clickable via intent.
 */
export type MousePointerShape = "default" | "pointer";

export function mousePointerBytes(shape: MousePointerShape): string {
  return `\u001B]22;${shape}\u0007`;
}
