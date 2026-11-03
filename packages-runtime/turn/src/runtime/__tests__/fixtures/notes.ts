import type { RuntimeLoopNote, RuntimeNoteLog } from "../../ports.js";

type Note = {
  readonly id: string;
  readonly agentId: string;
  readonly mode: "ambient" | "activating";
  readonly boundary: "" | "turn-start" | "turn-end" | "round-start" | "round-end";
  readonly message: string;
  readonly turnId: string;
  consumedBy: string;
};

export class NoteLog implements RuntimeNoteLog {
  readonly notes: Note[] = [];

  emit(input: Omit<Note, "id" | "consumedBy">): void {
    this.notes.push({ ...input, id: `note-${this.notes.length}`, consumedBy: "" });
  }

  peek(sessionId: string): RuntimeLoopNote[] {
    return this.notes
      .filter((note) => note.agentId === sessionId && note.consumedBy === "")
      .map((note) => ({ id: note.id, text: note.message, mode: note.mode }));
  }

  consume(sessionId: string, ids: readonly string[], callId: string): void {
    for (const note of this.notes) {
      if (note.agentId !== sessionId || !ids.includes(note.id)) continue;
      if (note.consumedBy !== "") throw new Error("Note consumed twice");
      note.consumedBy = callId;
    }
  }
}
