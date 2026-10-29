/**
 * Eval stderr face for a running program bag. Notifications and bag-child
 * completions are origin atoms on the bag; the ReACT tape does not list them.
 * Completions never dump responseText (that is the IR).
 */
import {
  AgentCallNotification,
  CompletionExpectation,
  ProgrammaticJob,
  tapeCompletion,
} from "@inhuman.tools/harness-model";

const STATUS_CAP = 80;

export function visitEvalProgress(program: ProgrammaticJob, emit: (id: string, line: string) => void): void {
  for (const [index, note] of program.notifications.entries()) emitNote(note, `note:${index}`, emit);
  for (const [index, child] of program.children.entries()) {
    const pew = tapeCompletion(child);
    if (pew != null) emitPew(pew, `pew:${index}`, emit);
  }
}

function emitNote(note: AgentCallNotification, fallbackId: string, emit: (id: string, line: string) => void): void {
  const text = note.message.trim();
  if (text === "") return;
  emit(stableId(note, fallbackId), `  ${text}`);
}

function emitPew(chunk: CompletionExpectation, fallbackId: string, emit: (id: string, line: string) => void): void {
  const name = chunk.model.trim() !== "" ? chunk.model.trim() : "completion";
  const id = stableId(chunk, fallbackId);
  if (!chunk.isDone) {
    emit(`${id}:live`, `  ${name}  live`);
    return;
  }
  emit(`${id}:done`, `  ${name}  ${pewStatus(chunk)}`);
}

function stableId(node: { readonly uuid?: string }, fallback: string): string {
  try {
    const id = node.uuid;
    if (typeof id === "string" && id !== "") return id;
  } catch {
    /* PLEXUS_UUID: unmaterialized Yjs accessor throws */
  }
  return fallback;
}

function pewStatus(chunk: CompletionExpectation): string {
  if (chunk.outcome === "failed") {
    const picked = chunk.failReason ?? chunk.endDetail ?? "failed";
    return clampStatus(picked.trim().replaceAll(/\s+/g, " "));
  }
  const ms = chunk.durationMs();
  if (ms == null) return "done";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

function clampStatus(text: string): string {
  const points = [...text];
  if (points.length <= STATUS_CAP) return text;
  return `${points.slice(0, STATUS_CAP - 1).join("")}…`;
}
