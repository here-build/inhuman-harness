/**
 * Origin yield on {@link CallJob} or {@link ProgrammaticJob}. A
 * `TurnNotificationChunk` records consumption; rollback of that turn
 * re-enters the atom. Not a callback and not Call / bag settlement.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

@syncing("harness:session:agent-call-notification")
export class AgentCallNotification extends PlexusModel {
  @syncing accessor message: string = "";
  /** Completion of a background job. Ordinary `self/notify` leaves this false. */
  @syncing accessor result: boolean = false;

  constructor(props?: { readonly message?: string; readonly result?: boolean } | symbol) {
    super(props);
  }
}

/** A check-in line for a shell or program result, not its output. */
export const RESULT_NOTE_CHARS = 240;

/** Where a background job's result lands: the notify list, or a shell's single note. */
type ResultSeat = { readonly background: boolean; readonly toolCallId: string } & (
  { notifications: AgentCallNotification[] } | { resultNote: AgentCallNotification | null }
);

/**
 * The one result of a background job that reached a terminal state. Not a
 * `self/notify`. The first result wins. `limit` clips a check-in line.
 */
export function rememberJobResult(job: ResultSeat, text: string, limit = Infinity): void {
  if (!job.background || job.toolCallId.trim() === "") return;
  if ("resultNote" in job ? job.resultNote != null : job.notifications.some((note) => note.result)) return;
  const body = text.replaceAll(/\s+/g, " ").trim().slice(0, limit);
  const note = new AgentCallNotification({
    message: body === "" ? `job ${job.toolCallId} finished` : `job ${job.toolCallId} finished: ${body}`,
    result: true,
  });
  if ("resultNote" in job) job.resultNote = note;
  else job.notifications.push(note);
}
