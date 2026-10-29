import { describe, expect, it } from "vitest";

import { BehaviorKernel, NoteLog } from "../index.js";

function peekBehaviorNotes(notes: NoteLog, agentId: string) {
  return notes.peek(agentId);
}

function consumeBehaviorNotes(notes: NoteLog, agentId: string, ids: readonly string[], callId: string): void {
  notes.consume(agentId, ids, callId);
}

describe("instance notes", () => {
  it("two kernels do not share notes even with the same agent id", () => {
    const left = new BehaviorKernel({ packages: () => [] });
    const right = new BehaviorKernel({ packages: () => [] });
    left.notes.emit({
      agentId: "s1",
      mode: "ambient",
      boundary: "round-end",
      message: "left only",
      turnId: "t1",
    });
    right.notes.emit({
      agentId: "s1",
      mode: "activating",
      boundary: "round-end",
      message: "right only",
      turnId: "t1",
    });

    expect({
      sameLog: left.notes === right.notes,
      left: peekBehaviorNotes(left.notes, "s1").map((note) => note.text),
      right: peekBehaviorNotes(right.notes, "s1").map((note) => note.text),
    }).toEqual({
      sameLog: false,
      left: ["left only"],
      right: ["right only"],
    });

    consumeBehaviorNotes(left.notes, "s1", ["note-0"], "call-left");
    expect({
      leftAfter: peekBehaviorNotes(left.notes, "s1"),
      rightAfter: peekBehaviorNotes(right.notes, "s1").map((note) => note.text),
    }).toEqual({
      leftAfter: [],
      rightAfter: ["right only"],
    });
  });

  it("behaviorNoteLog factory returns a distinct log each call", () => {
    const first = new NoteLog();
    const second = new NoteLog();
    first.emit({
      agentId: "a",
      mode: "ambient",
      boundary: "",
      message: "one",
      turnId: "t",
    });
    expect({
      distinct: first !== second,
      second: second.peek("a"),
    }).toEqual({ distinct: true, second: [] });
  });
});
