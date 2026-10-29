/**
 * Session inbox reconstructs empty on older documents; admit / demote
 * write cells.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  admitQueue,
  admitSteer,
  AgentCallJob,
  AgentCallNotification,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  demoteSteers,
  contextNeedRound,
  isTitledOnlyCompletion,
  ReACTChunk,
  responseCall,
  retractLastQueued,
  SessionAdmission,
  SessionTurnEvalSpec,
  steerFirstQueued,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "../index.js";

function replicaOf(owner: SessionPlexus): { readonly root: SessionPlexus["root"]; [Symbol.dispose](): void } {
  const doc = new Y.Doc({ guid: owner.doc.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc));
  const plexus = SessionPlexus.connect(doc);
  return {
    get root() {
      return plexus.root;
    },
    [Symbol.dispose]() {
      plexus.destroy();
      doc.destroy();
    },
  };
}

describe("Session admission decks", () => {
  beforeEach(() => resetLocalIDs());

  it("older replica has empty decks; admit / demote / steer-first / retract write cells", () => {
    const plexus = SessionPlexus.create("s-old-ad", "/tmp/old-ad");
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      queue: [],
    });
    using replica = replicaOf(plexus);
    const turn = plexus.root.head!;
    admitSteer(plexus.root, prompt.user`also`, turn.uuid);
    admitQueue(plexus.root, prompt.user`later`, turn.uuid);
    const demoted = demoteSteers(plexus.root);
    admitSteer(plexus.root, prompt.user`mid`, turn.uuid);

    const verbs = SessionPlexus.create("s-ad-verbs", "/tmp/ad-verbs");
    verbs.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
    });
    const verbsTurn = verbs.root.head!;
    admitQueue(verbs.root, prompt.user`a`, verbsTurn.uuid);
    admitQueue(verbs.root, prompt.user`b`, verbsTurn.uuid);
    const steered = steerFirstQueued(verbs.root);
    const retracted = retractLastQueued(verbs.root);
    expect({
      replica: {
        steer: replica.root.steerQueue,
        prompt: replica.root.promptQueue,
        workHasAdmission: replica.root.work.some((node) => node instanceof SessionAdmission),
      },
      demoted: demoted.map((row) => row.text),
      sitting: plexus.root.steerQueue.map((row) => row.text),
      verbs: {
        steered: steered?.text,
        retracted: retracted?.text,
        leftover: verbs.root.promptQueue.map((row) => row.text),
        steer: verbs.root.steerQueue.map((row) => row.text),
      },
    }).toEqual({
      replica: { steer: [], prompt: [], workHasAdmission: false },
      demoted: ["also"],
      sitting: ["mid"],
      verbs: { steered: "a", retracted: "b", leftover: [], steer: ["a"] },
    });
    plexus.destroy();
    verbs.destroy();
  });
});

describe("steerTurn", () => {
  beforeEach(() => resetLocalIDs());

  const open = (props: ConstructorParameters<typeof SessionTurn>[0] & object = {}) =>
    new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hi`, ...props });

  it.each([
    { name: "an interactive head takes the steer", want: true, turn: () => open() },
    {
      name: "a compact-only head does not",
      want: false,
      turn: () => open({ prompt: prompt.user``, queue: [new CompactJob({ reason: "user" })] }),
    },
    {
      name: "an eval head does not",
      want: false,
      turn: () => open({ evalSpec: new SessionTurnEvalSpec({ requestId: "req-st", permissionMode: "auto" }) }),
    },
    { name: "a cancelled head does not", want: false, turn: () => open({ cancelRequested: true }) },
    { name: "a closed head does not", want: false, turn: () => open({ reducerExited: true }) },
  ])("$name", (row) => {
    const plexus = SessionPlexus.create("s-st", "/tmp/st");
    const turn = row.turn();
    plexus.root.head = turn;
    expect(plexus.root.steerTurn === turn).toBe(row.want);
    plexus.destroy();
  });

  it("an inbound head waits on its running predecessor, which runs and takes the steer", () => {
    const plexus = SessionPlexus.create("s-st-in", "/tmp/st-in");
    const running = open();
    plexus.root.head = running;
    plexus.root.enqueueAgentRequest("req", "caller", prompt.user`from a peer`);
    const inbound = plexus.root.head!;
    const waiting = {
      chain: plexus.root.liveChain,
      running: plexus.root.findRunningTurn(),
      steer: plexus.root.steerTurn,
    };
    running.reducerExited = true;
    expect({
      waiting,
      closed: { running: plexus.root.findRunningTurn(), steer: plexus.root.steerTurn },
    }).toEqual({
      waiting: { chain: [inbound, running], running, steer: running },
      closed: { running: inbound, steer: inbound },
    });
    plexus.destroy();
  });
});

describe("running turn chrome", () => {
  beforeEach(() => resetLocalIDs());

  it("an ask on the running predecessor of a waiting inbound head is the session's ask", () => {
    const plexus = SessionPlexus.create("s-ask-in", "/tmp/ask-in");
    const leaf = new SystemToolJob({ toolCallId: "a", name: "shell", argsJson: "{}" });
    const running = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`work`, queue: [] });
    running.pushChild(leaf);
    running.doneWork.push(leaf);
    plexus.root.head = running;
    leaf.policyResult = "ask";
    plexus.root.enqueueAgentRequest("req", "caller", prompt.user`from a peer`);
    expect({
      waiting: plexus.root.head !== running,
      asking: plexus.root.asking,
      unfinished: plexus.root.unfinished,
    }).toEqual({ waiting: true, asking: true, unfinished: "ask" });
    plexus.destroy();
  });
});

describe("inbox claims", () => {
  beforeEach(() => resetLocalIDs());

  it("each claim moves the inbox onto the turn in one write transaction", () => {
    const plexus = SessionPlexus.create("s-claim", "/tmp/claim");
    const call = new AgentCallJob({ toolCallId: "c", name: "agent__send", background: true });
    call.notifications.push(new AgentCallNotification({ message: "from the call" }));
    const producer = new SessionTurn({ turnTail: new SessionSystemPrompt(), doneWork: [call], queue: [] });
    producer.pushChild(call);
    producer.reducerExited = true;
    plexus.root.head = producer;
    const leaves = ["a", "b"].map(
      (id) => new SystemToolJob({ toolCallId: id, name: "shell", humanApprove: true, approvalComment: `note ${id}` }),
    );
    const turn = new SessionTurn({ turnTail: producer, prompt: prompt.user`go`, doneWork: [...leaves], queue: [] });
    for (const leaf of leaves) turn.pushChild(leaf);
    plexus.root.head = turn;
    admitSteer(plexus.root, prompt.user`one`, turn.uuid);
    admitSteer(plexus.root, prompt.user`two`, turn.uuid);
    const writes = (claim: () => void): number => {
      let count = 0;
      const record = (tr: Y.Transaction) => {
        if (tr.changed.size > 0) count += 1;
      };
      plexus.doc.on("afterTransaction", record);
      claim();
      plexus.doc.off("afterTransaction", record);
      return count;
    };
    expect({
      approvals: writes(() => turn.claimApprovalNotes()),
      steers: writes(() => plexus.root.claimSteers(turn)),
      notices: writes(() => plexus.root.claimNotices(turn)),
      tape: turn.doneWork.map((cell) => cell.constructor.name),
      inbox: { steers: plexus.root.steerQueue.length, notices: plexus.root.pendingNotices.length },
    }).toEqual({
      approvals: 1,
      steers: 1,
      notices: 1,
      tape: [
        "SystemToolJob",
        "SystemToolJob",
        "TurnApprovalNoteChunk",
        "TurnApprovalNoteChunk",
        "TurnSteerChunk",
        "TurnSteerChunk",
        "TurnNotificationChunk",
      ],
      inbox: { steers: 0, notices: 0 },
    });
    plexus.destroy();
  });
});

function settledCompletion(outcome: "successful" | "failed"): CompletionJob {
  const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
  if (outcome === "successful") {
    node.succeed("settled", "", "null", { result: { text: "ok" } });
  } else {
    node.fail("settled", "boom", "null");
  }
  return new CompletionJob({ expectation: node });
}

function callsOf(names: readonly string[]) {
  return names.map((name, i) => responseCall(`c${i}`, name));
}

describe("isTitledOnlyCompletion", () => {
  it.each([
    ["empty prose plus only update_metadata", ["update_metadata"], "", true],
    ["prose plus metadata is not titled-only", ["update_metadata"], "done", false],
    ["empty prose plus only task remainder verbs", ["task__create", "task__start"], "", true],
    ["context_need alone is not a titled-only follow-up", ["context_need"], "", false],
    ["a real tool in the same round is not titled-only", ["update_metadata", "read_file"], "", false],
  ] as const)("%s", (_name, names, prose, want) => {
    expect(
      isTitledOnlyCompletion({
        responseText: prose,
        responseCalls: names.map((name) => ({ name, isSideChannel: name !== "read_file" })),
      }),
    ).toBe(want);
  });
});

describe("contextNeedRound", () => {
  it.each([
    ["empty context_need keeps the loop", ["context_need"], "", "keep"],
    ["speech with only context_need seals", ["context_need"], "tables lack archive columns", "seal"],
    ["context_need beside metadata is not this case", ["context_need", "update_metadata"], "", "other"],
    ["a real tool is not this case", ["context_need", "read_file"], "", "other"],
    ["no calls is not this case", [], "", "other"],
  ] as const)("%s", (_name, names, prose, want) => {
    const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
    node.setResponseCalls(callsOf(names));
    node.responseText = prose;
    expect(contextNeedRound(node)).toBe(want);
  });
});

describe("lastTurnIncomplete", () => {
  beforeEach(() => resetLocalIDs());

  it.each([
    {
      name: "successful last completion is a true finish",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [settledCompletion("successful")],
        }),
    },
    {
      name: "failed last completion needs a successor",
      want: true,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [settledCompletion("failed")],
        }),
    },
    {
      name: "cancelled ack needs a successor even after a successful completion",
      want: true,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          cancelRequested: true,
          cancelled: true,
          queue: [],
          doneWork: [settledCompletion("successful")],
        }),
    },
    {
      name: "cancelRequested without the cancelled ack is not a successor",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          cancelRequested: true,
          queue: [],
          doneWork: [settledCompletion("successful")],
        }),
    },
    {
      name: "cancelled ack with a live completion is not a successor",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          cancelRequested: true,
          cancelled: true,
          queue: [],
          doneWork: [
            new CompletionJob({
              expectation: new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` }),
            }),
          ],
        }),
    },
    {
      name: "trailing side-channel tool after a successful completion is a true finish",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [
            settledCompletion("successful"),
            new SystemToolJob({
              triggersReactLoop: false,
              tapeHidden: true,
              toolCallId: "m1",
              name: "update_metadata",
              argsJson: "{}",
              completed: true,
            }),
          ],
        }),
    },
    {
      name: "trailing ReACTChunk after a successful completion is a crash between rounds",
      want: true,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [settledCompletion("successful"), new ReACTChunk()],
        }),
    },
    {
      name: "open turn does not continue",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: false,
          queue: [],
          doneWork: [settledCompletion("failed")],
        }),
    },
    {
      name: "a successful compact cutoff is a finish",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [
            settledCompletion("successful"),
            new CompactJob({ reason: "overflow", standIn: "CARD", completed: true, keepTurns: 1 }),
          ],
        }),
    },
    {
      name: "a failed compact still needs a successor",
      want: true,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          queue: [],
          doneWork: [
            settledCompletion("successful"),
            new CompactJob({
              reason: "overflow",
              failed: true,
              notice: "couldn't compact — try again later",
              completed: true,
            }),
          ],
        }),
    },
    {
      name: "eval turn does not continue",
      want: false,
      turn: () =>
        new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`hi`,
          reducerExited: true,
          evalSpec: new SessionTurnEvalSpec({ requestId: "req-nc", permissionMode: "auto" }),
          queue: [],
          doneWork: [settledCompletion("failed")],
        }),
    },
  ])("$name", (row) => {
    const plexus = SessionPlexus.create("s-nc", "/tmp/nc");
    const turn = row.turn();
    plexus.root.head = turn;
    expect(turn.lastTurnIncomplete).toBe(row.want);
    plexus.destroy();
  });
});
