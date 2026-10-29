/**
 * The native list shows the end of the session and grows upward. A window is how many turns are
 * unfolded and how many of their rounds are listed; older turns stay folded, so none of their
 * programs is parsed, until the reader scrolls to them.
 */
export type TailWindow = { readonly turns: number; readonly rounds: number };

export const FIRST_WINDOW: TailWindow = { turns: 1, rounds: 6 };

/** Rounds added above each time the list's top is reached. */
export const STEP = 8;

/**
 * One step upward. Rounds already unfolded come first; when they are all listed, the next older
 * turn unfolds. Null when there is nothing older.
 */
export function growWindow(window: TailWindow, unfoldedRounds: number, turnCount: number): TailWindow | null {
  if (window.rounds < unfoldedRounds) return { turns: window.turns, rounds: window.rounds + STEP };
  if (window.turns < turnCount) return { turns: window.turns + 1, rounds: window.rounds + STEP };
  return null;
}
