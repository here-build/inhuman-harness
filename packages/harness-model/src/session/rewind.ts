/**
 * Episode walks for conversation rewind. Pin = nonempty `prompt` (same
 * law as tape user-speech). Do not reuse `SessionRoot.steerTurn`.
 *
 * `liveTurns` is head's tail-ancestry. Redo targets sit off that set —
 * walk `tip ?? head`, never `findTurnById`.
 *
 * Null `tip` (older documents) is at-tip. Torn (`head` not on `tip`'s
 * walk) is at-tip — do not paint a lying split.
 */
import { SessionTurn } from "./turn/session-turn.js";
import type { SessionUnit } from "./turn/types.js";

export function isRewindPin(turn: SessionTurn): boolean {
  return turn.prompt.trim() !== "";
}

/** Tail walk from `start`, pins only. Cycle-safe. Includes `start` when it is a pin. */
export function rewindPinsFrom(start: SessionTurn | null): SessionTurn[] {
  const pins: SessionTurn[] = [];
  let unit: SessionUnit | null = start;
  const seen = new Set<SessionTurn>();
  while (unit instanceof SessionTurn) {
    if (seen.has(unit)) break;
    seen.add(unit);
    if (isRewindPin(unit)) pins.push(unit);
    unit = unit.turnTail;
  }
  return pins;
}

export function onTipChain(turn: SessionTurn, tip: SessionTurn | null, head: SessionTurn | null): boolean {
  const ceiling = tip ?? head;
  if (ceiling == null) return false;
  let unit: SessionUnit | null = ceiling;
  const seen = new Set<SessionTurn>();
  while (unit instanceof SessionTurn) {
    if (seen.has(unit)) break;
    seen.add(unit);
    if (unit === turn) return true;
    unit = unit.turnTail;
  }
  return false;
}

/** Effective episode ceiling. Torn / null `tip` collapses to `head`. */
export function resolvedTip(head: SessionTurn | null, tip: SessionTurn | null): SessionTurn | null {
  if (head == null) return null;
  if (tip == null || tip === head) return head;
  return onTipChain(head, tip, head) ? tip : head;
}

export function isAtTip(head: SessionTurn | null, tip: SessionTurn | null): boolean {
  return head === resolvedTip(head, tip);
}

/**
 * Suffix from `tip` toward `head`, exclusive of `head`, chronological
 * (oldest after head first). Every `SessionTurn` — continue / compact / eval
 * stay on the future tape. Torn or at-tip: empty.
 */
export function futureTurns(head: SessionTurn | null, tip: SessionTurn | null): SessionTurn[] {
  const ceiling = resolvedTip(head, tip);
  if (head == null || ceiling == null || ceiling === head) return [];
  const suffix: SessionTurn[] = [];
  let unit: SessionUnit | null = ceiling;
  const seen = new Set<SessionTurn>();
  while (unit instanceof SessionTurn) {
    if (seen.has(unit)) break;
    if (unit === head) {
      suffix.reverse();
      return suffix;
    }
    seen.add(unit);
    suffix.push(unit);
    unit = unit.turnTail;
  }
  return [];
}

export function futurePins(head: SessionTurn | null, tip: SessionTurn | null): SessionTurn[] {
  return futureTurns(head, tip).filter(isRewindPin);
}

/** Older pins. Skips `head` when it is a pin. */
export function pastPins(head: SessionTurn | null): SessionTurn[] {
  if (head == null) return [];
  const pins = rewindPinsFrom(head);
  return pins[0] === head ? pins.slice(1) : pins;
}

export function previousPin(head: SessionTurn | null): SessionTurn | null {
  return pastPins(head)[0] ?? null;
}
