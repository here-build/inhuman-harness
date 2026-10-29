import { PluginSurfaceError } from "./surface-error.js";
import type { NotifyBoundary } from "./value.js";

export type LoopNote = {
  readonly id: string;
  readonly text: string;
};

export type NoteBoundary = NotifyBoundary;

export type ContextNote = {
  readonly id: string;
  readonly agentId: string;
  readonly mode: "ambient" | "activating";
  readonly boundary: NoteBoundary;
  readonly message: string;
  readonly turnId: string;
  consumedBy: string;
  expired: boolean;
};

/** Invocation-owned context notes. Not a last-value slot. */
export class NoteLog {
  readonly notes: ContextNote[] = [];
  #seq = 0;

  emit(opts: {
    readonly agentId: string;
    readonly mode: "ambient" | "activating";
    readonly boundary: NoteBoundary;
    readonly message: string;
    readonly turnId: string;
  }): ContextNote {
    const note: ContextNote = {
      id: `note-${this.#seq}`,
      agentId: opts.agentId,
      mode: opts.mode,
      boundary: opts.boundary,
      message: opts.message,
      turnId: opts.turnId,
      consumedBy: "",
      expired: false,
    };
    this.#seq += 1;
    this.notes.push(note);
    return note;
  }

  peek(agentId: string): LoopNote[] {
    return this.notes
      .filter((note) => note.agentId === agentId && note.consumedBy === "" && !note.expired)
      .map((note) => ({
        id: note.id,
        text: note.message,
      }));
  }

  consume(agentId: string, ids: readonly string[], callId: string): void {
    for (const note of this.notes) {
      if (note.agentId !== agentId || !ids.includes(note.id)) continue;
      PluginSurfaceError.invariant(note.consumedBy === "", "note consumed twice");
      note.consumedBy = callId;
    }
  }

  /** Restore a recorded note without emitting it again. Same id is a no-op. */
  adopt(note: ContextNote): void {
    if (this.notes.some((row) => row.id === note.id)) return;
    this.notes.push({
      id: note.id,
      agentId: note.agentId,
      mode: note.mode,
      boundary: note.boundary,
      message: note.message,
      turnId: note.turnId,
      consumedBy: note.consumedBy,
      expired: note.expired,
    });
    const numeric = /^note-(\d+)$/.exec(note.id);
    if (numeric != null) this.#seq = Math.max(this.#seq, Number(numeric[1]) + 1);
  }

  /**
   * Unconsumed notes die with the turn, whatever boundary emitted them. A
   * later turn recomputes its own start enrichment.
   */
  expireUnused(agentId: string, turnId: string): void {
    for (const note of this.notes) {
      if (note.agentId === agentId && note.turnId === turnId && note.consumedBy === "") {
        note.expired = true;
      }
    }
  }
}

/** A fresh note log. Each runtime instance owns one; do not share. */
export function behaviorNoteLog(): NoteLog {
  return new NoteLog();
}
