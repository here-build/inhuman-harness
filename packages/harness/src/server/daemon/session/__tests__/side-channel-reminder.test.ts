import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  CONTEXT_NEED_TOOL_NAME,
  METADATA_SAME_ROUND_NOTE,
  reactChunks,
  RegisteredToolsSet,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  ToolCallJob,
  ToolSpec,
  CompactJob,
} from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { historyBehind } from "@/context";
import { CONTEXT_NEED_REMINDER, TITLE_UPDATE_REMINDER } from "@/session";

import { turnFixture, type ModelReply } from "./fixtures/turn-iterator.js";

test("title and context_need reminders arm on the 5th quiet round and stay off the tape", async () => {
  const work: ModelReply = (completion) => {
    completion.responseCalls.push(responseCall(`dir-${completion.uuid}`, "list_dir", '{"path":"."}'));
  };
  const f = turnFixture(work, work, work, work, (completion) => {
    completion.responseText = "Done.";
  });
  await f.run();
  const completions = f.completions().map((cell) => cell.expectation);
  expect({
    early: completions.slice(0, 4).map((completion) => completion.systemNote),
    fifth: completions[4]?.systemNote,
    tools: reactChunks(f.turn)
      .filter((cell): cell is ToolCallJob => cell instanceof ToolCallJob)
      .map((cell) => cell.name),
    leaked: completions.some((completion) => /update_metadata|context_need/.test(completion.responseText)),
  }).toEqual({
    early: ["", "", "", ""],
    fifth: `${TITLE_UPDATE_REMINDER}\n\n${CONTEXT_NEED_REMINDER}`,
    tools: ["list_dir", "list_dir", "list_dir", "list_dir"],
    leaked: false,
  });
});

function quietTail(count: number): SessionTurn {
  const doneWork = Array.from({ length: count }, (_, index) => {
    const pew = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`old ${index}` });
    pew.succeed("settled", "", "null", { result: { text: "ok" } });
    return new CompletionJob({ expectation: pew });
  });
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`older`,
    queue: [],
    doneWork,
    reducerExited: true,
  });
}

test("a frozen tool set without the meta tools suppresses the nag", async () => {
  const f = turnFixture((completion) => {
    completion.responseText = "Done.";
  });
  f.turn.turnTail = quietTail(4);
  f.turn.toolsDefinition = new RegisteredToolsSet({ entries: [new ToolSpec({ name: "list_dir" })] });
  await f.run();
  expect(f.completions()[0]?.expectation.systemNote).toBe("");
});

test("a titled-only reply keeps the context_need nag on the follow-up note", async () => {
  const f = turnFixture(
    (completion) => {
      completion.responseCalls.push(responseCall("m1", "update_metadata", '{"current_turn_title":"Title it"}'));
    },
    (completion) => {
      completion.responseText = "Done.";
    },
  );
  f.turn.turnTail = quietTail(3);
  await f.run();
  expect(f.completions().map((cell) => cell.expectation.systemNote)).toEqual([
    "",
    `${METADATA_SAME_ROUND_NOTE}\n\n${CONTEXT_NEED_REMINDER}`,
  ]);
});

test("an empty context_need-only reply opens another round, and speech seals", async () => {
  const f = turnFixture(
    (completion) => {
      expect(completion.systemNote).toBe(`${TITLE_UPDATE_REMINDER}\n\n${CONTEXT_NEED_REMINDER}`);
      completion.responseCalls.push(responseCall("n1", CONTEXT_NEED_TOOL_NAME, '{"min_remaining_tokens":10}'));
    },
    (completion) => {
      completion.responseText = "settled";
    },
  );
  f.turn.turnTail = quietTail(4);
  await f.run();
  expect(f.completions()).toHaveLength(2);
  expect(f.host.classifyIntent).toHaveBeenCalledTimes(1);
});

test("a cutoff compact eat keeps the summary and drops the buried nag", () => {
  resetLocalIDs();
  const pew = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`old` });
  pew.systemNote = prompt.system`BURIED NAG`;
  pew.succeed("settled", "", "null", { result: { text: "old work" } });
  const recent = new CompletionExpectation({ connectionId: "c1", messages: [pew] });
  recent.succeed("settled", "", "null", { result: { text: "recent work" } });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`compacted`,
    queue: [],
    doneWork: [
      new CompletionJob({ expectation: pew }),
      new CompletionJob({ expectation: recent }),
      new CompactJob({ completed: true, standIn: "summary of the work" }),
    ],
  });
  const eaten = historyBehind(turn)
    .flatMap((cell) => (typeof cell === "string" ? [cell] : cell instanceof CompactJob ? [cell.standIn] : []))
    .join("\n");
  expect({ eaten, stored: pew.systemNote }).toEqual({
    eaten: "summary of the work",
    stored: "BURIED NAG",
  });
});
