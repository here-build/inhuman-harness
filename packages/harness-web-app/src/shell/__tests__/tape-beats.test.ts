import { Plexus } from "@here.build/plexus";
import {
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { schemeExprReady, schemeExprSettled } from "../scheme-unwrap.js";
import { groupBeats } from "../tape-beats.js";
import { metadataMark, tapeCells, type TapeCell } from "../tape-read.js";

describe("progress marks", () => {
  it("reads a title update and ignores an empty one", () => {
    const titled = new SystemToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      name: "update_metadata",
      argsJson: JSON.stringify({
        current_turn_title: "  Grok migration cleanup  ",
        current_turn_description: "Parallel Grok implementation",
      }),
    });
    const blank = new SystemToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      name: "update_metadata",
      argsJson: JSON.stringify({ current_turn_title: "   ", current_turn_description: "nope" }),
    });
    const read = new SystemToolJob({ name: "read_file", argsJson: JSON.stringify({ path: "a.ts" }) });
    expect({
      titled: metadataMark(titled),
      blank: metadataMark(blank),
      read: metadataMark(read),
    }).toEqual({
      titled: { title: "Grok migration cleanup", description: "Parallel Grok implementation", items: [] },
      blank: null,
      read: null,
    });
  });

  it("keeps all work in a round together and uses its latest metadata without leaking to another turn", () => {
    const beats = groupBeats([
      { kind: "round", id: "first" },
      { kind: "speech", id: "speech", text: "Starting", thought: "" },
      { kind: "progress", id: "old", title: "Old title", description: "", items: [] },
      { kind: "tool", id: "tool", summary: "read_file", outcome: "ok", body: { kind: "empty" } },
      { kind: "progress", id: "new", title: "New title", description: "Round description", items: [] },
      { kind: "user", id: "next-turn", text: "Next prompt" },
      { kind: "round", id: "second" },
      { kind: "speech", id: "reply", text: "Done", thought: "" },
    ]);
    expect(beats.map((beat) => [beat.id, beat.mark, beat.cells.map(face)])).toEqual([
      ["first", { title: "New title", description: "Round description", items: [] }, ["speech", "tool:read_file"]],
      ["next-turn", null, ["user"]],
      ["second", null, ["speech"]],
    ]);
  });

  it("attributes trailing and nested metadata to the beginning of its completion round", async () => {
    const expr = '(define note "later") (update_metadata "Later")';
    const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
    const first = completion("First response");
    const second = completion("Second response");
    const third = completion("Untitled response");
    const early = new SystemToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      toolCallId: "early",
      name: "update_metadata",
      argsJson: JSON.stringify({ current_turn_title: "First stretch" }),
      completed: true,
    });
    const program = new ProgrammaticJob({
      toolCallId: "program",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr, description: "retitle" }),
      outcomeJson: JSON.stringify({ ok: true, value: ["#t"] }),
      completed: true,
    });
    program.pushInvocation(
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        toolCallId: "inner",
        name: "update_metadata",
        argsJson: JSON.stringify({
          current_turn_title: "Later stretch",
          current_turn_description: "Keep the notes",
        }),
        completed: true,
      }),
    );
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [first, early, second, program, third],
      reducerExited: true,
    });
    for (const chunk of turn.doneWork) turn.pushChild(chunk);
    root.head = turn;
    const plexus = Plexus.bootstrap(root);
    await schemeExprReady(expr);
    expect(schemeExprSettled(expr)).toBe(true);
    const cells = tapeCells(root);
    expect(cells.map(face)).toEqual([
      "round",
      "progress:First stretch:",
      "speech",
      "round",
      "progress:Later stretch:Keep the notes",
      "speech",
      "tool:scheme_repl retitle",
      "round",
      "speech",
    ]);
    const beats = groupBeats(cells);
    expect(beats.map((beat) => [beat.mark?.title ?? "", beat.cells.map(face)])).toEqual([
      ["First stretch", ["speech"]],
      ["Later stretch", ["speech", "tool:scheme_repl retitle"]],
      ["", ["speech"]],
    ]);
    expect(beats.map((beat) => beat.id)).toEqual([first.uuid, second.uuid, third.uuid]);
    plexus.destroy();
  });

  it("puts task and goal calls on the same progress mark as the title", () => {
    const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
    const spoken = completion("Working.");
    const title = hidden("update_metadata", {
      current_turn_title: "Ship the bar",
      current_turn_description: "Left pane",
    });
    const created = hidden("task__create", {
      taskId: "bar",
      subject: "Left bar",
      description: "Show task progress beside the title",
      validationProgram: '(tasks/write-completion-verdict #t "shown")',
    });
    const started = hidden("task__start", { taskId: "bar" });
    const goal = hidden("goal__set", { text: "Keep the left pane current", loops: 4 });
    const read = new SystemToolJob({
      name: "read_file",
      argsJson: JSON.stringify({ path: "tape.tsx" }),
      completed: true,
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [spoken, title, created, started, goal, read],
      reducerExited: true,
    });
    for (const chunk of turn.doneWork) turn.pushChild(chunk);
    root.head = turn;
    const plexus = Plexus.bootstrap(root);
    const cells = tapeCells(root);
    expect(cells.map(face)).toEqual([
      "round",
      "progress:Ship the bar:Left pane|Left bar:Show task progress beside the title|Left bar:in progress|Goal:Keep the left pane current",
      "speech",
      "reads",
    ]);
    expect(cells.some((cell) => cell.kind === "tool" && /task__|goal__/.test(cell.summary))).toBe(false);
    plexus.destroy();
  });
});

function hidden(name: string, args: Record<string, unknown>): SystemToolJob {
  return new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    name,
    argsJson: JSON.stringify(args),
    completed: true,
  });
}

describe("context_need", () => {
  it("leaves the call off the tape, alone or beside other work", async () => {
    const mixed = '(shell "pwd")\n(context_need)';
    const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
    const spoken = completion("Noted.");
    const need = new SystemToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      name: "context_need",
      argsJson: JSON.stringify({ min_remaining_tokens: 1000 }),
      completed: true,
    });
    const shell = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd" }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: { stdout: "/tmp/web\n", stderr: "" } }),
    });
    const onlyNeed = new ProgrammaticJob({
      toolCallId: "only-need",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: "(context_need)" }),
      outcomeJson: JSON.stringify({ ok: true, value: ["#t"] }),
      completed: true,
    });
    onlyNeed.pushInvocation(
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        name: "context_need",
        argsJson: "{}",
        completed: true,
      }),
    );
    const beside = new ProgrammaticJob({
      toolCallId: "beside",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: mixed }),
      outcomeJson: JSON.stringify({ ok: true, value: ["#t"] }),
      completed: true,
    });
    beside.pushInvocation(
      new SystemToolJob({
        name: "shell",
        argsJson: JSON.stringify({ command: "pwd" }),
        completed: true,
        outcomeJson: JSON.stringify({ ok: true, value: { stdout: "/tmp/web\n", stderr: "" } }),
      }),
    );
    beside.pushInvocation(
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        name: "context_need",
        argsJson: "{}",
        completed: true,
      }),
    );
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [spoken, need, shell, onlyNeed, beside],
      reducerExited: true,
    });
    for (const chunk of turn.doneWork) turn.pushChild(chunk);
    root.head = turn;
    const plexus = Plexus.bootstrap(root);
    await schemeExprReady(mixed);
    expect(tapeCells(root).map(face)).toEqual(["round", "speech", "tool:shell pwd", "tool:shell pwd"]);
    plexus.destroy();
  });
});

function completion(text: string): CompletionJob {
  const expectation = new CompletionExpectation({ connectionId: "test" });
  expectation.responseText = text;
  return new CompletionJob({ expectation });
}

function face(cell: TapeCell): string {
  if (cell.kind === "progress") {
    const items = cell.items.map((item) => `${item.label}:${item.detail}`).join("|");
    return items === ""
      ? `progress:${cell.title}:${cell.description}`
      : `progress:${cell.title}:${cell.description}|${items}`;
  }
  if (cell.kind === "tool") return `tool:${cell.summary}`;
  return cell.kind;
}
