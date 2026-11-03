import invariant from "tiny-invariant";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  AgentCallJob,
  AgentCallNotification,
  callbackRequiredNote,
  CompactJob,
  CompletionJob,
  CompletionExpectation,
  isNoteClaimed,
  ProgrammaticJob,
  ReACTChunk,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
  ToolCallJob,
} from "@inhuman.tools/harness-model/session";
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";

import { restorePendingRound } from "../../agent-calls/index.js";
import { catalogOf } from "../../tool-catalog/bindings.js";
import { THOUGHT_CONTINUE_NOTE } from "../re-act-loop-intent-detected-trigger.js";
import { turnFixture } from "./fixtures/turn-iterator.js";

describe("turn sequence rules with mock resolution", () => {
  it("moves entered work from queue to tape in one update without an observable ownership gap", () => {
    const { session, turn } = turnFixture();
    const job = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "mock" }) });
    turn.enqueue(job);
    const updates: Uint8Array[] = [];
    session.__doc__?.on("update", (update: Uint8Array) => updates.push(update));
    const gaps: boolean[] = [];
    const stop = autorun(() => {
      gaps.push(!turn.queue.includes(job) && !turn.doneWork.includes(job));
    });
    try {
      while (turn.take() != null) {
        /* traverse the production cursor */
      }
      expect({
        gap: gaps.includes(true),
        updates: updates.length,
        done: turn.doneWork.length,
        queued: turn.queue.length,
      }).toEqual({ gap: false, updates: 2, done: 2, queued: 0 });
    } finally {
      stop();
    }
  });

  it("finishes a text response, retaining the skipped conditional continuation", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Done.";
    });
    await f.run();
    expect(f.resolvers.completion).toHaveBeenCalledTimes(1);
    expect(f.turn.doneWork.at(-1)).toMatchObject({ openPage: true, skipped: true });
    expect(f.turn.queuedContinuation).toBe(false);
  });

  it("appends tools and a follow-up; the next completion sees resolved tool data", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseCalls.push(responseCall("t1", "echo", "{}"));
      },
      (completion) => {
        completion.responseText = "Finished.";
      },
    );
    await f.run();
    expect(f.host.admit).toHaveBeenCalledTimes(1);
    expect(f.resolvers.work).toHaveBeenCalledTimes(1);
    expect(f.completions()).toHaveLength(2);
    expect(f.turn.doneWork.map((step) => step.constructor.name)).toEqual([
      "TurnPromptChunk",
      "CompletionJob",
      "SystemToolJob",
      "ReACTChunk",
      "CompletionJob",
      "ReACTChunk",
    ]);
    expect(f.resolvers.work.mock.calls[0]?.[0].completed).toBe(true);
    expect(f.completions()[1]?.expectation.messages).toContain(f.resolvers.work.mock.calls[0]?.[0]);
  });

  it("awaits resolution before reading the response and appending its consequences", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Done.";
    });
    const resolved = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const complete = f.resolvers.completion.getMockImplementation()!;
    f.resolvers.completion.mockImplementationOnce(async (job, signal) => {
      entered.resolve();
      await resolved.promise;
      await complete(job, signal);
    });
    const running = f.run();
    await entered.promise;
    expect(f.turn.queue).toEqual([]);
    expect(f.host.classifyIntent).not.toHaveBeenCalled();
    resolved.resolve();
    await running;
    expect(f.host.classifyIntent).toHaveBeenCalledOnce();
  });

  it("resolves metadata before admitting ordinary work, regardless of response order", async () => {
    const order: string[] = [];
    const f = turnFixture(
      (completion) => {
        completion.responseCalls.push(
          responseCall("tool", "echo", "{}"),
          responseCall("need", "context_need", '{"tokens":1000,"reason":"work"}'),
          responseCall("title", "update_metadata", '{"title":"Working"}'),
        );
      },
      (completion) => {
        completion.responseText = "Done.";
      },
    );
    const admit = f.host.admit.getMockImplementation()!;
    f.host.admit.mockImplementation((call) => {
      order.push(`admit:${call.function.name}`);
      return admit(call);
    });
    const resolve = f.resolvers.work.getMockImplementation()!;
    f.resolvers.work.mockImplementation(async (job, signal) => {
      order.push(`resolve:${job instanceof ToolCallJob ? job.name : "scheme"}`);
      return resolve(job, signal);
    });
    await f.run();
    expect(f.resolvers.work).toHaveBeenCalledTimes(3);
    expect(order.slice(0, 5)).toEqual([
      "admit:context_need",
      "resolve:context_need",
      "admit:update_metadata",
      "resolve:update_metadata",
      "admit:echo",
    ]);
  });

  it("uses catalog flags for arbitrary side channels and freezes classification during execution", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseCalls.push(
          responseCall("ordinary", "echo", "{}"),
          responseCall("early", "bookkeeping", "{}"),
        );
      },
      (completion) => {
        completion.responseText = "Done.";
      },
    );
    const catalog = catalogOf(f.session);
    invariant(catalog != null, "missing fixture catalog");
    const entry = {
      wireName: "bookkeeping",
      class: "meta",
      description: "bookkeeping",
      parameters: {},
      source: { kind: "pack", pluginName: "custom" } as const,
      isSideChannel: true,
    };
    catalog.replacePack([...catalog.catalogEntries(), entry]);
    const resolve = f.resolvers.work.getMockImplementation();
    invariant(resolve != null, "missing fixture resolver");
    f.resolvers.work.mockImplementationOnce(async (job, signal) => {
      catalog.replacePack([
        ...catalog.catalogEntries().filter((row) => row.wireName !== "bookkeeping"),
        { ...entry, isSideChannel: false },
        { ...entry, wireName: "echo", isSideChannel: true },
      ]);
      return resolve(job, signal);
    });
    await f.run();
    expect(f.host.admit.mock.calls.map(([call]) => call.id)).toEqual(["early", "ordinary"]);
    expect(f.resolvers.work.mock.calls.map(([job]) => job.toolCallId)).toEqual(["early", "ordinary"]);
  });

  it.each([false, true])("preserves recorded early work after catalog changes (program=%s)", async (program) => {
    const f = turnFixture(
      (completion) => {
        completion.responseCalls.push(
          responseCall("ordinary", "echo", "{}"),
          responseCall("early", "context_need", '{"min_remaining_tokens":100}'),
        );
      },
      (completion) => {
        completion.responseText = "Done.";
      },
    );
    if (program)
      f.host.admit.mockImplementationOnce(
        (call) =>
          new ProgrammaticJob({
            toolCallId: call.id,
            toolName: call.function.name,
            argsJson: call.function.arguments,
            isSideChannel: true,
            triggersReactLoop: false,
          }),
      );
    f.resolvers.work.mockResolvedValueOnce("aborted");
    await f.run();
    expect(f.host.admit.mock.calls.map(([call]) => call.id)).toEqual(["early"]);
    const catalog = catalogOf(f.session);
    invariant(catalog != null, "missing fixture catalog");
    catalog.replacePack([
      ...catalog.catalogEntries().map((entry) => ({ ...entry, isSideChannel: false })),
      {
        wireName: "echo",
        class: "meta",
        description: "echo",
        parameters: {},
        source: { kind: "pack", pluginName: "custom" },
        isSideChannel: true,
      },
    ]);
    f.turn.orchestrationResult = true;
    restorePendingRound(f.turn);
    await f.run();
    expect(f.host.admit.mock.calls.map(([call]) => call.id)).toEqual(["early", "ordinary"]);
    expect(f.resolvers.work.mock.calls.map(([job]) => job.toolCallId)).toEqual(["early", "early", "ordinary"]);
  });

  it.each([false, true])(
    "continues after a lone context_need with current_phase_settled=%s and no response text",
    async (currentPhaseSettled) => {
      const f = turnFixture(
        (completion) => {
          completion.responseCalls.push(
            responseCall(
              "need",
              "context_need",
              JSON.stringify({
                min_remaining_tokens: 8000,
                preserve: { user_turns: 1, rounds: 4 },
                focus: "Continue the unfinished work after preparing context.",
                current_phase_settled: currentPhaseSettled,
              }),
            ),
          );
        },
        (completion) => {
          // A service-only reply must not be classified as a final answer.
          expect(f.host.classifyIntent).not.toHaveBeenCalled();
          const need = f.resolvers.work.mock.calls[0]?.[0];
          expect(need).toMatchObject({ name: "context_need", completed: true, triggersReactLoop: false });
          // context_need is tape-hidden; its resolved job is not replayed as ordinary work.
          expect(completion.messages).not.toContain(need);
          completion.responseText = "Finished the remaining work.";
        },
      );

      await f.run();

      expect(f.resolvers.completion).toHaveBeenCalledTimes(2);
      expect(f.resolvers.work).toHaveBeenCalledTimes(1);
      expect(f.completions()[0]?.expectation.responseText).toBe("");
      expect(f.completions()[1]?.expectation.responseText).toBe("Finished the remaining work.");
      expect(f.host.classifyIntent).toHaveBeenCalledOnce();
      expect(f.turn.doneWork.filter((step) => step instanceof ReACTChunk)).toMatchObject([
        { skipped: false },
        { openPage: true, skipped: true },
      ]);
      expect(f.turn.queuedContinuation).toBe(false);
    },
  );

  it("claims a steer arriving during resolution at the next model boundary", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseText = "First answer";
        admitSteer(f.session, prompt.user`also this`, f.turn.uuid);
      },
      (completion) => {
        completion.responseText = "Both done";
      },
    );
    await f.run();
    expect(f.completions()).toHaveLength(2);
    expect(f.turn.doneWork.filter((step) => step instanceof TurnSteerChunk)).toMatchObject([{ text: "also this" }]);
    expect(f.session.steerQueue).toEqual([]);
  });

  it("an open callback keeps the turn going and is explained to the next round", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseText = "I think yes";
      },
      (completion) => {
        completion.responseText = "Delivered";
        delete f.session.agentCallbacks.open;
      },
    );
    f.session.agent.spec.voidLegal = false;
    f.session.agentCallbacks.open = "caller";
    const expectedNote = callbackRequiredNote(false, f.session.openCallbackRows());
    await f.run();
    expect(f.completions()).toHaveLength(2);
    expect(f.completions()[1]?.expectation.systemNote).toBe(expectedNote);
  });

  it("names the open call in the first round, since agent__respond is a fixed tool without ids", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Delivered";
      delete f.session.agentCallbacks.open;
    });
    f.session.agent.spec.voidLegal = false;
    f.session.agentCallbacks.open = "caller";
    const expectedNote = callbackRequiredNote(false, f.session.openCallbackRows());
    await f.run();
    expect(f.completions()[0]?.expectation.systemNote).toBe(expectedNote);
  });

  it.each([
    [
      "a model that only titles",
      false,
      (completion: CompletionExpectation) => {
        completion.responseCalls.push(responseCall("t", "update_metadata", '{"current_turn_title":"Working"}'));
      },
    ],
    [
      "prose against an open callback",
      true,
      (completion: CompletionExpectation) => {
        completion.responseText = "I think yes";
      },
    ],
    [
      "an empty context_need every round",
      false,
      (completion: CompletionExpectation) => {
        completion.responseCalls.push(responseCall("n", "context_need", "{}"));
      },
    ],
  ])("%s ends on the card after a bounded run of idle rounds", async (_name, callback, reply) => {
    const f = turnFixture(...Array.from({ length: 30 }, () => reply));
    if (callback) f.session.agentCallbacks.open = "caller";
    await f.run();
    expect({
      rounds: f.completions().length,
      last: f.turn.doneWork.findLast((cell) => cell instanceof ReACTChunk),
    }).toMatchObject({ rounds: 5, last: { decision: { kind: "halt", reason: "trigger-budget" }, skipped: true } });
    expect(f.turn.broke).not.toBe("");
  });

  it("a round-end note enriches the next round and is consumed once", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseText = "First";
      },
      (completion) => {
        completion.responseText = "Finished";
      },
    );
    f.host.closeRound.mockImplementation(async (settle) => {
      if (settle.ok && settle.value === "First") {
        f.host.notes.emit({
          agentId: f.session.sessionId,
          mode: "activating",
          boundary: "round-end",
          message: "  Check the result  ",
          turnId: f.turn.uuid,
        });
        f.host.notes.emit({
          agentId: f.session.sessionId,
          mode: "activating",
          boundary: "round-end",
          message: " ",
          turnId: f.turn.uuid,
        });
      }
    });
    await f.run();
    expect(f.completions()[1]?.expectation.systemNote).toBe("Check the result");
    expect(f.host.notes.peek(f.session.sessionId)).toMatchObject([{ text: " " }]);
    expect(f.host.notes.notes).toMatchObject([
      { message: "  Check the result  ", consumedBy: f.turn.uuid },
      { message: " ", consumedBy: "" },
    ]);
  });

  it("a refused round boundary does not produce model work", async () => {
    const f = turnFixture();
    f.host.openRound.mockResolvedValueOnce(false);
    await f.run();
    expect(f.resolvers.completion).not.toHaveBeenCalled();
    expect(f.turn.broke).toContain("plugin refused");
  });

  it("continues thought-only responses without consulting the intent classifier", async () => {
    const f = turnFixture(
      (completion) => {
        completion.responseThought = "Thinking";
      },
      (completion) => {
        completion.responseText = "Answer";
      },
    );
    await f.run();
    expect(f.completions()).toHaveLength(2);
    expect(f.completions()[1]?.expectation.systemNote).toContain(THOUGHT_CONTINUE_NOTE);
    expect(f.host.classifyIntent).toHaveBeenCalledTimes(1);
  });

  it.each(["continue", "question", "seal"] as const)("applies intent verdict %s", async (verdict) => {
    const f = turnFixture(
      (completion) => {
        completion.responseText = "Should I proceed?";
      },
      (completion) => {
        completion.responseText = "Done.";
      },
    );
    f.host.classifyIntent.mockResolvedValueOnce({ verdict, status: "judged", detail: "" });
    await f.run();
    expect(f.completions()).toHaveLength(verdict === "continue" ? 2 : 1);
    expect(
      f.turn.doneWork.filter(
        (cell) => cell instanceof ReACTChunk && cell.decision?.causes.some((cause) => cause.kind === "intent"),
      ),
    ).toHaveLength(verdict === "continue" ? 1 : 0);
    expect(f.turn.questionLine !== "").toBe(verdict === "question");
  });

  it("leaves pending cells untouched if cancelled before iteration", async () => {
    const f = turnFixture();
    f.abort.abort("cancel");
    await f.run();
    expect(f.turn.queue).toHaveLength(1);
    expect(f.turn.doneWork).toEqual([]);
    expect(f.resolvers.completion).not.toHaveBeenCalled();
  });

  it("does not append tools if cancellation arrives during completion resolution", async () => {
    const f = turnFixture((completion) => {
      completion.responseCalls.push(responseCall("tool", "echo", "{}"));
      f.abort.abort("cancel");
    });
    await f.run();
    expect(f.host.admit).not.toHaveBeenCalled();
    expect(f.turn.queue).toEqual([]);
  });

  it("stops on a failed completion without classifying or admitting work", async () => {
    const f = turnFixture((completion) => {
      completion.fail("crash", "provider failed", "null");
    });
    await f.run();
    expect(f.host.classifyIntent).not.toHaveBeenCalled();
    expect(f.host.admit).not.toHaveBeenCalled();
    expect(f.turn.doneWork.find((cell) => cell instanceof ReACTChunk)).toMatchObject({
      decision: { kind: "blocked", reason: "provider-failed" },
    });
  });

  it("dispatches compact and program nodes to their resolvers", async () => {
    const f = turnFixture();
    const compact = new CompactJob({ reason: "user" });
    const program = new ProgrammaticJob({ toolCallId: "scheme", argsJson: "{}" });
    f.turn.queue.splice(0, 1, compact, program);
    await f.run();
    expect(f.resolvers.compact).toHaveBeenCalledWith(compact, f.abort.signal);
    expect(f.resolvers.work).toHaveBeenCalledWith(program, f.abort.signal);
    expect(f.resolvers.completion).not.toHaveBeenCalled();
  });

  it("does not advance the cursor when compact resolution cancels the turn", async () => {
    const f = turnFixture();
    const compact = new CompactJob({ reason: "user" });
    const next = new ReACTChunk();
    f.turn.queue.splice(0, 1, compact, next);
    f.resolvers.compact.mockImplementationOnce(async () => {
      f.abort.abort("park");
    });
    await f.run();
    expect(f.turn.doneWork).toEqual([compact]);
    expect(f.turn.queue).toEqual([next]);
  });

  it("an aborted work join stops before subsequent cells", async () => {
    const f = turnFixture();
    const tool = new SystemToolJob({ toolCallId: "tool", name: "echo", argsJson: "{}" });
    const next = new ReACTChunk();
    f.turn.queue.splice(0, 1, tool, next);
    f.resolvers.work.mockResolvedValueOnce("aborted");
    await f.run();
    expect(f.turn.queue).toEqual([next]);
    expect(f.turn.doneWork).toEqual([tool]);
  });

  it("splices a sitting steer onto the turn when the prompt round opens", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Done.";
    });
    admitSteer(f.session, prompt.user`keep AUTH_SECRET out`, f.turn.uuid);
    await f.run();
    expect({
      deck: f.session.steerQueue.map((row) => row.text),
      cells: f.turn.doneWork.filter((chunk) => chunk instanceof TurnSteerChunk).map((chunk) => chunk.steerText()),
    }).toEqual({ deck: [], cells: ["keep AUTH_SECRET out"] });
  });

  it("delivers steers to the running turn while an inbound head waits on it", async () => {
    const f = turnFixture(
      (completion) => {
        admitSteer(f.session, prompt.user`also check the tests`, f.turn.uuid);
        completion.responseText = "Done.";
      },
      (completion) => {
        completion.responseText = "Checked.";
      },
    );
    admitSteer(f.session, prompt.user`keep AUTH_SECRET out`, f.turn.uuid);
    f.session.enqueueAgentRequest("req", "caller", prompt.user`from a peer`);
    await f.run();
    expect({
      waiting: f.session.head !== f.turn && f.session.head?.turnTail === f.turn,
      deck: f.session.steerQueue.map((row) => row.text),
      cells: f.turn.doneWork.filter((chunk) => chunk instanceof TurnSteerChunk).map((chunk) => chunk.steerText()),
      rounds: f.completions().length,
    }).toEqual({
      waiting: true,
      deck: [],
      cells: ["keep AUTH_SECRET out", "also check the tests"],
      rounds: 2,
    });
  });

  it("mints one approval note per noted leaf and skips a leaf that already has one", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Done.";
    });
    const allowed = new SystemToolJob({
      toolCallId: "a",
      name: "edit_file",
      humanApprove: true,
      approvalComment: "keep the export",
    });
    const refused = new SystemToolJob({
      toolCallId: "b",
      name: "shell",
      humanApprove: false,
      approvalComment: "use ripgrep",
    });
    const silent = new SystemToolJob({ toolCallId: "c", name: "read_file", humanApprove: true });
    const machine = new SystemToolJob({
      toolCallId: "d",
      name: "write_file",
      approvalComment: "ignored",
    });
    const inner = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      humanApprove: true,
      approvalComment: "inner keep",
    });
    const bag = new ProgrammaticJob({ toolCallId: "p", argsJson: JSON.stringify({ expr: "1" }) });
    bag.pushInvocation(inner);
    for (const child of [allowed, refused, silent, machine, bag]) f.turn.pushChild(child);
    const prior = new TurnApprovalNoteChunk({
      leafId: refused.uuid,
      toolName: "shell",
      allowed: false,
      text: prompt.user`use ripgrep`,
    });
    f.turn.doneWork.push(prior, allowed, refused, silent, machine, bag);
    await f.run();
    const notes = f.turn.doneWork.filter((chunk) => chunk instanceof TurnApprovalNoteChunk);
    expect(notes.map((cell) => ({ leaf: cell.leafId, text: cell.approvalNoteText() }))).toEqual([
      {
        leaf: refused.uuid,
        text: "The user refused this tool use (shell) with this note:\n<note>\nuse ripgrep\n</note>",
      },
      {
        leaf: allowed.uuid,
        text: "The user allowed this tool use (edit_file) with this note:\n<note>\nkeep the export\n</note>",
      },
      {
        leaf: inner.uuid,
        text: "The user allowed this tool use (edit_file) with this note:\n<note>\ninner keep\n</note>",
      },
    ]);
  });

  it("packs pending notifications onto the turn and frees them when head leaves that turn", async () => {
    const f = turnFixture((completion) => {
      completion.responseText = "Done.";
    });
    const call = new AgentCallJob({ toolCallId: "c", name: "agent__send", background: true });
    const sealed = new AgentCallJob({
      toolCallId: "done",
      name: "agent__send",
      completed: true,
      background: true,
    });
    const bag = new ProgrammaticJob({ toolCallId: "bag", background: true });
    const live = new AgentCallNotification({ message: "from the call" });
    const ignored = new AgentCallNotification({ message: "already sealed" });
    const bagNote = new AgentCallNotification({ message: "from the bag" });
    const result = new AgentCallNotification({ message: "job job-scheme finished: cancelled", result: true });
    call.notifications.push(live);
    sealed.notifications.push(ignored);
    bag.notifications.push(bagNote, result);
    const producer = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [call, sealed, bag],
      reducerExited: true,
    });
    producer.pushChild(call);
    producer.pushChild(sealed);
    producer.pushChild(bag);
    f.turn.turnTail = producer;
    const before = f.session.pendingNotifications.map((note) => note.message);
    await f.run();
    const cell = f.turn.doneWork.find((chunk) => chunk instanceof TurnNotificationChunk);
    const afterClaim = f.session.pendingNotifications;
    const claimed = isNoteClaimed(live) && isNoteClaimed(result);
    f.session.head = producer;
    expect({
      before,
      packed: cell?.notificationText(),
      claimed,
      rewound: isNoteClaimed(live) || isNoteClaimed(result),
      afterClaim,
      afterRollback: f.session.pendingNotifications.map((note) => note.message),
    }).toEqual({
      before: ["from the call", "from the bag", "job job-scheme finished: cancelled"],
      packed: "from the call\nfrom the bag\njob job-scheme finished: cancelled",
      claimed: true,
      rewound: false,
      afterClaim: [],
      afterRollback: ["from the call", "from the bag", "job job-scheme finished: cancelled"],
    });
  });
});
