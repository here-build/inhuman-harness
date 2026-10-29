import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
  ReACTChunk,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  TurnPromptChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  emptyWaitChrome,
  leftoverJudgeCompletions,
  outcomeSnapOf,
  RESPONDING,
  schemeCellState,
  tapeTools,
  toolCellState,
  CONNECTING,
  USING_TOOLS,
  turnLiveness,
  askPaintHead,
  createAskTapeCut,
} from "../liveness.js";

function hostedTurn(opts: {
  name: string;
  argsJson: string;
  policyResult: "ask" | "policyApprove" | "deny" | "block";
  permissionMode?: "manual" | "auto" | "yolo";
}): { turn: SessionTurn; leaf: SystemToolJob } & Disposable {
  const plexus = SessionPlexus.create("s", "/tmp/p");
  const leaf = new SystemToolJob({
    toolCallId: "call_1",
    name: opts.name,
    argsJson: opts.argsJson,
    policyResult: opts.policyResult,
  });
  const cell = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    permissionMode: opts.permissionMode,
    doneWork: [leaf],
    queue: [],
  });
  cell.pushChild(leaf);
  plexus.root.head = cell;
  if (opts.permissionMode !== undefined) plexus.root.permissionMode = opts.permissionMode;
  return {
    turn: cell,
    leaf,
    [Symbol.dispose]() {
      plexus.destroy();
    },
  };
}

function turn(opts: {
  doneWork?: SessionTurn["doneWork"];
  queue?: SessionTurn["queue"];
  reducerExited?: boolean;
  cancelled?: boolean;
  cancelRequested?: boolean;
}): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: opts.doneWork ?? [],
    queue: opts.queue ?? [],
    reducerExited: opts.reducerExited ?? false,
    cancelled: opts.cancelled ?? false,
    cancelRequested: opts.cancelRequested ?? false,
  });
}

function connecting(startedAt: number | null = null, retryUntilMs: number | null = null) {
  return {
    kind: "connecting" as const,
    label: CONNECTING,
    elapsed: retryUntilMs != null,
    startedAt,
    retryUntilMs,
  };
}

function usingTools(startedAt: number | null = null, retryUntilMs: number | null = null) {
  return {
    kind: "using-tools" as const,
    label: USING_TOOLS,
    elapsed: retryUntilMs != null,
    startedAt,
    retryUntilMs,
  };
}

function responding(startedAt: number | null = null) {
  return {
    kind: "responding" as const,
    label: RESPONDING,
    elapsed: false,
    startedAt,
    retryUntilMs: null,
  };
}

function sealedRead(id = "call_1"): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
    outcomeJson: '{"ok":true}',
    completed: true,
  });
}

describe("liveness", () => {
  it.each([
    {
      name: "missing",
      setup: () => ({ cell: null, extra: {} }),
      live: "idle" as const,
      extra: {},
    },
    {
      name: "closed",
      setup: () => ({ cell: turn({ reducerExited: true, queue: [] }), extra: {} }),
      live: "idle" as const,
      extra: {},
    },
    {
      name: "closed + live completion",
      setup: () => ({
        cell: turn({
          reducerExited: true,
          doneWork: [new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c" }) })],
          queue: [],
        }),
        extra: {},
      }),
      live: "idle" as const,
      extra: {},
    },
    {
      name: "minted completion",
      setup: () => ({
        cell: turn({
          doneWork: [new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c" }) })],
          queue: [],
        }),
        extra: {},
      }),
      live: "running" as const,
      extra: {},
    },
    {
      name: "minted tool",
      setup: () => {
        const tool = new SystemToolJob({
          toolCallId: "call_1",
          name: "read_file",
          argsJson: '{"path":"a.ts"}',
        });
        return { cell: turn({ doneWork: [tool], queue: [] }), extra: { toolState: toolCellState(tool) } };
      },
      live: "running" as const,
      extra: { toolState: "live" },
    },
    {
      name: "queued ReACT",
      setup: () => {
        const cell = turn({ doneWork: [sealedRead()], queue: [new ReACTChunk()] });
        return {
          cell,
          extra: {
            open: cell.openWork,
            queued: cell.queuedContinuation,
            wait: emptyWaitChrome(cell),
          },
        };
      },
      live: "running" as const,
      extra: {
        open: false,
        queued: true,
        wait: connecting(),
      },
    },
    {
      name: "shifted TurnPromptChunk",
      setup: () => {
        const cell = turn({ doneWork: [new TurnPromptChunk()], queue: [] });
        return {
          cell,
          extra: {
            open: cell.openWork,
            queued: cell.queuedContinuation,
            wait: emptyWaitChrome(cell),
          },
        };
      },
      live: "running" as const,
      extra: {
        open: false,
        queued: true,
        wait: connecting(),
      },
    },
    {
      name: "shifted ReACT",
      setup: () => {
        const cell = turn({ doneWork: [sealedRead(), new ReACTChunk()], queue: [] });
        return {
          cell,
          extra: {
            open: cell.openWork,
            queued: cell.queuedContinuation,
            wait: emptyWaitChrome(cell),
          },
        };
      },
      live: "running" as const,
      extra: {
        open: false,
        queued: true,
        wait: connecting(),
      },
    },
    {
      name: "shifted ReACT + steer",
      setup: () => {
        const cell = turn({
          doneWork: [sealedRead(), new ReACTChunk(), new TurnSteerChunk({ text: prompt.user`more` })],
          queue: [],
        });
        return {
          cell,
          extra: {
            open: cell.openWork,
            queued: cell.queuedContinuation,
            wait: emptyWaitChrome(cell),
          },
        };
      },
      live: "running" as const,
      extra: {
        open: false,
        queued: true,
        wait: connecting(),
      },
    },
    {
      name: "sealed tool",
      setup: () => {
        const tool = sealedRead("t");
        const cell = turn({ doneWork: [tool], queue: [] });
        return {
          cell,
          extra: {
            open: cell.openWork,
            wait: emptyWaitChrome(cell),
            tools: tapeTools(cell).map((item) => item.toolCallId),
          },
        };
      },
      live: "running" as const,
      extra: {
        open: false,
        wait: connecting(),
        tools: ["t"],
      },
    },
  ])("turnLiveness: $name", ({ setup, live, extra }) => {
    const { cell, extra: got } = setup();
    expect({ live: turnLiveness(cell), ...got }).toEqual({ live, ...extra });
  });

  it.each([
    {
      name: "streaming thought",
      cell: () => {
        const thought = new CompletionExpectation({ connectionId: "c", model: "m" });
        thought.responseThought = "weighing";
        return turn({ doneWork: [new CompletionJob({ expectation: thought })], queue: [] });
      },
      wait: connecting(),
      live: "running" as const,
    },
    {
      name: "streaming speech",
      cell: () => {
        const speech = new CompletionExpectation({ connectionId: "c", model: "m" });
        speech.responseText = "hello";
        return turn({ doneWork: [new CompletionJob({ expectation: speech })], queue: [] });
      },
      wait: responding(),
      live: "running" as const,
    },
    {
      name: "live remainder",
      cell: () =>
        turn({
          doneWork: [
            new SystemToolJob({
              toolCallId: "call_1",
              name: "read_file",
              argsJson: '{"path":"a.ts"}',
              humanApprove: true,
            }),
          ],
          queue: [],
        }),
      wait: usingTools(),
      live: "running" as const,
    },
    {
      name: "live floor tool is the heartbeat",
      cell: () =>
        turn({
          doneWork: [
            new SystemToolJob({
              toolCallId: "call_1",
              name: "read_file",
              argsJson: '{"path":"a.ts"}',
            }),
          ],
          queue: [],
        }),
      wait: usingTools(),
      live: "running" as const,
    },
    {
      name: "live agent keeps the wait pin",
      cell: () =>
        turn({
          doneWork: [
            new AgentCallJob({
              toolCallId: "a",
              name: "agent__ask",
              argsJson: '{"spec":"explore","message":"map"}',
            }),
          ],
          queue: [],
        }),
      wait: {
        kind: "using-tools",
        label: "waiting for Explore agent",
        elapsed: false,
        startedAt: null,
        retryUntilMs: null,
      },
      live: "running" as const,
    },
    {
      name: "tools and agents share the pin",
      cell: () =>
        turn({
          doneWork: [
            new SystemToolJob({
              toolCallId: "call_1",
              name: "read_file",
              argsJson: '{"path":"a.ts"}',
            }),
            new AgentCallJob({
              toolCallId: "a",
              name: "agent__ask",
              argsJson: '{"spec":"explore","message":"map"}',
            }),
            new AgentCallJob({
              toolCallId: "b",
              name: "agent__ask",
              argsJson: '{"spec":"reviewer","message":"check"}',
            }),
          ],
          queue: [],
        }),
      wait: {
        kind: "using-tools",
        label: "using tools and waiting for Explore and Reviewer agents",
        elapsed: false,
        startedAt: null,
        retryUntilMs: null,
      },
      live: "running" as const,
    },
    {
      name: "hidden live floor tool keeps the wait pin",
      cell: () =>
        turn({
          doneWork: [
            new SystemToolJob({
              toolCallId: "call_1",
              name: "read_file",
              argsJson: '{"path":"a.ts"}',
            }),
          ],
          queue: [],
        }),
      wait: usingTools(),
      live: "running" as const,
    },
    {
      name: "waiting-for-you owns pin",
      cell: () =>
        turn({
          doneWork: [
            new SystemToolJob({
              toolCallId: "e1",
              name: "edit_file",
              argsJson: '{"path":"a.ts","old_string":"a","new_string":"b"}',
              policyResult: "ask",
            }),
          ],
          queue: [],
        }),
      wait: null,
      live: "waiting-for-you" as const,
    },
    {
      name: "cancel drops hanging wait",
      cell: () => {
        const hanging = new CompletionExpectation({ connectionId: "c", model: "m" });
        hanging.markStarted(1_000);
        return turn({
          doneWork: [new CompletionJob({ expectation: hanging })],
          queue: [new ReACTChunk()],
          cancelRequested: true,
        });
      },
      wait: null,
    },
    {
      name: "cancel requested drops sealed+ReACT wait",
      cell: () => turn({ doneWork: [sealedRead()], queue: [new ReACTChunk()], cancelRequested: true }),
      wait: null,
    },
    {
      name: "cancelled drops sealed+ReACT wait",
      cell: () => turn({ doneWork: [sealedRead()], queue: [new ReACTChunk()], cancelled: true }),
      wait: null,
    },
  ])("wait suppression: $name", ({ cell, wait, live }) => {
    const next = cell();
    expect({
      wait: emptyWaitChrome(next),
      ...(live === undefined ? {} : { live: turnLiveness(next) }),
    }).toEqual({
      wait,
      ...(live === undefined ? {} : { live }),
    });
  });

  it("empty live completion is connecting, not a tool pin", () => {
    const hanging = new CompletionExpectation({ connectionId: "c", model: "m" });
    hanging.markStarted(1_000);
    expect(emptyWaitChrome(turn({ doneWork: [new CompletionJob({ expectation: hanging })], queue: [] }))).toEqual(
      connecting(1_000),
    );
  });

  it("toolCellState distinguishes BODY fail from ok", () => {
    const fail = new SystemToolJob({
      toolCallId: "f",
      name: "read_file",
      argsJson: '{"path":"a.ts"}',
      outcomeJson: '{"ok":false,"text":"missing"}',
      completed: true,
    });
    const ok = new SystemToolJob({
      toolCallId: "o",
      name: "read_file",
      argsJson: '{"path":"a.ts"}',
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    expect({
      fail: toolCellState(fail),
      ok: toolCellState(ok),
      missing: outcomeSnapOf(fail)?.text,
    }).toEqual({
      fail: "fail",
      ok: "ok",
      missing: "missing",
    });
  });

  it("schemeCellState uses completed / outcomeJson, not isAsk", () => {
    const live = new ProgrammaticJob({
      toolCallId: "s",
      argsJson: '{"expr":"(+ 1 2)"}',
    });
    const fail = new ProgrammaticJob({
      toolCallId: "s2",
      argsJson: '{"expr":"x"}',
      outcomeJson: '{"ok":false,"text":"boom"}',
    });
    fail.completed = true;
    expect({ live: schemeCellState(live), fail: schemeCellState(fail) }).toEqual({
      live: "live",
      fail: "fail",
    });
  });

  it("needsHuman is waiting-for-you; auto remainder without a fail is still running", () => {
    using hosted = hostedTurn({
      name: "edit_file",
      argsJson: '{"path":"a.ts"}',
      policyResult: "ask",
    });
    using autoWrite = hostedTurn({
      name: "edit_file",
      argsJson: '{"path":"a.ts"}',
      policyResult: "ask",
      permissionMode: "auto",
    });
    using auto = hostedTurn({
      name: "shell",
      argsJson: '{"command":"curl x"}',
      policyResult: "ask",
      permissionMode: "auto",
    });
    const autoLive = { state: toolCellState(auto.leaf), live: turnLiveness(auto.turn) };
    auto.leaf.classifierAbstain = "judge crashed";
    expect({
      ask: {
        state: toolCellState(hosted.leaf),
        open: hosted.turn.openWork,
        live: turnLiveness(hosted.turn),
      },
      autoWrite: { state: toolCellState(autoWrite.leaf), live: turnLiveness(autoWrite.turn) },
      autoLive,
      autoFail: { state: toolCellState(auto.leaf), live: turnLiveness(auto.turn) },
    }).toEqual({
      ask: { state: "ask", open: true, live: "waiting-for-you" },
      // an in-workspace write in auto goes to the ask judge, like any other ask
      autoWrite: { state: "judging", live: "running" },
      autoLive: { state: "judging", live: "running" },
      autoFail: { state: "ask", live: "waiting-for-you" },
    });
  });

  it("leftover intern classifier PEW stays on the remainder leaf and keeps the row live", () => {
    using auto = hostedTurn({
      name: "shell",
      argsJson: '{"command":"curl x"}',
      policyResult: "ask",
      permissionMode: "auto",
    });
    const pew = new CompletionExpectation({
      connectionId: "lm-studio",
      model: "essentialai_rnj-1-instruct@q4_k_s",
    });
    pew.markStarted(1_000);
    auto.leaf.children.push(new CompletionJob({ expectation: pew }));
    expect({
      state: toolCellState(auto.leaf),
      live: turnLiveness(auto.turn),
      wait: emptyWaitChrome(auto.turn),
      leftover: leftoverJudgeCompletions(auto.turn).map((child) => child.model),
      skip: createAskTapeCut(auto.turn).skipTool(auto.leaf),
    }).toEqual({
      state: "judging",
      live: "running",
      wait: usingTools(1_000),
      leftover: ["essentialai_rnj-1-instruct@q4_k_s"],
      skip: false,
    });
  });

  it("ask lifecycle: tape cut then applying mutate head", () => {
    const applied = new SystemToolJob({
      toolCallId: "e1",
      name: "edit_file",
      argsJson: '{"path":"a.ts"}',
      humanApprove: true,
      completed: true,
      outcomeJson: '{"ok":true}',
    });
    const mid = new SystemToolJob({
      toolCallId: "e2",
      name: "edit_file",
      argsJson: '{"path":"b.ts"}',
      humanApprove: true,
      approvalComment: "keep the export",
    });
    const asked = new SystemToolJob({
      toolCallId: "e3",
      name: "edit_file",
      argsJson: '{"path":"c.ts"}',
      policyResult: "ask",
    });
    const waiting = new SystemToolJob({
      toolCallId: "e4",
      name: "edit_file",
      argsJson: '{"path":"d.ts"}',
    });
    const cutTurn = turn({ doneWork: [applied, mid, asked], queue: [waiting] });
    const cut = createAskTapeCut(cutTurn);
    const cutOracle = {
      skip: [cut.skipTool(applied), cut.skipTool(mid), cut.skipTool(asked), cut.skipScheme(), cut.skipTool(waiting)],
      live: turnLiveness(cutTurn),
    };

    const held = new SystemToolJob({
      toolCallId: "e1",
      name: "edit_file",
      argsJson: '{"path":"a.ts","old_string":"a","new_string":"b"}',
      humanApprove: true,
    });
    const later = new SystemToolJob({
      toolCallId: "e2",
      name: "read_file",
      argsJson: '{"path":"b.ts"}',
    });
    const applyingTurn = turn({ doneWork: [held], queue: [later] });
    const applyingCut = createAskTapeCut(applyingTurn);
    const applyingOracle = {
      head: askPaintHead(applyingTurn),
      skip: [applyingCut.skipTool(held), applyingCut.skipTool(later)],
      live: turnLiveness(applyingTurn),
    };

    held.receiptJson = '{"ok":true}';
    held.completed = true;
    const open = createAskTapeCut(applyingTurn);
    expect({
      cut: cutOracle,
      applying: applyingOracle,
      sealed: {
        head: askPaintHead(applyingTurn),
        skip: [open.skipTool(held), open.skipTool(later)],
      },
    }).toEqual({
      cut: { skip: [false, false, true, true, true], live: "waiting-for-you" },
      applying: { head: held, skip: [true, true], live: "running" },
      sealed: { head: null, skip: [false, false] },
    });
  });

  it("a later needsHuman leaf wins the pin over an applying mutate Diff", () => {
    const applying = new SystemToolJob({
      toolCallId: "e1",
      name: "edit_file",
      argsJson: '{"path":"a.ts","old_string":"a","new_string":"b"}',
      humanApprove: true,
    });
    const asked = new SystemToolJob({
      toolCallId: "e2",
      name: "edit_file",
      argsJson: '{"path":"b.ts","old_string":"c","new_string":"d"}',
      policyResult: "ask",
    });
    const cell = turn({ doneWork: [applying, asked], queue: [] });
    const cut = createAskTapeCut(cell);
    expect({
      head: askPaintHead(cell),
      skip: [cut.skipTool(applying), cut.skipTool(asked)],
    }).toEqual({
      head: asked,
      skip: [false, true],
    });
  });
});
