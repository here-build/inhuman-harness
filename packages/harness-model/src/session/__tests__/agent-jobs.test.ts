/**
 * Agent jobs are ToolCallJob siblings, not SystemToolJob.
 * Rosters and open callbacks live on the documents.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { documentRoot } from "../document-root.js";
import { PromptMessage } from "../expectations/PromptMessage.js";
import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { AgentCallNotification } from "../jobs/AgentCallNotification.js";
import { BotCallJob } from "../jobs/BotCallJob.js";
import { CallDelivery } from "../jobs/CallDelivery.js";
import { FailureOutcome, SuccessfulOutcome } from "../jobs/CallOutcome.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { isNoteClaimed } from "../SessionRoot.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { TurnNotificationChunk } from "../turn/notification-chunk.js";
import { SessionTurn } from "../turn/session-turn.js";
import { attached } from "./_helpers/fixtures.js";

describe("named-agent models", () => {
  beforeEach(() => resetLocalIDs());

  it("a Call notification claimed by a notice cell leaves the Call open", () => {
    const session = attached({ sessionId: "s-note", path: "/tmp/n" });
    const plexus = Plexus.bootstrap(session);
    const call = new AgentCallJob();
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(call);
    session.head = turn;
    const note = new AgentCallNotification({ message: "partial" });
    call.notifications.push(note);
    const before = {
      completed: call.completed,
      n: call.notifications.length,
      claimed: isNoteClaimed(note),
      home: documentRoot(call) === session,
      payload: call.observationPayload(),
    };
    session.head = new SessionTurn({
      turnTail: turn,
      doneWork: [new TurnNotificationChunk({ notifications: [note] })],
      queue: [],
    });
    expect({
      before,
      after: { claimed: isNoteClaimed(note), completed: call.completed, payload: call.observationPayload() },
    }).toEqual({
      before: { completed: false, n: 1, claimed: false, home: true, payload: "" },
      after: { claimed: true, completed: false, payload: "" },
    });
    plexus.destroy();
  });

  it("Call delivery is a child node, not JSON", () => {
    const session = attached({ sessionId: "s-deliv", path: "/tmp/d" });
    const plexus = Plexus.bootstrap(session);
    const call = new BotCallJob({
      delivery: new CallDelivery({ lifetime: "call" }),
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(call);
    session.head = turn;
    expect({
      lifetime: call.delivery?.lifetime,
      parent: call.delivery?.parent === call,
    }).toEqual({ lifetime: "call", parent: true });
    plexus.destroy();
  });

  it("prompt rows are the atoms; speech and systemPrompt are views", () => {
    const session = attached({ sessionId: "s-prompt", path: "/tmp/p" });
    const plexus = Plexus.bootstrap(session);
    const wire = new AgentCallJob({
      argsJson: JSON.stringify({ message: "from the wire" }),
      constitution: prompt.system`standing`,
    });
    const call = new AgentCallJob({
      argsJson: JSON.stringify({ message: "stale" }),
      constitution: prompt.system`stale system`,
      promptMessages: [
        new PromptMessage({ role: "system", content: "Be brief." }),
        new PromptMessage({ role: "assistant", content: "Answer" }),
        new PromptMessage({ role: "user", content: "Now" }),
      ],
    });
    const only = new AgentCallJob({
      promptMessages: [new PromptMessage({ role: "user", content: "only" })],
    });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
    turn.pushChild(wire);
    turn.pushChild(call);
    turn.pushChild(only);
    session.head = turn;
    expect({
      wireSpeech: wire.speech,
      wireSystem: wire.systemPrompt,
      speech: call.speech,
      system: call.systemPrompt,
      onlySpeech: only.speech,
      onlySystem: only.systemPrompt,
    }).toEqual({
      wireSpeech: "from the wire",
      wireSystem: "standing",
      speech: "assistant:\nAnswer\n\nNow",
      system: "Be brief.",
      onlySpeech: "only",
      onlySystem: "",
    });
    call.replaceSpeech("Now (checked)");
    expect({
      rows: call.promptMessages.map((row) => [row.role, row.content]),
      speech: call.speech,
      message: call.argString("message"),
      constitution: call.constitution,
    }).toEqual({
      rows: [
        ["system", "Be brief."],
        ["user", "Now (checked)"],
      ],
      speech: "Now (checked)",
      message: "stale",
      constitution: "stale system",
    });
    plexus.destroy();
  });

  it("Call outcome is success or failure child", () => {
    const session = attached({ sessionId: "s-out", path: "/tmp/o" });
    const plexus = Plexus.bootstrap(session);
    const answered = new AgentCallJob({
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify({ answer: 1 }) }),
    });
    const call = new AgentCallJob();
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(answered);
    turn.pushChild(call);
    session.head = turn;
    const ok = answered.outcome instanceof SuccessfulOutcome;
    call.settleResult(new FailureOutcome({ code: "denied", message: "use ripgrep" }));
    expect({
      ok,
      fail: call.outcome instanceof FailureOutcome,
      code: call.outcome instanceof FailureOutcome ? call.outcome.code : "",
      message: call.outcome instanceof FailureOutcome ? call.outcome.message : "",
      payload: call.observationPayload(),
    }).toEqual({
      ok: true,
      fail: true,
      code: "denied",
      message: "use ripgrep",
      payload: "use ripgrep",
    });
    plexus.destroy();
  });

  it("mid-motion is derived from the open turn and in-flight jobs", () => {
    const session = attached({ sessionId: "s-mid", path: "/tmp/mid" });
    const plexus = Plexus.bootstrap(session);
    const empty = {
      mid: session.isMidMotion(),
      turn: session.openTurn,
      tools: session.openToolCount,
      unfinished: session.unfinished,
    };
    const sitting = new AgentCallJob({ humanApprove: true });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(sitting);
    session.head = turn;
    const inflight = {
      mid: session.isMidMotion(),
      turn: session.openTurn,
      tools: session.openToolCount,
      unfinished: session.unfinished,
    };
    sitting.completed = true;
    const sealed = {
      mid: session.isMidMotion(),
      turn: session.openTurn,
      tools: session.openToolCount,
      unfinished: session.unfinished,
    };
    turn.questionLine = "Want me to proceed?";
    const questioned = session.unfinished;
    const prior = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    const nested = new AgentCallJob({
      humanApprove: true,
      orchestrationResult: true,
      workerSessionId: "w-tail",
    });
    prior.pushChild(nested);
    session.head = new SessionTurn({
      turnTail: prior,
      queue: [],
      reducerExited: true,
    });
    const nestedOpen = {
      mid: session.isMidMotion(),
      turn: session.openTurn,
      tools: session.openToolCount,
      unfinished: session.unfinished,
    };
    nested.completed = true;
    session.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    const openTurn = {
      mid: session.isMidMotion(),
      turn: session.openTurn,
      tools: session.openToolCount,
      period: session.periodArmed,
      unfinished: session.unfinished,
    };
    const watch = new ProgrammaticJob({
      toolName: "scheme_watch",
      periodWaitUntilMs: Date.now() + 60_000,
    });
    session.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
      doneWork: [watch],
    });
    expect({
      empty,
      inflight,
      sealed,
      questioned,
      nestedOpen,
      openTurn,
      watch: {
        mid: session.isMidMotion(),
        period: session.periodArmed,
        unfinished: session.unfinished,
      },
    }).toEqual({
      empty: { mid: false, turn: false, tools: 0, unfinished: "" },
      inflight: { mid: true, turn: false, tools: 1, unfinished: "tools" },
      sealed: { mid: false, turn: false, tools: 0, unfinished: "" },
      questioned: "question",
      nestedOpen: { mid: true, turn: false, tools: 1, unfinished: "tools" },
      openTurn: { mid: true, turn: true, tools: 0, period: false, unfinished: "turn" },
      watch: { mid: true, period: true, unfinished: "" },
    });
    plexus.destroy();
  });
});
