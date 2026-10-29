/**
 * Ask-cover shortcut chrome. Persist chords store `Ctrl` (`config.json`
 * `superKey`; `cmd` stores `Cmd`). Paint writes ⏎ / ⌃ / ⌘. Remember chords
 * only where the daemon offers a family to remember (an ask, never a soft-deny
 * or a block); "Treat <folder> as part of this session" on a suggested
 * extra-root read parent; deny-persist chords on a hidden MCP tool name.
 * Comment cover owns modifier Esc and does not remember or widen. Each binding
 * bears the named event Tea fires on a match.
 */
import { DEFAULT_SUPER_KEY, parseSuperKey, type SuperKey } from "@inhuman.tools/harness-model";
import type { ChromeHotkey } from "@inhuman.tools/quickdraw/layout";

export const HOTKEY_EVENT = {
  allow: "allow",
  deny: "deny",
  allowSession: "allow-session",
  allowAlways: "allow-always",
  allowWiden: "allow-widen",
  denySession: "deny-session",
  denyAlways: "deny-always",
  ackRemember: "ack-remember",
  ackNext: "ack-next",
  ackPrev: "ack-prev",
  retry: "retry",
  queueMessage: "queue-message",
  steerFirst: "steer-first",
  continue: "continue",
  clear: "clear",
  cancelTurn: "cancel-turn",
} as const;

export type HotkeyEvent = (typeof HOTKEY_EVENT)[keyof typeof HOTKEY_EVENT];

export function superChord(rest: string, superKey: SuperKey = DEFAULT_SUPER_KEY): string {
  return `${superKey === "cmd" ? "Cmd" : "Ctrl"}+${rest}`;
}

export function isPersistMod(
  event: { readonly ctrl?: boolean; readonly meta?: boolean },
  superKey: SuperKey = DEFAULT_SUPER_KEY,
): boolean {
  return superKey === "cmd" ? event.meta === true : event.ctrl === true;
}

function hk(key: string, action: string, event: HotkeyEvent): ChromeHotkey {
  return { key, action, event };
}

export function askCoverShortcuts(input: {
  readonly comment: boolean;
  /**
   * What a human yes to an ask can be remembered as (the daemon's offer for this exact call), in the
   * words the button shows. Empty for a soft-deny: it is licensed every time and nothing is remembered.
   */
  readonly remember?: string;
  readonly persistDeny?: boolean;
  /** Label of a suggested folder: "Treat <folder> as part of this session?" */
  readonly widen?: string;
  /**
   * The call is also flagged `needsAcknowledgement`. `ack`: the call is allowed and only the flag is asked
   * (Enter acknowledges, Esc refuses). `ask+ack`: the ask's yes settles the flag; a grant remember also
   * remembers it. `soft-deny+ack`: nothing of the soft-deny is remembered, the flag may be.
   * `choice` is the selected remember option as the chord shows it; `cycle` says there is more than one.
   */
  readonly ack?: {
    readonly variant: "ack" | "ask+ack" | "soft-deny+ack";
    readonly choice?: string;
    readonly cycle?: boolean;
  };
  readonly superKey?: SuperKey;
}): ChromeHotkey[] {
  const superKey = parseSuperKey(input.superKey);
  const ackOnly = input.ack?.variant === "ack";
  const yes = ackOnly ? "Acknowledge" : "Allow";
  const no = ackOnly ? "Refuse" : "Deny";
  if (input.comment) {
    return [
      hk(superChord("Enter", superKey), yes, HOTKEY_EVENT.allow),
      hk(superChord("Esc", superKey), no, HOTKEY_EVENT.deny),
    ];
  }
  const grantRemember = input.remember !== undefined && input.remember !== "";
  const ackChords: ChromeHotkey[] =
    input.ack?.choice !== undefined && input.ack.choice !== "" && !(grantRemember && !ackOnly)
      ? [
          hk(superChord("Enter", superKey), `Remember ${input.ack.choice}`, HOTKEY_EVENT.ackRemember),
          ...(input.ack.cycle === true
            ? [
                hk(superChord("ArrowLeft", superKey), "Previous option", HOTKEY_EVENT.ackPrev),
                hk(superChord("ArrowRight", superKey), "Next option", HOTKEY_EVENT.ackNext),
              ]
            : []),
        ]
      : [];
  if (input.ack !== undefined && !grantRemember) {
    return [
      hk("Enter", ackOnly ? "Acknowledge" : "Allow once", HOTKEY_EVENT.allow),
      ...ackChords,
      hk("Esc", no, HOTKEY_EVENT.deny),
    ];
  }
  const denyPersist: ChromeHotkey[] = input.persistDeny
    ? [
        hk(superChord("Esc", superKey), "Deny this session", HOTKEY_EVENT.denySession),
        hk(superChord("Shift+Esc", superKey), "Deny forever", HOTKEY_EVENT.denyAlways),
      ]
    : [];
  if (grantRemember) {
    const both = input.ack === undefined ? "" : " and the acknowledgement";
    return [
      hk("Enter", "Allow", HOTKEY_EVENT.allow),
      hk(superChord("Enter", superKey), `Remember ${input.remember}${both} this session`, HOTKEY_EVENT.allowSession),
      hk(
        superChord("Shift+Enter", superKey),
        `Remember ${input.remember}${both} in this project (7 days)`,
        HOTKEY_EVENT.allowAlways,
      ),
      hk("Esc", "Deny", HOTKEY_EVENT.deny),
      ...denyPersist,
    ];
  }
  if (input.widen !== undefined && input.widen !== "") {
    return [
      hk("Enter", "Allow once", HOTKEY_EVENT.allow),
      hk(superChord("Enter", superKey), `Treat ${input.widen} as part of this session`, HOTKEY_EVENT.allowWiden),
      hk("Esc", "Deny", HOTKEY_EVENT.deny),
    ];
  }
  if (input.persistDeny) {
    return [hk("Enter", "Allow", HOTKEY_EVENT.allow), hk("Esc", "Deny", HOTKEY_EVENT.deny), ...denyPersist];
  }
  return [hk("Enter", "Allow", HOTKEY_EVENT.allow), hk("Esc", "Deny", HOTKEY_EVENT.deny)];
}
