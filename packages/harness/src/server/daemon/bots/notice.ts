import { asSystemPrompt } from "@inhuman.tools/harness-commons";
import { emitSystemPrompt, type SessionRoot, type SessionTurn } from "@inhuman.tools/harness-model";

const pending = new WeakMap<SessionRoot, string>();

export function stampTurnBotNotice(turn: SessionTurn, note: string): void {
  const text = note.trim();
  if (text === "") return;
  const derivation = turn.derivation ?? emitSystemPrompt(turn, { reason: "bots changed" });
  derivation.note = asSystemPrompt(text);
}

export function queueBotNotice(session: SessionRoot, note: string): void {
  const text = note.trim();
  if (text === "") return;
  const turn = session.findRunningTurn();
  if (turn != null) {
    stampTurnBotNotice(turn, text);
    return;
  }
  const prior = pending.get(session);
  pending.set(session, prior == null || prior === "" ? text : `${prior}; ${text}`);
}

export function applyPendingBotNotice(session: SessionRoot, turn: SessionTurn): void {
  const note = pending.get(session) ?? "";
  pending.delete(session);
  stampTurnBotNotice(turn, note);
}
