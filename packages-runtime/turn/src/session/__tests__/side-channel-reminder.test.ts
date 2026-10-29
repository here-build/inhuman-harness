import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
  ReACTChunk,
  RegisteredToolsSet,
  responseCall,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolSpec,
  TurnPromptChunk,
  sessionDisplayTitle,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CONTEXT_NEED_REMINDER,
  joinSystemNotes,
  quietRoundsSince,
  sealedActorRounds,
  SIDE_CHANNEL_REMINDER_EVERY,
  sideChannelReminderDue,
  sideChannelReminderNote,
  TITLE_UPDATE_REMINDER,
  type SideChannelRound,
} from "../side-channel-reminder.js";

beforeEach(() => resetLocalIDs());

const title = "update_metadata";
const need = "context_need";

function rounds(rows: readonly (readonly string[])[]): SideChannelRound[] {
  return rows.map((calls) => ({ calls }));
}

function sealed(calls: readonly string[], outcome: "successful" | "failed" | "open" = "successful"): CompletionJob {
  const pew = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`hi`,
  });
  if (calls.length > 0) {
    pew.setResponseCalls(calls.map((name, index) => responseCall(`${name}-${index}`, name)));
  }
  if (outcome === "successful") pew.succeed("settled", "", "null", { result: { text: "ok" } });
  if (outcome === "failed") pew.fail("settled", "boom", "null");
  return new CompletionJob({ expectation: pew });
}

function isolated(calls: readonly string[]): CompletionJob {
  const pew = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`hi`,
    completionMode: "isolated",
  });
  pew.setResponseCalls(calls.map((name, index) => responseCall(`${name}-${index}`, name)));
  pew.succeed("settled", "", "null", { result: { text: "ok" } });
  return new CompletionJob({ expectation: pew });
}

describe("side-channel reminder wording", () => {
  it("is silent bookkeeping: never invites the model to narrate what to keep", () => {
    for (const note of [TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]) {
      expect(note).not.toMatch(/next stretch/i);
      expect(note).not.toMatch(/\bsay what\b/i);
      expect(note).toMatch(/do not mention this note/i);
      expect(note).toMatch(/do not address the user/i);
    }
  });
});

describe("side-channel reminder clocks", () => {
  it("arms the nag on every 5th quiet round, and not on the rounds between", () => {
    const due = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((elapsed) => sideChannelReminderDue(elapsed));
    expect(due).toEqual([false, false, false, false, true, false, false, false, false, true]);
    expect(SIDE_CHANNEL_REMINDER_EVERY).toBe(5);
  });

  it("keeps title and context_need on separate clocks", () => {
    const neither = sideChannelReminderNote(rounds([[], [], [], []]));
    const titleOnly = sideChannelReminderNote(rounds([[title], [title], [title], [title]]));
    const needOnly = sideChannelReminderNote(rounds([[need], [need], [need], [need]]));
    const bothCalled = sideChannelReminderNote(
      rounds([
        [title, need],
        [title, need],
        [title, need],
        [title, need],
      ]),
    );
    const drifted = sideChannelReminderNote(rounds([[title, need], [title], [title], [title], [title]]));
    expect({ neither, titleOnly, needOnly, bothCalled, drifted }).toEqual({
      neither: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
      titleOnly: CONTEXT_NEED_REMINDER,
      needOnly: TITLE_UPDATE_REMINDER,
      bothCalled: "",
      drifted: CONTEXT_NEED_REMINDER,
    });
  });

  it("a call resets only that clock", () => {
    expect(quietRoundsSince(rounds([[], [], [title], [], []]), title)).toBe(2);
    expect(quietRoundsSince(rounds([[], [], [title], [], []]), need)).toBe(5);
    expect(sideChannelReminderNote(rounds([[title], [], [], []]))).toBe(CONTEXT_NEED_REMINDER);
  });

  it("counts sealed session rounds across turns, skipping failures and isolated interns", () => {
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`old`,
      queue: [],
      doneWork: [sealed([]), sealed([], "failed"), isolated([title, need]), sealed([])],
    });
    const head = new SessionTurn({
      turnTail: older,
      prompt: prompt.user`new`,
      queue: [],
      doneWork: [sealed([]), sealed([], "open"), sealed([])],
    });
    expect(sealedActorRounds(head).map((round) => round.calls)).toEqual([[], [], [], []]);
    expect(sideChannelReminderNote(sealedActorRounds(head))).toBe(
      joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
    );
  });
});

function quietRounds(count: number): CompletionJob[] {
  return Array.from({ length: count }, () => sealed([]));
}

function cutoffChunk(): CompactJob {
  return new CompactJob({ completed: true, standIn: "summary of the work" });
}

function noteOf(turn: SessionTurn, offered: readonly string[] | null = null): string {
  return sideChannelReminderNote(sealedActorRounds(turn), SIDE_CHANNEL_REMINDER_EVERY, offered);
}

describe("side-channel reminder edges", () => {
  it("starts the clock after the latest cutoff", () => {
    const buriedQuiet = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`old`,
      queue: [],
      doneWork: [...quietRounds(4), cutoffChunk()],
    });
    const buriedCall = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`called`,
      queue: [],
      doneWork: [sealed([title]), ...quietRounds(3), cutoffChunk(), sealed([])],
    });
    const kept = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`kept`,
      queue: [],
      doneWork: [cutoffChunk(), ...quietRounds(4)],
    });
    const uncommitted = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`open`,
      queue: [],
      doneWork: [...quietRounds(4), new CompactJob({ completed: false, standIn: "not yet" })],
    });
    const earlier = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`earlier`,
      queue: [],
      doneWork: [...quietRounds(4), cutoffChunk(), ...quietRounds(2), cutoffChunk()],
    });
    const summaryRound = sealed([]);
    const withCard = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`card`,
      queue: [],
      doneWork: [
        new CompactJob({ completed: true, standIn: summaryRound.expectation.responseText || "summary" }),
        ...quietRounds(3),
      ],
    });
    expect({
      buriedQuiet: noteOf(buriedQuiet),
      buriedCall: noteOf(buriedCall),
      kept: noteOf(kept),
      uncommitted: noteOf(uncommitted),
      earlier: noteOf(earlier),
      card: noteOf(withCard),
    }).toEqual({
      buriedQuiet: "",
      buriedCall: "",
      kept: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
      uncommitted: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
      earlier: "",
      card: "",
    });
  });

  it("a cutoff on an ancestor hides that turn's call from the head clock", () => {
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`older`,
      queue: [],
      doneWork: [sealed([title, need]), cutoffChunk(), ...quietRounds(3)],
      reducerExited: true,
    });
    const head = new SessionTurn({
      turnTail: older,
      prompt: prompt.user`head`,
      queue: [],
      doneWork: quietRounds(1),
    });
    expect(noteOf(head)).toBe(joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]));
  });

  it("an isolated summarizer child is not a round", () => {
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`work`,
      queue: [],
      doneWork: quietRounds(4),
    });
    turn.pushChild(isolated([title, need]));
    expect(noteOf(turn)).toBe(joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]));
  });

  it("a scheme inner call resets only that clock", () => {
    const bag = new ProgrammaticJob({ toolCallId: "p1", argsJson: "{}" });
    bag.pushInvocation(new SystemToolJob({ toolCallId: "m1", name: title, argsJson: "{}" }));
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`run`,
      queue: [],
      doneWork: [...quietRounds(3), sealed([]), bag],
    });
    expect(noteOf(turn)).toBe(CONTEXT_NEED_REMINDER);
  });

  it("a malformed call still resets that clock", () => {
    const bad = sealed([title]);
    const call = bad.expectation.responseCalls[0];
    bad.expectation.setResponseCalls([responseCall(call.toolCallId, call.name, "not-json")]);
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`try`,
      queue: [],
      doneWork: [...quietRounds(3), bad],
    });
    expect(noteOf(turn)).toBe(CONTEXT_NEED_REMINDER);
  });

  it("omits a nag whose tool is absent from the frozen set", () => {
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`tools`,
      queue: [],
      doneWork: quietRounds(4),
      toolsDefinition: new RegisteredToolsSet({ entries: [new ToolSpec({ name: "list_dir" })] }),
    });
    const both = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`both`,
      queue: [],
      doneWork: quietRounds(4),
      toolsDefinition: new RegisteredToolsSet({
        entries: [new ToolSpec({ name: title }), new ToolSpec({ name: need })],
      }),
    });
    expect({
      frozenWithout: noteOf(
        turn,
        turn.tools.entries.map((entry) => entry.name),
      ),
      frozenWith: noteOf(
        both,
        both.tools.entries.map((entry) => entry.name),
      ),
      catalogFallback: noteOf(turn, null),
    }).toEqual({
      frozenWithout: "",
      frozenWith: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
      catalogFallback: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
    });
  });

  it("prompt chunks, open-page markers, and slash turns do not invent rounds", () => {
    const slash = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`/compact`,
      queue: [],
      doneWork: [new TurnPromptChunk(), ...quietRounds(3), new ReACTChunk({ openPage: true }), sealed([])],
    });
    expect(sealedActorRounds(slash)).toHaveLength(4);
    expect(noteOf(slash)).toBe(joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]));
  });

  it("a manual title does not stop the title nag", () => {
    const head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`name me`,
      queue: [],
      doneWork: quietRounds(4),
    });
    const root = new SessionRoot({ manualTitle: "Kept name" });
    root.head = head;
    expect({ title: sessionDisplayTitle(root), note: noteOf(head) }).toEqual({
      title: "Kept name",
      note: joinSystemNotes([TITLE_UPDATE_REMINDER, CONTEXT_NEED_REMINDER]),
    });
  });
});
