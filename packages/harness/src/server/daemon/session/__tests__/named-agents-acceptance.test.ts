/** Live KernelDaemon / ProjectDaemon / SessionDaemon stack. */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  BotCallJob,
  CallJob,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  AskAgentSpec,
  CompletionExpectation,
  CompletionJob,
  documentRoot,
  FailureOutcome,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  tapeCompletion,
  SuccessfulOutcome,
  SystemToolJob,
  USER_REFUSED,
} from "@inhuman.tools/harness-model";
import { ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import { forceStopLoop, namedWorkerIds } from "@inhuman.tools/turn/agent-calls";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { recoverSessionJobs } from "@/runtime";
import { catalogRecipe } from "@/tool-catalog";
import { ToolCallHandler } from "@/tool-runtime";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { completeCallExceptionally } from "../agent-runtime.js";

function failOf(call: CallJob): { code: string; message: string } | null {
  const outcome = call.outcome;
  return outcome instanceof FailureOutcome ? { code: outcome.code, message: outcome.message } : null;
}

function okOf(call: CallJob): unknown {
  const outcome = call.outcome;
  return outcome instanceof SuccessfulOutcome ? outcome.value : outcome;
}

const TIMEOUT = 15_000;

const RECIPES = [
  catalogRecipe({
    name: "echo",
    recipeScope: "session",
    category: "internal",
    capabilities: [{ name: "ping", supportsNotify: true }],
    invokes: [],
  }),
  catalogRecipe({
    name: "linger",
    recipeScope: "session",
    category: "internal",
    keepAlive: true,
    capabilities: [{ name: "hold" }],
    invokes: [],
  }),
  catalogRecipe({
    name: "glob",
    recipeScope: "global",
    category: "internal",
    capabilities: [{ name: "once" }],
    invokes: [],
  }),
  catalogRecipe({
    name: "shelf",
    recipeScope: "project",
    category: "internal",
    capabilities: [{ name: "hold" }],
    invokes: [],
  }),
  catalogRecipe({
    name: "flash",
    recipeScope: "session",
    category: "internal",
    capabilities: [{ name: "once" }],
    invokes: [],
  }),
];

async function openHarness() {
  const system = await mkdtemp(join(tmpdir(), "harness-na-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-na-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  kernel.catalog.replaceRecipes(RECIPES);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("caller");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, project, session, system, workspace };
}

function closedTurn(child: CallJob | AgentCallbackJob | AgentMessageJob | AgentNotifyJob | SystemToolJob) {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(child);
  return turn;
}

function putCompletion(kernel: KernelDaemon, id: string, models: readonly string[]): void {
  const driver =
    kernel.plexus.root.drivers["openai-compat"] ??
    Object.values(kernel.plexus.root.drivers).find((row) => row.abilityClaim.includes("completion"));
  if (driver == null) throw new Error("no completion driver");
  const spec = new ConnectionSpec({ driver, name: id });
  spec.configuration = { baseUrl: "https://example.test/v1" };
  spec.live = { models: [...models] };
  spec.readyState = "ready";
  kernel.plexus.root.connections[id] = spec;
}

function workerDoc(id: string) {
  const plexus = SessionPlexus.create(id);
  onTestFinished(() => plexus.destroy());
  return plexus.root;
}

describe("named-agents §12 fixture", { timeout: 40_000 }, () => {
  beforeEach(() => resetLocalIDs());

  it("spawn doors: deny-before-license writes no roster; unknown recipe rejects; self-invoke; post-terminal no remint; replay same Call no remint", async () => {
    const { kernel, project, session } = await openHarness();

    const refused = new BotCallJob({
      toolCallId: "deny2",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "no" }),
      humanApprove: false,
    });
    session.root.head = closedTurn(refused);
    await when(() => refused.completed, { timeout: TIMEOUT });
    expect({
      orchestrated: refused.orchestrated,
      roster: session.root.botsRoster,
      completed: refused.completed,
      outcome: failOf(refused),
    }).toEqual({
      orchestrated: true,
      roster: {},
      completed: true,
      outcome: { code: "denied", message: USER_REFUSED },
    });

    const unlicensed = new BotCallJob({
      toolCallId: "deny",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "no" }),
    });
    session.root.head = closedTurn(unlicensed);
    await when(
      () =>
        unlicensed.workerSessionId !== "" &&
        project.kernel.sessionPlexus(unlicensed.workerSessionId)?.root.findTurnByAgentRequestId(unlicensed.uuid) !=
          null,
      { timeout: TIMEOUT },
    );
    expect({
      humanApprove: unlicensed.humanApprove,
      policyResult: unlicensed.policyResult,
      orchestrationResult: unlicensed.orchestrationResult,
      roster: session.root.botsRoster.echo !== undefined,
    }).toEqual({
      humanApprove: null,
      policyResult: null,
      orchestrationResult: true,
      roster: true,
    });

    const unknown = new BotCallJob({
      toolCallId: "u1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "ghost", message: "no" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(unknown);
    await when(() => unknown.completed, { timeout: TIMEOUT });
    expect({ unknown: failOf(unknown), roster: session.root.botsRoster.ghost }).toEqual({
      unknown: { code: "unknown_recipe", message: "unknown recipe ghost" },
      roster: undefined,
    });

    session.root.agent.spec.name = "echo";
    const echoId = session.root.botsRoster.echo;
    const self = new BotCallJob({
      toolCallId: "self",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "no" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(self);
    await when(() => self.completed, { timeout: TIMEOUT });
    expect({
      outcome: failOf(self),
      roster: session.root.botsRoster.echo,
      minted:
        Object.keys(project.sessions).includes(self.workerSessionId) &&
        self.workerSessionId !== "" &&
        project.kernel.sessionPlexus(self.workerSessionId)?.root.findTurnByAgentRequestId(self.uuid) != null,
    }).toEqual({
      outcome: { code: "denied", message: "echo cannot invoke echo" },
      roster: echoId,
      minted: false,
    });

    kernel.catalog.replaceRecipes([
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "other",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: [],
      }),
    ]);
    const undeclared = new BotCallJob({
      toolCallId: "c-deny",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "other", message: "no" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(undeclared);
    await when(() => undeclared.completed, { timeout: TIMEOUT });
    expect({ outcome: failOf(undeclared), roster: session.root.botsRoster.other }).toEqual({
      outcome: { code: "denied", message: "echo cannot invoke other" },
      roster: undefined,
    });
    session.root.agent.spec.name = "";
    kernel.catalog.replaceRecipes(RECIPES);

    const call = new BotCallJob({
      toolCallId: "rep",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(call);
    await when(
      () =>
        call.workerSessionId !== "" &&
        project.kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null,
      { timeout: TIMEOUT },
    );
    const first = call.workerSessionId;
    const worker = project.sessions[first]!;
    expect({
      roster: session.root.botsRoster.echo,
      name: call.name,
      row: worker.root.agentCallbacks[call.uuid],
      completed: call.completed,
      prompt: worker.root.head?.prompt,
      requestId: worker.root.head?.agentRequestId,
    }).toEqual({
      roster: first,
      name: "agent__send",
      row: session.root.sessionId,
      completed: false,
      prompt: "hi",
      requestId: call.uuid,
    });
    await session.park();
    const again = await project.session("caller");
    const liveWorker = await project.session(first);
    await when(() => call.workerSessionId === first && liveWorker.root.head?.agentRequestId === call.uuid, {
      timeout: TIMEOUT,
    });
    expect({ replay: call.workerSessionId }).toEqual({ replay: first });

    const voiding = new AgentCallbackJob({
      toolCallId: "v-sit",
      name: "agent__void",
      argsJson: JSON.stringify({ requestId: call.uuid }),
      humanApprove: true,
    });
    liveWorker.root.head = closedTurn(voiding);
    await when(() => call.completed && voiding.completed, { timeout: TIMEOUT });
    const handler = new ToolCallHandler(again.kernel);
    const ctx = { session: liveWorker.root, loadAgentCall: () => call };
    const late = handler.admit(
      {
        id: "late",
        type: "function",
        function: {
          name: "agent__respond",
          arguments: JSON.stringify({ requestId: call.uuid, response: "no" }),
        },
      },
      session.kernel.catalog,
      ctx,
    );
    const lateNotify = handler.admit(
      {
        id: "late-n",
        type: "function",
        function: {
          name: "agent__notify",
          arguments: JSON.stringify({ requestId: call.uuid, message: "no" }),
        },
      },
      session.kernel.catalog,
      ctx,
    );
    expect({
      row: worker.root.agentCallbacks[call.uuid],
      late: late instanceof AgentCallbackJob && late.completed && late.humanApprove === false,
      lateNotify: lateNotify instanceof AgentNotifyJob && lateNotify.completed && lateNotify.humanApprove === false,
    }).toEqual({ row: undefined, late: true, lateNotify: true });
  });

  it("Call lifecycle: enqueue sits until respond; void no tape; cancel no fabricate respond; turn close / notify do not complete", async () => {
    const { project, session } = await openHarness();
    const call = new BotCallJob({
      toolCallId: "c1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(call);
    await when(
      () =>
        call.workerSessionId !== "" && project.sessions[call.workerSessionId]?.root.head?.agentRequestId === call.uuid,
      { timeout: TIMEOUT },
    );
    const worker = project.sessions[call.workerSessionId]!;
    expect({
      roster: session.root.botsRoster.echo,
      row: worker.root.agentCallbacks[call.uuid],
      prompt: worker.root.head?.prompt,
      requestId: worker.root.head?.agentRequestId,
      completed: call.completed,
    }).toEqual({
      roster: call.workerSessionId,
      row: session.root.sessionId,
      prompt: "hi",
      requestId: call.uuid,
      completed: false,
    });
    const respond = new AgentCallbackJob({
      toolCallId: "r1",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: call.uuid, response: "pong" }),
      humanApprove: true,
    });
    worker.root.head = closedTurn(respond);
    await when(() => call.completed && worker.root.agentCallbacks[call.uuid] == null && respond.completed, {
      timeout: TIMEOUT,
    });
    expect({
      outcome: okOf(call),
      row: worker.root.agentCallbacks[call.uuid],
      respondDone: respond.completed,
    }).toEqual({
      outcome: "pong",
      row: undefined,
      respondDone: true,
    });

    const voidCall = new BotCallJob({
      toolCallId: "c-void",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(voidCall);
    await when(
      () =>
        voidCall.workerSessionId !== "" &&
        project.kernel.sessionPlexus(voidCall.workerSessionId)?.root.findTurnByAgentRequestId(voidCall.uuid) != null,
      { timeout: TIMEOUT },
    );
    const voidWorker = project.sessions[voidCall.workerSessionId]!;
    const note = new AgentNotifyJob({
      toolCallId: "n1",
      name: "agent__notify",
      argsJson: JSON.stringify({ requestId: voidCall.uuid, message: "partial" }),
      humanApprove: true,
    });
    voidWorker.root.head = closedTurn(note);
    await when(() => note.completed && voidCall.notifications.length === 1, { timeout: TIMEOUT });
    expect({
      callDone: voidCall.completed,
      notes: voidCall.notifications.map((row) => row.message),
      notifyHome: documentRoot(note) === voidWorker.root,
      callHome: documentRoot(voidCall) === session.root,
    }).toEqual({ callDone: false, notes: ["partial"], notifyHome: true, callHome: true });
    const voiding = new AgentCallbackJob({
      toolCallId: "v1",
      name: "agent__void",
      argsJson: JSON.stringify({ requestId: voidCall.uuid }),
      humanApprove: true,
    });
    voidWorker.root.head = closedTurn(voiding);
    await when(() => voidCall.completed && voiding.completed, { timeout: TIMEOUT });
    expect({
      value: voidCall.outcome instanceof SuccessfulOutcome ? voidCall.outcome.value : "unsettled",
      notes: voidCall.notifications.map((row) => row.message),
      row: voidWorker.root.agentCallbacks[voidCall.uuid],
    }).toEqual({ value: null, notes: ["partial"], row: undefined });

    const cancelled = new BotCallJob({
      toolCallId: "x1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(cancelled);
    await when(
      () =>
        cancelled.workerSessionId !== "" &&
        project.kernel.sessionPlexus(cancelled.workerSessionId)?.root.findTurnByAgentRequestId(cancelled.uuid) != null,
      { timeout: TIMEOUT },
    );
    const cancelledWorker = project.sessions[cancelled.workerSessionId]!;
    completeCallExceptionally(cancelled, { kernel: session.kernel, project, caller: session.root }, "cancelled");
    await when(() => cancelled.completed, { timeout: TIMEOUT });
    expect({
      outcome: failOf(cancelled),
      row: cancelledWorker.root.agentCallbacks[cancelled.uuid],
    }).toEqual({
      outcome: { code: "cancelled", message: "" },
      row: undefined,
    });

    const ask = new AgentCallJob({
      toolCallId: "c-ask-cancel",
      name: "agent__ask",
      argsJson: JSON.stringify({ message: "classify" }),
      voidLegal: false,
      humanApprove: true,
    });
    const askTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    askTurn.pushChild(ask);
    session.root.head = askTurn;
    await when(
      () =>
        ask.workerSessionId !== "" &&
        project.kernel.sessionPlexus(ask.workerSessionId)?.root.findTurnByAgentRequestId(ask.uuid) != null,
      { timeout: TIMEOUT },
    );
    const askWorker = project.sessions[ask.workerSessionId]!;
    await session.handleRequest("turn/cancel", { turnId: askTurn.uuid });
    await when(() => ask.completed && askWorker.root.agentCallbacks[ask.uuid] == null, {
      timeout: TIMEOUT,
    });
    expect({
      outcome: failOf(ask),
      row: askWorker.root.agentCallbacks[ask.uuid],
      workerClosed: askWorker.root.head?.reducerExited === true,
    }).toEqual({
      outcome: { code: "cancelled", message: "" },
      row: undefined,
      workerClosed: true,
    });

    const bg = new BotCallJob({
      toolCallId: "bg1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi", background: true }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
    });
    session.root.kvs.connection = "dummy";
    const bgTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [bg],
      reducerExited: false,
    });
    session.root.head = bgTurn;
    await when(
      () =>
        bg.orchestrated &&
        bg.workerSessionId !== "" &&
        project.kernel.sessionPlexus(bg.workerSessionId)?.root.findTurnByAgentRequestId(bg.uuid) != null &&
        bgTurn.reducerExited,
      {
        timeout: TIMEOUT,
      },
    );
    expect({ completed: bg.completed, orchestrated: bg.orchestrated }).toEqual({
      completed: false,
      orchestrated: true,
    });
    const bgWorker = project.sessions[bg.workerSessionId]!;
    const bgRespond = new AgentCallbackJob({
      toolCallId: "bg-r",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: bg.uuid, response: "later" }),
      humanApprove: true,
    });
    bgWorker.root.head = closedTurn(bgRespond);
    await when(() => bg.completed, { timeout: TIMEOUT });
    session.root.head = new SessionTurn({
      turnTail: session.root.head ?? new SessionSystemPrompt(),
      doneWork: [bg],
      queue: [],
      reducerExited: true,
    });
    expect({ outcome: okOf(bg), nextTurnSees: session.root.head.doneWork[0] === bg }).toEqual({
      outcome: "later",
      nextTurnSees: true,
    });
  });

  it("intern/park/restart: invoker park does not seal; message wakes; wrap same SessionRoot; second project does not steal; global survives detach; fresh kernel restores", async () => {
    const { kernel, project, session } = await openHarness();
    const call = new BotCallJob({
      toolCallId: "p1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(call);
    await when(
      () =>
        call.workerSessionId !== "" &&
        project.kernel.sessionPlexus(call.workerSessionId)?.root.findTurnByAgentRequestId(call.uuid) != null,
      { timeout: TIMEOUT },
    );
    const workerId = call.workerSessionId;
    const worker = project.sessions[workerId]!;
    const root = worker.root;
    const callerId = session.root.sessionId;
    void session.park();
    expect({ completed: call.completed, row: root.agentCallbacks[call.uuid] }).toEqual({
      completed: false,
      row: callerId,
    });

    const again = await project.session("caller");
    expect({
      roster: again.root.botsRoster.echo,
      sameRoot: project.sessions[workerId]?.root === root || again.kernel.liveSession(workerId)?.root === root,
    }).toEqual({ roster: workerId, sameRoot: true });

    void project.sessions[workerId]?.park();
    void kernel.liveSession(workerId)?.park();
    expect(kernel.liveSession(workerId)).toBeUndefined();
    const wake = new AgentMessageJob({
      toolCallId: "wake2",
      name: "agent__message",
      argsJson: JSON.stringify({ targetId: workerId, message: "wake" }),
      humanApprove: true,
    });
    again.root.head = closedTurn(wake);
    await when(() => wake.completed && kernel.liveSession(workerId) != null, { timeout: TIMEOUT });
    expect({
      send: wake.receiptJson,
      inbound: kernel.liveSession(workerId)?.root.head?.prompt.includes("message from") === true,
    }).toEqual({ send: JSON.stringify({ ok: true }), inbound: true });

    const liveWorker = kernel.liveSession(workerId) ?? project.sessions[workerId]!;
    const leftover = new SystemToolJob({
      toolCallId: "mid",
      name: "echo",
      argsJson: "{}",
    });
    const live = new SessionTurn({
      turnTail: liveWorker.root.head ?? new SessionSystemPrompt(),
      queue: [leftover],
      reducerExited: false,
    });
    live.orchestrationResult = true;
    liveWorker.root.head = live;
    expect(root.isMidMotion()).toBe(true);
    void liveWorker.park();
    expect(project.sessions[workerId]).toBeUndefined();
    const reopened = await project.session(workerId);
    expect({
      same: reopened.root === root,
      leftover: leftover.completed === false,
      row: reopened.root.agentCallbacks[call.uuid],
    }).toEqual({ same: true, leftover: true, row: session.root.sessionId });
    leftover.completed = true;
    leftover.receiptJson = JSON.stringify({ ok: true });
    live.reducerExited = true;
    void reopened.park();
    expect(root.isMidMotion()).toBe(false);
    expect(project.sessions[workerId]).toBeUndefined();
    await project.bootstrapMidMotionNamed();
    expect(project.sessions[workerId]).toBeUndefined();
    const caller = await project.session("caller");
    expect({ roster: caller.root.botsRoster.echo, wrapped: project.sessions[workerId] != null }).toEqual({
      roster: workerId,
      wrapped: false,
    });

    const glob = new BotCallJob({
      toolCallId: "boot",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "glob", message: "g" }),
      humanApprove: true,
    });
    caller.root.head = closedTurn(glob);
    await when(
      () =>
        glob.workerSessionId !== "" &&
        project.kernel.sessionPlexus(glob.workerSessionId)?.root.findTurnByAgentRequestId(glob.uuid) != null,
      { timeout: TIMEOUT },
    );
    const globId = glob.workerSessionId;
    const globWorker = kernel.liveSession(globId)!;
    const globRoot = globWorker.root;
    const globLeft = new SystemToolJob({
      toolCallId: "gmid",
      name: "echo",
      argsJson: "{}",
    });
    const globLive = new SessionTurn({
      turnTail: globWorker.root.head ?? new SessionSystemPrompt(),
      queue: [globLeft],
      reducerExited: false,
    });
    globLive.orchestrationResult = true;
    globWorker.root.head = globLive;
    void globWorker.park();
    expect(kernel.liveSession(globId)).toBeUndefined();
    expect(globRoot.isMidMotion()).toBe(true);
    await kernel.project(kernel.root).bootstrapMidMotionNamed();
    expect(kernel.liveSession(globId)?.root).toBe(globRoot);
    globLeft.completed = true;
    globLeft.receiptJson = JSON.stringify({ ok: true });
    globLive.reducerExited = true;
    void kernel.liveSession(globId)?.park();
    await kernel.project(kernel.root).bootstrapMidMotionNamed();
    expect({
      idleOff: kernel.liveSession(globId) === undefined,
      roster: kernel.plexus.root.botsRoster.glob,
    }).toEqual({ idleOff: true, roster: globId });

    const steal = new BotCallJob({
      toolCallId: "g2",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "glob", message: "g" }),
      humanApprove: true,
    });
    caller.root.head = closedTurn(steal);
    await when(
      () =>
        steal.workerSessionId !== "" &&
        project.kernel.sessionPlexus(steal.workerSessionId)?.root.findTurnByAgentRequestId(steal.uuid) != null,
      { timeout: TIMEOUT },
    );
    const first = kernel.liveSession(steal.workerSessionId);
    const workspace2 = await mkdtemp(join(tmpdir(), "harness-na-p2-"));
    const other = new ProjectDaemon(kernel, workspace2);
    await other.ready;
    onTestFinished(() => other[Symbol.dispose]());
    const stolen = await other.session(steal.workerSessionId);
    expect({ same: stolen === first, owned: other.sessions[steal.workerSessionId] === undefined }).toEqual({
      same: true,
      owned: true,
    });

    const system = await realpath(await mkdtemp(join(tmpdir(), "agent-regression-k-")));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "agent-regression-p-")));
    const restoreKernel = new KernelDaemon(system);
    onTestFinished(() => restoreKernel[Symbol.dispose]());
    await restoreKernel.ready;
    restoreKernel.catalog.replaceRecipes([
      catalogRecipe({
        name: "worker",
        category: "internal",
        recipeScope: "session",
        capabilities: [{ name: "run", supportsNotify: true }],
        invokes: ["leaf"],
      }),
      catalogRecipe({
        name: "leaf",
        category: "internal",
        recipeScope: "session",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "global",
        category: "internal",
        recipeScope: "global",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "project",
        category: "internal",
        recipeScope: "project",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
    ]);
    const restoreProject = new ProjectDaemon(restoreKernel, workspace);
    const restoreCaller = await restoreProject.session("caller");
    const restoreCall = new BotCallJob({
      toolCallId: "call-global",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "global", message: "work" }),
      humanApprove: true,
    });
    restoreCaller.root.head = closedTurn(restoreCall);
    await when(
      () =>
        restoreCall.workerSessionId !== "" &&
        restoreKernel.sessionPlexus(restoreCall.workerSessionId)?.root.head != null,
      { timeout: TIMEOUT },
    );
    const restoreWorker = restoreKernel.liveSession(restoreCall.workerSessionId)!;
    expect({ otherProject: restoreWorker.project !== restoreProject, path: restoreWorker.root.path }).toEqual({
      otherProject: true,
      path: system,
    });
    restoreProject[Symbol.dispose]();
    expect(restoreKernel.liveSession(restoreCall.workerSessionId)).toBe(restoreWorker);
    restoreWorker.root.head = closedTurn(
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({ requestId: restoreCall.uuid, response: "after detach" }),
        humanApprove: true,
      }),
    );
    await when(() => restoreCall.completed, { timeout: TIMEOUT });
    expect({ detach: okOf(restoreCall) }).toEqual({ detach: "after detach" });
    const restoreRecipes = [
      catalogRecipe({
        name: "worker",
        category: "internal",
        recipeScope: "session",
        capabilities: [{ name: "run", supportsNotify: true }],
        invokes: ["leaf"],
      }),
      catalogRecipe({
        name: "leaf",
        category: "internal",
        recipeScope: "session",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "global",
        category: "internal",
        recipeScope: "global",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "project",
        category: "internal",
        recipeScope: "project",
        capabilities: [{ name: "run" }],
        invokes: [],
      }),
    ];
    restoreKernel[Symbol.dispose]();

    const freshSystem = await realpath(await mkdtemp(join(tmpdir(), "agent-restore-k-")));
    const freshWorkspace = await realpath(await mkdtemp(join(tmpdir(), "agent-restore-p-")));
    const freshKernel = new KernelDaemon(freshSystem);
    await freshKernel.ready;
    freshKernel.catalog.replaceRecipes(restoreRecipes);
    const freshProject = new ProjectDaemon(freshKernel, freshWorkspace);
    const freshCaller = await freshProject.session("caller");
    const freshCall = new BotCallJob({
      toolCallId: "call-global-2",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "global", message: "work" }),
      humanApprove: true,
    });
    freshCaller.root.head = closedTurn(freshCall);
    await when(
      () =>
        freshCall.workerSessionId !== "" &&
        freshKernel.sessionPlexus(freshCall.workerSessionId)?.root.findTurnByAgentRequestId(freshCall.uuid) != null &&
        freshKernel.sessionPlexus(freshCall.workerSessionId)?.root.head != null,
      { timeout: TIMEOUT },
    );
    const freshWorker = freshKernel.liveSession(freshCall.workerSessionId)!;
    freshWorker.root.kvs.connection = "dummy";
    const running = new SessionTurn({ turnTail: freshWorker.root.head!, prompt: prompt.user`resume me` });
    freshWorker.root.head = running;
    await when(() => running.work.some((work) => tapeCompletion(work) != null), {
      timeout: TIMEOUT,
    });
    void freshWorker.park();
    const interrupted = new SystemToolJob({
      name: "shell",
      toolCallId: "interrupted",
      humanApprove: true,
      orchestrationResult: true,
    });
    const received = new SystemToolJob({
      name: "shell",
      toolCallId: "received",
      humanApprove: true,
      orchestrationResult: true,
      outcomeJson: '{"ok":true,"text":"already executed"}',
    });
    running.pushChild(interrupted);
    running.pushChild(received);
    const interruptedId = interrupted.uuid;
    const receivedId = received.uuid;
    const id = freshWorker.sessionId;
    const requestId = freshCall.uuid;
    const projectWorker = await freshProject.session("project-worker");
    projectWorker.root.agent.spec.name = "project";
    projectWorker.root.agent.spec.recipeScope = "project";
    freshProject.root.botsRoster.project = projectWorker.sessionId;
    projectWorker.root.kvs.connection = "dummy";
    projectWorker.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`project resume`,
    });
    await when(
      () => {
        const head = projectWorker.root.head;
        return head instanceof SessionTurn && head.work.some((work) => tapeCompletion(work) != null);
      },
      { timeout: TIMEOUT },
    );
    freshKernel[Symbol.dispose]();
    await Promise.resolve();
    const restored = new KernelDaemon(freshSystem);
    onTestFinished(() => restored[Symbol.dispose]());
    await restored.ready;
    expect(restored.plexus.root.botsRoster.global).toBe(id);
    expect(restored.sessionPlexus(id)?.root.head?.prompt).toBe("resume me");
    expect(restored.sessionPlexus(id)?.root.isMidMotion()).toBe(true);
    expect(restored.liveSession(id)).toBeUndefined();
    const resumed = (await restored.attachSession(id))!;
    const projectResumed = await restored.project(freshWorkspace).session("project-worker");
    expect({
      defined: resumed != null,
      newRoot: resumed.root !== freshWorker.root,
      prompt: resumed.root.head!.prompt,
      callback: resumed.root.agentCallbacks[requestId],
      interrupted: resumed.plexus.loadEntity<SystemToolJob>(interruptedId)?.receiptJson,
      received: resumed.plexus.loadEntity<SystemToolJob>(receivedId)?.receiptJson,
      projectPrompt: projectResumed.root.head!.prompt,
      pending: restored.sessionPlexus("caller")!.loadEntity<BotCallJob>(requestId)!.completed,
    }).toEqual({
      defined: true,
      newRoot: true,
      prompt: "resume me",
      callback: "caller",
      interrupted: expect.stringContaining("execution outcome unknown"),
      received: expect.stringContaining("already executed"),
      projectPrompt: "project resume",
      pending: false,
    });
    const pending = restored.sessionPlexus("caller")!.loadEntity<BotCallJob>(requestId)!;
    const respond = new AgentCallbackJob({
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId, response: "after restart" }),
      humanApprove: true,
    });
    resumed.root.head = closedTurn(respond);
    await when(() => pending.completed && respond.completed, { timeout: TIMEOUT });
    expect({
      outcome: okOf(pending),
      row: resumed.root.agentCallbacks[requestId],
    }).toEqual({
      outcome: "after restart",
      row: undefined,
    });
  });

  it("one-shot vs session recipe: identity, no send-by-name, reattach via workerSessionId, model overlay, schema, parent roster vs own", async () => {
    const { kernel, project, session } = await openHarness();
    const identity = new AgentCallJob({
      toolCallId: "c-eph",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "flash", message: "hi" }),

      humanApprove: true,
    });
    session.root.head = closedTurn(identity);
    await when(
      () =>
        identity.workerSessionId !== "" &&
        project.sessions[identity.workerSessionId]?.root.agent.spec instanceof AskAgentSpec,
      { timeout: TIMEOUT },
    );
    const flashWorker = project.sessions[identity.workerSessionId]!;
    const byName = new AgentMessageJob({
      toolCallId: "m1",
      name: "agent__message",
      argsJson: JSON.stringify({ targetName: "echo", message: "no" }),
      humanApprove: true,
    });
    flashWorker.root.head = closedTurn(byName);
    await when(() => byName.completed, { timeout: TIMEOUT });
    expect({
      kind: flashWorker.root.agent.spec instanceof AskAgentSpec,
      scope: flashWorker.root.agent.spec.recipeScope,
      name: flashWorker.root.agent.spec.name,
      roster: session.root.botsRoster.flash,
      send: byName.receiptJson,
    }).toEqual({
      kind: true,
      scope: "",
      name: "flash",
      roster: undefined,
      send: JSON.stringify({ ok: false, text: "undeliverable" }),
    });

    const workerId = identity.workerSessionId;
    const parkedRoot = project.sessions[workerId]!.root;
    void project.sessions[workerId]!.park();
    void session.park();
    const again = await project.session("caller");
    expect({
      roster: again.root.botsRoster.flash,
      worker: project.sessions[workerId]?.root === parkedRoot,
      id: identity.workerSessionId,
    }).toEqual({ roster: undefined, worker: true, id: workerId });

    const a = new AgentCallJob({
      toolCallId: "os-a",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "a" }),
      voidLegal: false,

      humanApprove: true,
    });
    const b = new AgentCallJob({
      toolCallId: "os-b",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "b" }),
      voidLegal: false,

      humanApprove: true,
    });
    const pair = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    pair.pushChild(a);
    pair.pushChild(b);
    again.root.head = pair;
    await when(
      () =>
        a.workerSessionId !== "" &&
        project.kernel.sessionPlexus(a.workerSessionId)?.root.findTurnByAgentRequestId(a.uuid) != null &&
        b.workerSessionId !== "" &&
        project.kernel.sessionPlexus(b.workerSessionId)?.root.findTurnByAgentRequestId(b.uuid) != null,
      { timeout: TIMEOUT },
    );
    const osWorker = project.sessions[a.workerSessionId]!;
    expect({
      kind: osWorker.root.agent.spec instanceof AskAgentSpec,
      name: osWorker.root.agent.spec.name,
      keepAlive: osWorker.root.agent.spec.keepAlive,
      roster: again.root.botsRoster.echo,
      distinct: a.workerSessionId !== b.workerSessionId,
    }).toEqual({
      kind: true,
      name: "echo",
      keepAlive: false,
      roster: undefined,
      distinct: true,
    });
    const ownName = new AgentMessageJob({
      toolCallId: "os-m1",
      name: "agent__message",
      argsJson: JSON.stringify({ targetName: "echo", message: "no" }),
      humanApprove: true,
    });
    osWorker.root.head = closedTurn(ownName);
    await when(() => ownName.completed, { timeout: TIMEOUT });
    expect({ ownRoster: ownName.receiptJson }).toEqual({
      ownRoster: JSON.stringify({ ok: false, text: "undeliverable" }),
    });

    const sessionSchema = new BotCallJob({
      toolCallId: "c-schema",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      voidLegal: false,
      responseSchema: { type: "string" },
      humanApprove: true,
    });
    again.root.head = closedTurn(sessionSchema);
    await when(() => sessionSchema.completed, { timeout: TIMEOUT });
    const askSchema = new BotCallJob({
      toolCallId: "c-schema-ask",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      voidLegal: false,
      responseSchema: { type: "string" },
      humanApprove: true,
    });
    again.root.head = closedTurn(askSchema);
    await when(() => askSchema.completed, { timeout: TIMEOUT });
    const legal = new AgentCallJob({
      toolCallId: "os-schema",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      voidLegal: false,

      responseSchema: { type: "string" },
      humanApprove: true,
    });
    again.root.head = closedTurn(legal);
    await when(
      () =>
        legal.workerSessionId !== "" &&
        project.kernel.sessionPlexus(legal.workerSessionId)?.root.findTurnByAgentRequestId(legal.uuid) != null,
      { timeout: TIMEOUT },
    );
    expect({
      send: failOf(sessionSchema),
      ask: failOf(askSchema),
      roster: again.root.botsRoster.echo,
      legal: {
        completed: legal.completed,
        kind: project.sessions[legal.workerSessionId]!.root.agent.spec instanceof AskAgentSpec,
        name: project.sessions[legal.workerSessionId]!.root.agent.spec.name,
        roster: again.root.botsRoster.echo,
      },
    }).toEqual({
      send: {
        code: "schema_requires_one_shot",
        message: "Structured output schema can only be used with agent/ask",
      },
      ask: {
        code: "schema_requires_one_shot",
        message: "Structured output schema can only be used with agent/ask",
      },
      roster: undefined,
      legal: { completed: false, kind: true, name: "echo", roster: undefined },
    });

    putCompletion(kernel, "openai", ["chatgpt-5.6-luna"]);
    again.root.applyKvs([
      { form: "kv-set", key: "connection", value: "caller-wire" },
      { form: "kv-set", key: "model", value: "caller-model" },
    ]);
    const pinned = new AgentCallJob({
      toolCallId: "os-pin",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "hi", model: "openai/chatgpt-5.6-luna" }),
      voidLegal: false,

      humanApprove: true,
    });
    const ghost = new AgentCallJob({
      toolCallId: "os-ghost",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "hi", model: "openai/nope" }),
      voidLegal: false,

      humanApprove: true,
    });
    const models = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    models.pushChild(pinned);
    models.pushChild(ghost);
    again.root.head = models;
    await when(
      () =>
        pinned.workerSessionId !== "" &&
        project.kernel.sessionPlexus(pinned.workerSessionId)?.root.findTurnByAgentRequestId(pinned.uuid) != null &&
        ghost.completed,
      { timeout: TIMEOUT },
    );
    const pinnedWorker = project.sessions[pinned.workerSessionId]!;
    expect({
      connection: pinnedWorker.root.kvs.connection,
      model: pinnedWorker.root.kvs.model,
      ghost: failOf(ghost),
      usage: kernel.plexus.root.modelsUsage["openai/chatgpt-5.6-luna"],
    }).toEqual({
      connection: "openai",
      model: "chatgpt-5.6-luna",
      ghost: { code: "bad_model", message: "unknown model nope on openai" },
      usage: undefined,
    });

    kernel.catalog.replaceRecipes([
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "implementer",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: ["echo"],
      }),
    ]);
    const send = new BotCallJob({
      toolCallId: "reuse-send",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    again.root.head = closedTurn(send);
    await when(
      () =>
        send.workerSessionId !== "" &&
        project.kernel.sessionPlexus(send.workerSessionId)?.root.findTurnByAgentRequestId(send.uuid) != null,
      { timeout: TIMEOUT },
    );
    const parentEcho = send.workerSessionId;
    const ask = new BotCallJob({
      toolCallId: "reuse-ask",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "again" }),
      voidLegal: false,
      humanApprove: true,
    });
    again.root.head = closedTurn(ask);
    await when(
      () =>
        ask.workerSessionId !== "" &&
        project.kernel.sessionPlexus(ask.workerSessionId)?.root.findTurnByAgentRequestId(ask.uuid) != null,
      { timeout: TIMEOUT },
    );
    const oneShot = new AgentCallJob({
      toolCallId: "os-echo",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "once" }),
      voidLegal: false,

      humanApprove: true,
    });
    again.root.head = closedTurn(oneShot);
    await when(
      () =>
        oneShot.workerSessionId !== "" &&
        project.kernel.sessionPlexus(oneShot.workerSessionId)?.root.findTurnByAgentRequestId(oneShot.uuid) != null &&
        project.sessions[oneShot.workerSessionId] != null,
      {
        timeout: TIMEOUT,
      },
    );
    const oneShotWorker = project.sessions[oneShot.workerSessionId]!;
    const impl = new AgentCallJob({
      toolCallId: "os-impl",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "implementer", message: "do" }),
      voidLegal: false,

      humanApprove: true,
    });
    again.root.head = closedTurn(impl);
    await when(
      () =>
        impl.workerSessionId !== "" &&
        project.kernel.sessionPlexus(impl.workerSessionId)?.root.findTurnByAgentRequestId(impl.uuid) != null,
      { timeout: TIMEOUT },
    );
    const implWorker = project.sessions[impl.workerSessionId]!;
    const childEcho = new BotCallJob({
      toolCallId: "child-echo",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "echo", message: "review" }),
      voidLegal: false,
      humanApprove: true,
    });
    implWorker.root.head = closedTurn(childEcho);
    await when(
      () =>
        childEcho.workerSessionId !== "" &&
        project.kernel.sessionPlexus(childEcho.workerSessionId)?.root.findTurnByAgentRequestId(childEcho.uuid) != null,
      { timeout: TIMEOUT },
    );
    expect({
      reuse: ask.workerSessionId === parentEcho,
      parentEcho: again.root.botsRoster.echo,
      oneShotKind: oneShotWorker.root.agent.spec instanceof AskAgentSpec,
      oneShotOffRoster: oneShot.workerSessionId !== parentEcho,
      parentHasOneShot: again.root.botsRoster.echo === parentEcho,
      parentImplementer: again.root.botsRoster.implementer,
      implKind: implWorker.root.agent.spec instanceof AskAgentSpec,
      implName: implWorker.root.agent.spec.name,
      childEcho: implWorker.root.botsRoster.echo,
      childOwnsRoster: implWorker.root.botsRoster.echo === childEcho.workerSessionId,
      distinctEcho: childEcho.workerSessionId !== parentEcho,
    }).toEqual({
      reuse: true,
      parentEcho,
      oneShotKind: true,
      oneShotOffRoster: true,
      parentHasOneShot: true,
      parentImplementer: undefined,
      implKind: true,
      implName: "implementer",
      childEcho: childEcho.workerSessionId,
      childOwnsRoster: true,
      distinctEcho: true,
    });
    kernel.catalog.replaceRecipes(RECIPES);

    const schema = {
      type: "object",
      properties: { answer: { type: "string", enum: ["yes", "no"] } },
      required: ["answer"],
      additionalProperties: false,
    };
    const askSettle = new AgentCallJob({
      toolCallId: "c-ask",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "flash", message: "pick" }),
      voidLegal: false,

      responseSchema: schema,
      humanApprove: true,
    });
    again.root.head = closedTurn(askSettle);
    await when(
      () =>
        askSettle.workerSessionId !== "" &&
        project.kernel.sessionPlexus(askSettle.workerSessionId)?.root.findTurnByAgentRequestId(askSettle.uuid) != null,
      { timeout: TIMEOUT },
    );
    const askWorker = project.sessions[askSettle.workerSessionId]!;
    const askVoid = new AgentCallbackJob({
      toolCallId: "v-ask",
      name: "agent__void",
      argsJson: JSON.stringify({ requestId: askSettle.uuid }),
      humanApprove: true,
    });
    const empty = new AgentCallbackJob({
      toolCallId: "e-ask",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: askSettle.uuid, response: "   " }),
      humanApprove: true,
    });
    const valued = new AgentCallbackJob({
      toolCallId: "val-ask",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: askSettle.uuid, value: null, response: "" }),
      humanApprove: true,
    });
    askWorker.root.head = closedTurn(askVoid);
    await when(() => askVoid.completed, { timeout: TIMEOUT });
    askWorker.root.head = closedTurn(empty);
    await when(() => empty.completed, { timeout: TIMEOUT });
    askWorker.root.head = closedTurn(valued);
    await when(() => valued.completed, { timeout: TIMEOUT });
    expect({
      open: askSettle.completed,
      row: askWorker.root.agentCallbacks[askSettle.uuid],
      voided: askVoid.receiptJson,
      empty: empty.receiptJson,
      valued: valued.receiptJson,
    }).toEqual({
      open: false,
      row: again.root.sessionId,
      voided: JSON.stringify({ ok: false, text: "ask requires a response" }),
      empty: JSON.stringify({ ok: false, text: "ask requires a response" }),
      valued: JSON.stringify({ ok: false, text: "ask requires a response" }),
    });
    const later = new AgentCallbackJob({
      toolCallId: "r-ask",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: askSettle.uuid, response: JSON.stringify({ answer: "yes" }) }),
      humanApprove: true,
    });
    askWorker.root.head = closedTurn(later);
    await when(() => askSettle.completed && later.completed, { timeout: TIMEOUT });
    expect({
      outcome: okOf(askSettle),
      row: askWorker.root.agentCallbacks[askSettle.uuid],
    }).toEqual({
      outcome: { answer: "yes" },
      row: undefined,
    });
  });

  it("force-stop / keepAlive / reclaim: leftovers rejected; successor/sibling preserved; queue seat back; statusline intern dropped", async () => {
    const leftoverRoot = workerDoc("leftover");
    leftoverRoot.agent.spec.keepAlive = false;
    const leftover = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const leftoverTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    leftoverTurn.pushChild(leftover);
    leftoverRoot.head = leftoverTurn;
    forceStopLoop(leftoverRoot);
    expect({
      completed: leftover.completed,
      orchestrated: leftover.orchestrated,
      humanApprove: leftover.humanApprove,
      cancelled: leftover.cancelled,
      outcome: leftover.receiptJson,
      rosterIdle: leftoverRoot.isMidMotion(),
    }).toEqual({
      completed: true,
      orchestrated: false,
      humanApprove: true,
      cancelled: true,
      outcome: JSON.stringify({ ok: false, text: "rejected" }),
      rosterIdle: false,
    });

    const successorRoot = workerDoc("successor");
    const callback = new AgentCallbackJob({
      toolCallId: "cb",
      name: "agent__respond",
      argsJson: "{}",
      humanApprove: true,
    });
    const prior = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    prior.pushChild(callback);
    const successorLeft = new SystemToolJob({
      toolCallId: "next",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const successor = new SessionTurn({
      turnTail: prior,
      queue: [],
      reducerExited: false,
    });
    successor.pushChild(successorLeft);
    successorRoot.head = successor;
    forceStopLoop(successorRoot, undefined, callback);
    expect({ leftover: successorLeft.completed, successorClosed: successor.reducerExited }).toEqual({
      leftover: false,
      successorClosed: false,
    });

    const siblingRoot = workerDoc("sibling");
    const first = new AgentCallbackJob({
      toolCallId: "a",
      name: "agent__respond",
      argsJson: "{}",
      humanApprove: true,
      orchestrationResult: true,
      outcomeJson: JSON.stringify({ ok: true }),
    });
    const siblingLeft = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const siblingTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    siblingTurn.pushChild(first);
    siblingTurn.pushChild(siblingLeft);
    siblingRoot.head = siblingTurn;
    forceStopLoop(siblingRoot, undefined, first);
    expect({ first: first.receiptJson, leftover: siblingLeft.receiptJson }).toEqual({
      first: JSON.stringify({ ok: true }),
      leftover: JSON.stringify({ ok: false, text: "rejected" }),
    });

    const stretchRoot = workerDoc("stretch");
    const stretchLeft = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
    });
    const stretchTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
    });
    stretchTurn.pushChild(stretchLeft);
    stretchRoot.head = stretchTurn;
    stretchRoot.agentCallbacks.one = "caller";
    forceStopLoop(stretchRoot);
    expect({ openRows: stretchLeft.completed }).toEqual({ openRows: false });
    delete stretchRoot.agentCallbacks.one;
    stretchRoot.agent.spec.keepAlive = true;
    forceStopLoop(stretchRoot);
    expect({ keepAlive: stretchLeft.completed }).toEqual({ keepAlive: false });

    const reclaimRoot = workerDoc("reclaim");
    const pendingPew = new CompletionExpectation({
      promptText: prompt.user`go`,
      connectionId: "c",
    });
    const pending = new CompletionJob({ expectation: pendingPew });
    const reclaimTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [pending],
      reducerExited: false,
    });
    reclaimTurn.orchestrationResult = true;
    reclaimRoot.head = reclaimTurn;
    recoverSessionJobs(reclaimRoot);
    expect({
      queue: reclaimTurn.queue[0] === pending,
      done: reclaimTurn.doneWork.includes(pending),
      orchestrated: reclaimTurn.orchestrated,
    }).toEqual({ queue: true, done: false, orchestrated: true });

    const sittingRoot = workerDoc("sitting");
    const sittingCall = new AgentCallJob({
      toolCallId: "c",
      name: "agent__send",
      humanApprove: true,
      orchestrationResult: true,
      workerSessionId: "w1",
    });
    const program = new ProgrammaticJob({
      toolCallId: "p",
      argsJson: "{}",
      orchestrationResult: true,
    });
    const echo = new SystemToolJob({
      toolCallId: "e",
      name: "echo",
      argsJson: "{}",
      humanApprove: true,
      orchestrationResult: true,
    });
    const sittingTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
      orchestrationResult: true,
    });
    sittingTurn.pushChild(sittingCall);
    sittingTurn.pushChild(program);
    sittingTurn.pushChild(echo);
    sittingRoot.head = sittingTurn;
    sittingRoot.botsRoster.echo = "w1";
    recoverSessionJobs(sittingRoot);
    expect({
      turn: sittingTurn.orchestrated,
      call: sittingCall.orchestrated,
      program: program.orchestrated,
      echo: echo.orchestrated,
      workers: namedWorkerIds(sittingRoot),
    }).toEqual({ turn: true, call: true, program: true, echo: true, workers: ["w1"] });

    const { project, session } = await openHarness();
    const liveCall = new BotCallJob({
      toolCallId: "f1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "hi" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(liveCall);
    await when(
      () =>
        liveCall.workerSessionId !== "" &&
        project.kernel.sessionPlexus(liveCall.workerSessionId)?.root.findTurnByAgentRequestId(liveCall.uuid) != null,
      { timeout: TIMEOUT },
    );
    const liveWorker = project.sessions[liveCall.workerSessionId]!;
    liveWorker.root.agent.spec.keepAlive = false;
    const liveLeft = new SystemToolJob({
      toolCallId: "left",
      name: "echo",
      argsJson: "{}",
    });
    const liveRespond = new AgentCallbackJob({
      toolCallId: "r1",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: liveCall.uuid, response: "pong" }),
      humanApprove: true,
    });
    const liveTurn = new SessionTurn({
      turnTail: liveWorker.root.head ?? new SessionSystemPrompt(),
      queue: [liveLeft],
      reducerExited: false,
    });
    liveTurn.pushChild(liveRespond);
    liveWorker.root.head = liveTurn;
    await when(() => liveCall.completed && liveLeft.completed && liveLeft.receiptJson != null, {
      timeout: TIMEOUT,
    });
    expect({
      leftover: liveLeft.receiptJson,
      orchestrated: liveLeft.orchestrated,
      humanApprove: liveLeft.humanApprove,
      row: liveWorker.root.agentCallbacks[liveCall.uuid],
      roster: session.root.botsRoster.echo,
    }).toEqual({
      leftover: JSON.stringify({ ok: false, text: "rejected" }),
      orchestrated: false,
      humanApprove: null,
      row: undefined,
      roster: liveCall.workerSessionId,
    });

    const hold = new BotCallJob({
      toolCallId: "h1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "linger", message: "stay" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(hold);
    await when(
      () =>
        hold.workerSessionId !== "" &&
        project.kernel.sessionPlexus(hold.workerSessionId)?.root.findTurnByAgentRequestId(hold.uuid) != null,
      { timeout: TIMEOUT },
    );
    const linger = project.sessions[hold.workerSessionId]!;
    const parked = new SystemToolJob({
      toolCallId: "park",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x" }),
    });
    const voiding = new AgentCallbackJob({
      toolCallId: "v1",
      name: "agent__void",
      argsJson: JSON.stringify({ requestId: hold.uuid }),
      humanApprove: true,
    });
    const stretch = new SessionTurn({
      turnTail: linger.root.head ?? new SessionSystemPrompt(),
      queue: [parked],
      reducerExited: false,
    });
    stretch.pushChild(voiding);
    linger.root.head = stretch;
    await when(() => hold.completed && voiding.completed, { timeout: TIMEOUT });
    expect({ parked: parked.completed, keepAlive: linger.root.agent.spec.keepAlive }).toEqual({
      parked: false,
      keepAlive: true,
    });

    const rowA = new BotCallJob({
      toolCallId: "t1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "one" }),
      humanApprove: true,
    });
    const rowB = new BotCallJob({
      toolCallId: "t2",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "two" }),
      humanApprove: true,
    });
    const two = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    two.pushChild(rowA);
    two.pushChild(rowB);
    session.root.head = two;
    await when(
      () =>
        rowA.workerSessionId !== "" &&
        project.kernel.sessionPlexus(rowA.workerSessionId)?.root.findTurnByAgentRequestId(rowA.uuid) != null &&
        rowB.workerSessionId !== "" &&
        project.kernel.sessionPlexus(rowB.workerSessionId)?.root.findTurnByAgentRequestId(rowB.uuid) != null,
      { timeout: TIMEOUT },
    );
    const echoWorker = project.sessions[rowA.workerSessionId]!;
    const tail = new SystemToolJob({
      toolCallId: "tail",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x" }),
    });
    const firstRespond = new AgentCallbackJob({
      toolCallId: "fr",
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: rowA.uuid, response: "one" }),
      humanApprove: true,
    });
    const twoOpen = new SessionTurn({
      turnTail: echoWorker.root.head ?? new SessionSystemPrompt(),
      queue: [tail],
      reducerExited: false,
    });
    twoOpen.pushChild(firstRespond);
    echoWorker.root.head = twoOpen;
    await when(() => rowA.completed && firstRespond.completed, { timeout: TIMEOUT });
    expect({
      secondOpen: echoWorker.root.agentCallbacks[rowB.uuid],
      turnTail: tail.completed,
    }).toEqual({ secondOpen: session.root.sessionId, turnTail: false });
  });

  it("message addressing: concurrent first-resolve; bot uuid; many callers on one project-nature session", async () => {
    const { kernel, project, session } = await openHarness();
    const a = new BotCallJob({
      toolCallId: "a",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "a" }),
      humanApprove: true,
    });
    const b = new BotCallJob({
      toolCallId: "b",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "b" }),
      humanApprove: true,
    });
    const concurrent = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    concurrent.pushChild(a);
    concurrent.pushChild(b);
    session.root.head = concurrent;
    await when(
      () =>
        a.workerSessionId !== "" &&
        project.kernel.sessionPlexus(a.workerSessionId)?.root.findTurnByAgentRequestId(a.uuid) != null &&
        b.workerSessionId !== "" &&
        project.kernel.sessionPlexus(b.workerSessionId)?.root.findTurnByAgentRequestId(b.uuid) != null,
      { timeout: TIMEOUT },
    );
    const echo = project.sessions[a.workerSessionId]!;
    expect({
      same: a.workerSessionId === b.workerSessionId,
      roster: session.root.botsRoster.echo,
      rows: [echo.root.agentCallbacks[a.uuid], echo.root.agentCallbacks[b.uuid]],
    }).toEqual({
      same: true,
      roster: a.workerSessionId,
      rows: [session.root.sessionId, session.root.sessionId],
    });

    const progress = new BotCallJob({
      toolCallId: "progress",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "echo", message: "work" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(progress);
    await when(
      () =>
        progress.workerSessionId !== "" &&
        project.kernel.sessionPlexus(progress.workerSessionId)?.root.findTurnByAgentRequestId(progress.uuid) != null,
      { timeout: TIMEOUT },
    );
    const progressWorker = project.sessions[progress.workerSessionId]!;
    session.root.kvs.connection = "dummy";
    const waiting = new SessionTurn({ turnTail: session.root.head!, queue: [progress] });
    session.root.head = waiting;
    await when(() => waiting.orchestrated, { timeout: TIMEOUT });
    const receipt = new AgentMessageJob({
      name: "agent__message",
      argsJson: JSON.stringify({ targetId: "caller", message: "progress" }),
      humanApprove: true,
    });
    progressWorker.root.head = closedTurn(receipt);
    await when(() => receipt.completed, { timeout: TIMEOUT });
    expect({
      outcome: receipt.receiptJson,
      waitingClosed: waiting.reducerExited,
      inboundTail: session.root.head === waiting ? false : session.root.head?.turnTail === waiting,
      inboundOrchestrated: session.root.head?.orchestrated,
    }).toEqual({
      outcome: '{"ok":true}',
      waitingClosed: false,
      inboundTail: true,
      inboundOrchestrated: false,
    });
    progressWorker.root.head = closedTurn(
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({ requestId: progress.uuid, response: "done" }),
        humanApprove: true,
      }),
    );
    await when(() => waiting.reducerExited, { timeout: TIMEOUT });
    expect({ completed: progress.completed, waitingClosed: waiting.reducerExited }).toEqual({
      completed: true,
      waitingClosed: true,
    });

    const send = new AgentMessageJob({
      toolCallId: "msg",
      name: "agent__message",
      argsJson: JSON.stringify({ targetId: session.root.sessionId, message: "back" }),
      humanApprove: true,
    });
    echo.root.head = closedTurn(send);
    await when(() => send.completed && session.root.head?.prompt.includes("message from") === true, {
      timeout: TIMEOUT,
    });
    const glob = new BotCallJob({
      toolCallId: "g1",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "glob", message: "g" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(glob);
    await when(
      () =>
        glob.workerSessionId !== "" &&
        project.kernel.sessionPlexus(glob.workerSessionId)?.root.findTurnByAgentRequestId(glob.uuid) != null,
      { timeout: TIMEOUT },
    );
    expect({
      send: send.receiptJson,
      inbound: true,
      globalRoster: kernel.plexus.root.botsRoster.glob,
      projectRoster: project.root.botsRoster.glob,
    }).toEqual({
      send: JSON.stringify({ ok: true }),
      inbound: true,
      globalRoster: glob.workerSessionId,
      projectRoster: undefined,
    });

    const other = await project.session("caller-b");
    const fromA = new BotCallJob({
      toolCallId: "pa",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "shelf", message: "a" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(fromA);
    await when(
      () =>
        fromA.workerSessionId !== "" &&
        project.kernel.sessionPlexus(fromA.workerSessionId)?.root.findTurnByAgentRequestId(fromA.uuid) != null,
      { timeout: TIMEOUT },
    );
    const fromB = new BotCallJob({
      toolCallId: "pb",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "shelf", message: "b" }),
      humanApprove: true,
    });
    other.root.head = closedTurn(fromB);
    await when(
      () =>
        fromB.workerSessionId !== "" &&
        project.kernel.sessionPlexus(fromB.workerSessionId)?.root.findTurnByAgentRequestId(fromB.uuid) != null,
      { timeout: TIMEOUT },
    );
    const shelf = project.sessions[fromA.workerSessionId]!;
    const ba = new AgentMessageJob({
      toolCallId: "ba",
      name: "agent__message",
      argsJson: JSON.stringify({ targetId: session.root.sessionId, message: "from-b" }),
      humanApprove: true,
    });
    shelf.root.head = closedTurn(ba);
    await when(() => ba.completed, { timeout: TIMEOUT });
    expect({
      same: fromA.workerSessionId === fromB.workerSessionId,
      distinctCallers: session.root.sessionId !== other.root.sessionId,
      projectRoster: project.root.botsRoster.shelf,
      rows: [shelf.root.agentCallbacks[fromA.uuid], shelf.root.agentCallbacks[fromB.uuid]],
      notInvoker: shelf.root.sessionId !== session.root.sessionId,
      send: ba.receiptJson,
    }).toEqual({
      same: true,
      distinctCallers: true,
      projectRoster: fromA.workerSessionId,
      rows: [session.root.sessionId, other.root.sessionId],
      notInvoker: true,
      send: JSON.stringify({ ok: true }),
    });
    const pingBot = new AgentMessageJob({
      toolCallId: "ab",
      name: "agent__message",
      argsJson: JSON.stringify({ targetId: shelf.root.sessionId, message: "to-bot" }),
      humanApprove: true,
    });
    other.root.head = closedTurn(pingBot);
    await when(() => pingBot.completed, { timeout: TIMEOUT });
    expect({ pingBot: pingBot.receiptJson }).toEqual({ pingBot: JSON.stringify({ ok: true }) });
  });

  it("generic runtime has no memory tool names; parent and implementer child own distinct reviewer rows", async () => {
    const { kernel, project, session } = await openHarness();
    expect({
      tingle: session.kernel.catalog.catalogEntry("call__memory__tingle"),
      offload: session.kernel.catalog.catalogEntry("call__memory__offload"),
    }).toEqual({ tingle: undefined, offload: undefined });

    kernel.catalog.replaceRecipes([
      catalogRecipe({
        name: "reviewer",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "review" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "implementer",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: ["reviewer"],
      }),
    ]);
    const parentReviewer = new BotCallJob({
      toolCallId: "p-rev",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "reviewer", message: "look" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(parentReviewer);
    await when(
      () =>
        parentReviewer.workerSessionId !== "" &&
        project.kernel
          .sessionPlexus(parentReviewer.workerSessionId)
          ?.root.findTurnByAgentRequestId(parentReviewer.uuid) != null,
      { timeout: TIMEOUT },
    );
    const parentImpl = new BotCallJob({
      toolCallId: "p-impl",
      name: "agent__send",
      argsJson: JSON.stringify({ spec: "implementer", message: "do" }),
      humanApprove: true,
    });
    session.root.head = closedTurn(parentImpl);
    await when(
      () =>
        parentImpl.workerSessionId !== "" &&
        project.kernel.sessionPlexus(parentImpl.workerSessionId)?.root.findTurnByAgentRequestId(parentImpl.uuid) !=
          null,
      { timeout: TIMEOUT },
    );
    const implWorker = project.sessions[parentImpl.workerSessionId]!;
    const childReviewer = new BotCallJob({
      toolCallId: "c-rev",
      name: "agent__ask",
      argsJson: JSON.stringify({ spec: "reviewer", message: "review" }),
      voidLegal: false,
      humanApprove: true,
    });
    implWorker.root.head = closedTurn(childReviewer);
    await when(
      () =>
        childReviewer.workerSessionId !== "" &&
        project.kernel
          .sessionPlexus(childReviewer.workerSessionId)
          ?.root.findTurnByAgentRequestId(childReviewer.uuid) != null,
      { timeout: TIMEOUT },
    );
    expect({
      parentReviewer: session.root.botsRoster.reviewer,
      childReviewer: implWorker.root.botsRoster.reviewer,
      parentImpl: session.root.botsRoster.implementer,
      distinct: session.root.botsRoster.reviewer !== implWorker.root.botsRoster.reviewer,
    }).toEqual({
      parentReviewer: parentReviewer.workerSessionId,
      childReviewer: childReviewer.workerSessionId,
      parentImpl: parentImpl.workerSessionId,
      distinct: true,
    });
  });
});
