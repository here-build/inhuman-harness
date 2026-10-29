/**
 * Client agent projection: roster ∪ live one-shots, programs from the
 * work graph, glance overlay. Interned rows keep identity.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  KernelAgentRelation,
  KernelPlexus,
  KernelRoot,
  ProjectPlexus,
  SessionOverview,
  publishKernelSeat,
} from "@inhuman.tools/harness-model/kernel";
import {
  AgentCallJob,
  BotCallJob,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model/session";
import { autorun } from "mobx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRAWER_RECENT_SESSION_LIMIT,
  SESSION_FACE_ASK,
  SESSION_FACE_PAUSE,
  SESSION_FACE_PLAY,
  SESSION_FACE_QUESTION,
  flattenAgentDrawer,
  projectAgentDrawer,
  projectAgentMeter,
  projectRecentSessions,
  sessionOverviewMark,
} from "../client-agents-tree.js";
import { hostAskEscalateSessionId } from "../client-agents.js";
import { Client } from "../client.js";

describe("client agents", () => {
  beforeEach(() => resetLocalIDs());

  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client[Symbol.asyncDispose]();
  });

  it("projects roster, live one-shots, programs, and this-tape request", async () => {
    const client = openClient();
    const reviewerCall = new BotCallJob({
      toolCallId: "call-reviewer",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "reviewer", message: "check" }),
      workerSessionId: "w-reviewer",
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("lgtm") }),
    });
    const ask = new AgentCallJob({
      toolCallId: "call-ask",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "explore", message: "map the repo" }),
      workerSessionId: "w-ask",
    });
    const watch = new ProgrammaticJob({
      toolCallId: "watch-pr",
      background: true,
      argsJson: JSON.stringify({ expr: "(period)", period: "5m" }),
    });
    client.sessionRoot.botsRoster.reviewer = "w-reviewer";
    client.projectRoot.botsRoster.implementer = "w-impl";
    client.kernelRoot.botsRoster["web-research"] = "w-web";
    client.kernelRoot.sessions["w-reviewer"] = new SessionOverview({
      title: "Reviewing the diff",
      recipeScope: "session",
      specName: "reviewer",
      model: "haiku",
      lastMessageAt: 9,
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [reviewerCall, ask, watch],
      queue: [],
    });

    const reviewer = client.sessionAgents[0];
    const askAgent = client.oneShotAgents[0];
    expect({
      scopes: client.agents.map((row) => `${row.scope}:${row.specName}:${row.sessionId}`),
      session: {
        title: reviewer?.title,
        model: reviewer?.model,
        interacted: reviewer?.interacted,
        ourRequest: reviewer?.ourRequest,
        state: reviewer?.state,
        tempo: reviewer?.tempo,
      },
      persistent: {
        project: client.projectAgents.map((row) => ({
          spec: row.specName,
          interacted: row.interacted,
          ourRequest: row.ourRequest,
        })),
        global: client.globalAgents.map((row) => ({
          spec: row.specName,
          interacted: row.interacted,
        })),
      },
      oneShot: {
        spec: askAgent?.specName,
        ourRequest: askAgent?.ourRequest,
        state: askAgent?.state,
        tempo: askAgent?.tempo,
      },
      programs: client.programs.map((job) => job.toolCallId),
    }).toEqual({
      scopes: [
        "session:reviewer:w-reviewer",
        "project:implementer:w-impl",
        "global:web-research:w-web",
        "one-shot:explore:w-ask",
      ],
      session: {
        title: "Reviewing the diff",
        model: "haiku",
        interacted: true,
        ourRequest: "ok",
        state: "done",
        tempo: "idle",
      },
      persistent: {
        project: [{ spec: "implementer", interacted: false, ourRequest: "none" }],
        global: [{ spec: "web-research", interacted: false }],
      },
      oneShot: { spec: "explore", ourRequest: "open", state: "working", tempo: "active" },
      programs: ["watch-pr"],
    });

    const titles: string[] = [];
    const stop = autorun(() => {
      titles.push(client.sessionAgents[0]?.title ?? "");
    });
    client.kernelRoot.sessions["w-reviewer"]!.title = "Still reviewing";
    stop();
    expect(titles).toEqual(["Reviewing the diff", "Still reviewing"]);

    ask.completed = true;
    ask.receiptJson = JSON.stringify({ ok: true, text: "mapped" });
    const glance = client.kernelRoot.sessions["w-reviewer"]!;
    glance.midMotion = true;
    expect({
      oneShots: client.oneShotAgents.map((row) => row.sessionId),
      reviewer: client.sessionAgents[0] === reviewer,
      working: { state: reviewer?.state, tempo: reviewer?.tempo },
    }).toEqual({
      oneShots: [],
      reviewer: true,
      working: { state: "working", tempo: "active" },
    });
  });

  it("nests tape calls under a program", async () => {
    const client = openClient();
    const nestedA = new BotCallJob({
      toolCallId: "call-qa-a",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "qa", message: "check a" }),
      workerSessionId: "w-qa-a",
    });
    const nestedB = new BotCallJob({
      toolCallId: "call-qa-b",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "qa", message: "check b" }),
      workerSessionId: "w-qa-b",
    });
    const bag = new ProgrammaticJob({
      toolCallId: "bag-qa",
      background: true,
      argsJson: JSON.stringify({ expr: "(parallel)" }),
    });
    bag.pushInvocation(nestedA);
    bag.pushInvocation(nestedB);
    const explore = new AgentCallJob({
      toolCallId: "call-explore",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "explore", message: "map" }),
      workerSessionId: "w-explore",
    });
    const chief = new BotCallJob({
      toolCallId: "call-chief",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "chief", message: "steer" }),
      workerSessionId: "w-chief",
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("steered") }),
    });
    client.sessionRoot.botsRoster.chief = "w-chief";
    client.sessionRoot.botsRoster.idle = "w-idle";
    client.kernelRoot.sessions["w-explore"] = new SessionOverview({
      specName: "explore",
      status: "mapping",
      midMotion: true,
      oneShot: true,
    });
    client.kernelRoot.sessions["w-qa-a"] = new SessionOverview({
      specName: "qa",
      recipeScope: "session",
      midMotion: true,
    });
    client.kernelRoot.sessions["w-qa-b"] = new SessionOverview({
      specName: "qa",
      recipeScope: "session",
      asking: true,
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [bag, explore, chief],
      queue: [],
    });
    const drawer = projectAgentDrawer(client);
    expect({
      calls: drawer.calls.map((node) =>
        node.kind === "program"
          ? { kind: "program", key: node.program.key, kids: node.program.children.map((c) => c.spec) }
          : { kind: "call", spec: node.call.spec, oneShot: node.call.oneShot },
      ),
      collaborators: drawer.collaborators.map((row) => row.spec),
      rows: flattenAgentDrawer(drawer).map((row) => `${row.kind}:${row.spec}`),
    }).toEqual({
      calls: [
        { kind: "program", key: "program:bag-qa", kids: ["qa", "qa"] },
        { kind: "call", spec: "explore", oneShot: true },
        { kind: "call", spec: "chief", oneShot: false },
      ],
      collaborators: [],
      rows: ["call:qa", "call:qa", "call:explore"],
    });
    nestedA.completed = true;
    nestedA.receiptJson = JSON.stringify({ ok: true, text: "ok" });
    nestedB.completed = true;
    nestedB.receiptJson = JSON.stringify({ ok: true, text: "ok" });
    explore.completed = true;
    explore.receiptJson = JSON.stringify({ ok: true, text: "mapped" });
    delete client.kernelRoot.sessions["w-explore"];
    delete client.kernelRoot.sessions["w-qa-a"];
    delete client.kernelRoot.sessions["w-qa-b"];
    expect(
      flattenAgentDrawer(projectAgentDrawer(client))
        .filter((row) => row.kind === "call")
        .map((row) => row.spec),
    ).toEqual([]);
  });

  it("omitted-spec ask uses glance specName then Call faceName", async () => {
    const client = openClient();
    const analyze = new AgentCallJob({
      toolCallId: "call-analyze",
      name: "agent__ask",
      argsJson: JSON.stringify({ message: "ir" }),
      workerSessionId: "w-analyze",
      faceName: "analyze",
    });
    client.kernelRoot.sessions["w-analyze"] = new SessionOverview({
      specName: "analyze",
      status: "reading",
      midMotion: true,
      oneShot: true,
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [analyze],
      queue: [],
    });
    expect(flattenAgentDrawer(projectAgentDrawer(client)).map((row) => `${row.kind}:${row.spec}`)).toEqual([
      "call:analyze",
    ]);
    delete client.kernelRoot.sessions["w-analyze"];
    expect(flattenAgentDrawer(projectAgentDrawer(client)).map((row) => `${row.kind}:${row.spec}`)).toEqual([
      "call:analyze",
    ]);
    (analyze as { faceName: string | null }).faceName = null;
    expect(flattenAgentDrawer(projectAgentDrawer(client)).map((row) => `${row.kind}:${row.spec}`)).toEqual([
      "call:agent",
    ]);
  });

  it("flattens kernel nested worker calls under this-tape spawn", async () => {
    const client = openClient();
    const explore = new AgentCallJob({
      toolCallId: "call-explore",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "explore", message: "map" }),
      workerSessionId: "w-explore",
    });
    client.kernelRoot.sessions["w-explore"] = new SessionOverview({
      specName: "explore",
      status: "mapping",
      midMotion: true,
      oneShot: true,
    });
    client.kernelRoot.sessions["w-qa"] = new SessionOverview({
      specName: "qa",
      status: "checking",
      midMotion: true,
    });
    client.kernelRoot.agentCalls["rel-qa"] = new KernelAgentRelation({
      callerSessionId: "w-explore",
      workerSessionId: "w-qa",
      spec: "qa",
    });
    client.kernelRoot.agentCalls["rel-cycle"] = new KernelAgentRelation({
      callerSessionId: "w-qa",
      workerSessionId: "w-explore",
      spec: "explore",
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [explore],
      queue: [],
    });
    expect(
      flattenAgentDrawer(projectAgentDrawer(client)).map(
        (row) => `${row.kind}:${row.spec}:${row.indent}:${row.mark}:${row.recap}`,
      ),
    ).toEqual(["call:explore:0:active:mapping", "call:qa:1:active:checking"]);
    explore.completed = true;
    explore.receiptJson = JSON.stringify({ ok: true, text: "mapped" });
    expect(
      flattenAgentDrawer(projectAgentDrawer(client)).map(
        (row) => `${row.kind}:${row.spec}:${row.indent}:${row.mark}:${row.recap}`,
      ),
    ).toEqual(["call:qa:0:active:checking"]);
  });

  it("pals are keepAlive or conversations", async () => {
    const client = openClient();
    const doneA = new BotCallJob({
      toolCallId: "call-explore-a",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "explore", message: "first" }),
      workerSessionId: "w-explore",
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("a") }),
    });
    const doneB = new BotCallJob({
      toolCallId: "call-explore-b",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "explore", message: "second" }),
      workerSessionId: "w-explore",
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("b") }),
    });
    const live = new BotCallJob({
      toolCallId: "call-explore-c",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "explore", message: "third" }),
      workerSessionId: "w-explore",
    });
    const chiefLive = new BotCallJob({
      toolCallId: "call-chief-live",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "chief", message: "steer" }),
      workerSessionId: "w-chief",
    });
    const conversationDone = new BotCallJob({
      toolCallId: "call-conversation",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "notes", message: "hi" }),
      workerSessionId: "s-notes",
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("ok") }),
    });
    client.sessionRoot.botsRoster.explore = "w-explore";
    client.sessionRoot.botsRoster.chief = "w-chief";
    client.kernelRoot.sessions["w-explore"] = new SessionOverview({
      specName: "explore",
      recipeScope: "session",
      midMotion: true,
    });
    client.kernelRoot.sessions["w-chief"] = new SessionOverview({
      specName: "chief",
      recipeScope: "session",
      keepAlive: true,
      midMotion: true,
    });
    client.projectRoot.sessions["s-notes"] = "";
    client.kernelRoot.sessions["s-notes"] = new SessionOverview({
      title: "Notes",
      lastMessageAt: 4,
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [doneA, doneB, live, chiefLive, conversationDone],
      queue: [],
    });
    expect(projectAgentDrawer(client).collaborators.map((row) => `${row.spec}:${row.sessionId}`)).toEqual([
      "chief:w-chief",
      "Notes:s-notes",
    ]);
  });

  it("lists this-project conversations with a turn, includes current, caps at 20", async () => {
    const client = openClient();
    client.projectRoot.sessions[client.sessionId] = "";
    client.projectRoot.sessions["s-auth"] = "";
    client.projectRoot.sessions["s-docs"] = "";
    client.projectRoot.sessions["s-empty"] = "";
    client.projectRoot.sessions["s-other-project"] = "";
    client.kernelRoot.sessions[client.sessionId] = new SessionOverview({
      title: "Here",
      lastMessageAt: 150,
      status: "this tape",
    });
    client.kernelRoot.sessions["s-auth"] = new SessionOverview({
      title: "Auth refactor",
      lastMessageAt: 200,
      status: "cookie rotate",
    });
    client.kernelRoot.sessions["s-docs"] = new SessionOverview({
      title: "Docs pass",
      lastMessageAt: 100,
    });
    client.kernelRoot.sessions["s-empty"] = new SessionOverview({
      lastMessageAt: 99,
    });
    client.kernelRoot.sessions["s-other-project"] = new SessionOverview({
      title: "Other cwd",
      lastMessageAt: 30,
      recipeScope: "session",
    });
    client.kernelRoot.sessions["w-explore"] = new SessionOverview({
      specName: "explore",
      lastMessageAt: 40,
      oneShot: true,
    });
    for (let i = 0; i <= DRAWER_RECENT_SESSION_LIMIT; i += 1) {
      const id = `s-extra-${String(i).padStart(2, "0")}`;
      client.projectRoot.sessions[id] = "";
      client.kernelRoot.sessions[id] = new SessionOverview({
        title: id,
        lastMessageAt: i + 1,
      });
    }
    const extras = Array.from({ length: DRAWER_RECENT_SESSION_LIMIT - 3 }, (_, i) => {
      const n = DRAWER_RECENT_SESSION_LIMIT - i;
      return `s-extra-${String(n).padStart(2, "0")}`;
    });
    const drawer = projectAgentDrawer(client);
    expect({
      ids: drawer.sessions.map((row) => row.sessionId),
      first: drawer.sessions[0],
      hasCurrent: drawer.sessions.some((row) => row.sessionId === client.sessionId),
      hasEmpty: drawer.sessions.some((row) => row.sessionId === "s-empty"),
      hasWorker: drawer.sessions.some((row) => row.sessionId === "w-explore"),
      hasNamed: drawer.sessions.some((row) => row.sessionId === "s-other-project"),
      n: drawer.sessions.length,
    }).toEqual({
      ids: ["s-auth", client.sessionId, "s-docs", ...extras],
      first: {
        key: "session:s-auth",
        sessionId: "s-auth",
        title: "Auth refactor",
        status: "cookie rotate",
        model: "",
        lastMessageAt: 200,
        occupied: false,
        resident: false,
        periodArmed: false,
        openTurn: false,
        openToolCount: 0,
        unfinished: "",
        tempo: "idle",
        mark: "",
        lastPrompt: "",
        askLine: "",
        current: false,
      },
      hasCurrent: true,
      hasEmpty: false,
      hasWorker: false,
      hasNamed: false,
      n: DRAWER_RECENT_SESSION_LIMIT,
    });
  });

  it("speech-question unfinished is has a question, not license ask", () => {
    expect(
      sessionOverviewMark({
        current: false,
        occupied: false,
        resident: false,
        unfinished: "question",
        periodArmed: false,
      }),
    ).toBe(SESSION_FACE_QUESTION);
    expect(
      sessionOverviewMark({
        current: false,
        occupied: true,
        resident: false,
        unfinished: "ask",
        periodArmed: false,
      }),
    ).toBe(SESSION_FACE_ASK);
  });

  it("session face mark follows current, other seat, unfinished, daemon, and period", async () => {
    const client = openClient();
    client.projectRoot.sessions[client.sessionId] = "";
    client.projectRoot.sessions["s-other"] = "";
    client.projectRoot.sessions["s-ask"] = "";
    client.projectRoot.sessions["s-play"] = "";
    client.projectRoot.sessions["s-pause"] = "";
    client.projectRoot.sessions["s-bot"] = "";
    client.projectRoot.sessions["s-idle"] = "";
    client.kernelRoot.sessions[client.sessionId] = new SessionOverview({
      title: "Here",
      model: "grok",
      lastMessageAt: 70,
    });
    client.kernelRoot.sessions["s-other"] = new SessionOverview({
      title: "Other seat",
      model: "sonnet",
      lastMessageAt: 60,
      midMotion: true,
      openTurn: true,
    });
    client.kernelRoot.sessions["s-ask"] = new SessionOverview({
      title: "Needs you",
      lastMessageAt: 50,
      asking: true,
    });
    client.kernelRoot.sessions["s-play"] = new SessionOverview({
      title: "Daemon work",
      lastMessageAt: 40,
      resident: true,
      openToolCount: 1,
    });
    client.kernelRoot.sessions["s-pause"] = new SessionOverview({
      title: "Parked leftover",
      lastMessageAt: 30,
      openTurn: true,
    });
    client.kernelRoot.sessions["s-bot"] = new SessionOverview({
      title: "Watching",
      lastMessageAt: 20,
      resident: true,
      periodArmed: true,
    });
    client.kernelRoot.sessions["s-idle"] = new SessionOverview({
      title: "Quiet",
      lastMessageAt: 10,
    });
    publishKernelSeat(client.kernelPlexus.awareness, "s-other");
    const drawer = projectAgentDrawer(client);
    expect({
      face: [
        sessionOverviewMark({ current: true, occupied: true, resident: false, unfinished: "turn", periodArmed: false }),
        sessionOverviewMark({
          current: false,
          occupied: true,
          resident: false,
          unfinished: "turn",
          periodArmed: false,
        }),
        sessionOverviewMark({
          current: false,
          occupied: true,
          resident: false,
          unfinished: "tools",
          periodArmed: false,
        }),
        sessionOverviewMark({ current: false, occupied: true, resident: false, unfinished: "ask", periodArmed: false }),
        sessionOverviewMark({ current: false, occupied: true, resident: false, unfinished: "", periodArmed: false }),
        sessionOverviewMark({
          current: false,
          occupied: false,
          resident: false,
          unfinished: "turn",
          periodArmed: false,
        }),
        sessionOverviewMark({
          current: false,
          occupied: false,
          resident: true,
          unfinished: "tools",
          periodArmed: false,
        }),
        sessionOverviewMark({ current: false, occupied: false, resident: true, unfinished: "", periodArmed: true }),
        sessionOverviewMark({ current: false, occupied: false, resident: false, unfinished: "", periodArmed: true }),
        sessionOverviewMark({ current: false, occupied: false, resident: true, unfinished: "", periodArmed: false }),
      ],
      rows: drawer.sessions.map((row) => `${row.sessionId}:${row.unfinished}:${row.mark}`),
    }).toEqual({
      face: [
        "this session",
        "active",
        "active",
        SESSION_FACE_ASK,
        "idle",
        SESSION_FACE_PAUSE,
        SESSION_FACE_PLAY,
        "bot",
        "",
        "",
      ],
      rows: [
        `${client.sessionId}::this session`,
        `s-other:turn:active`,
        `s-ask:ask:${SESSION_FACE_PAUSE}`,
        `s-play:tools:${SESSION_FACE_PLAY}`,
        `s-pause:turn:${SESSION_FACE_PAUSE}`,
        `s-bot::bot`,
        `s-idle::`,
      ],
    });
  });

  it("escalates one-shot and session asks to the host; project, global, and host ask do not", async () => {
    const client = openClient();
    const ask = new AgentCallJob({
      toolCallId: "call-ask",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "explore", message: "map" }),
      workerSessionId: "w-ask",
    });
    client.sessionRoot.botsRoster.chief = "w-chief";
    client.projectRoot.botsRoster.impl = "w-impl";
    client.kernelRoot.botsRoster.web = "w-web";
    client.kernelRoot.sessions["w-ask"] = new SessionOverview({
      specName: "explore",
      oneShot: true,
      asking: true,
      unfinished: "ask",
    });
    client.kernelRoot.sessions["w-chief"] = new SessionOverview({
      specName: "chief",
      recipeScope: "session",
      keepAlive: true,
    });
    client.kernelRoot.sessions["w-impl"] = new SessionOverview({
      specName: "impl",
      recipeScope: "project",
      asking: true,
      unfinished: "ask",
    });
    client.kernelRoot.sessions["w-web"] = new SessionOverview({
      specName: "web",
      recipeScope: "global",
      asking: true,
      unfinished: "ask",
    });
    client.sessionRoot.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [ask],
      queue: [],
    });
    const oneShot = hostAskEscalateSessionId(client);
    client.kernelRoot.sessions["w-ask"]!.asking = false;
    client.kernelRoot.sessions["w-ask"]!.unfinished = "";
    client.kernelRoot.sessions["w-chief"]!.asking = true;
    client.kernelRoot.sessions["w-chief"]!.unfinished = "ask";
    const session = hostAskEscalateSessionId(client);
    client.kernelRoot.sessions["w-chief"]!.asking = false;
    client.kernelRoot.sessions["w-chief"]!.unfinished = "";
    const persistent = hostAskEscalateSessionId(client);
    client.kernelRoot.sessions["w-ask"]!.asking = true;
    client.kernelRoot.sessions["w-ask"]!.unfinished = "ask";
    const hostAsk = new SystemToolJob({
      toolCallId: "host-ask",
      name: "edit_file",
      argsJson: '{"path":"a.ts"}',
      policyResult: "ask",
    });
    const hostTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`go`,
      doneWork: [ask, hostAsk],
      queue: [],
    });
    hostTurn.pushChild(hostAsk);
    client.sessionRoot.head = hostTurn;
    expect({
      oneShot,
      session,
      persistent,
      hostWins: hostAskEscalateSessionId(client),
    }).toEqual({
      oneShot: "w-ask",
      session: "w-chief",
      persistent: null,
      hostWins: null,
    });
  });

  it("hydrated glance with null title and status is void", async () => {
    const client = openClient();
    client.projectRoot.sessions.old = "";
    client.kernelRoot.sessions.old = {
      title: null,
      status: null,
      lastMessageAt: 5,
    } as unknown as SessionOverview;
    expect(projectAgentMeter(client)).toBeNull();
    expect(projectRecentSessions(client)).toEqual([]);
  });

  function openClient(): Client {
    const client = new Client(
      "/tmp/k",
      "/tmp/p",
      "s",
      KernelPlexus.bootstrap(new KernelRoot()),
      ProjectPlexus.create("/tmp/p"),
      SessionPlexus.create("s", "/tmp/p"),
    );
    clients.push(client);
    return client;
  }
});
