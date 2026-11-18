/**
 * scheme_repl agent mixer: bot send sits on BotCallJob; respond is the
 * agent__respond JSON tool; message does not wait; a disposable agent has no roster.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentCallJob,
  AgentCallbackJob,
  AgentMessageJob,
  AskAgentSpec,
  BotCallJob,
  CallJob,
  FailureOutcome,
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { catalogRecipe } from "@/tool-catalog";

import { KernelDaemon } from "../../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../daemon/project/ProjectDaemon.js";
import { sessionCatalog } from "../../toolkit/tool-table.js";

const TIMEOUT = 12_000;

async function openHarness() {
  const system = await mkdtemp(join(tmpdir(), "harness-sr-agent-k-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const workspace = await mkdtemp(join(tmpdir(), "harness-sr-agent-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  kernel.catalog.replaceRecipes([
    catalogRecipe({
      name: "echo",
      recipeScope: "session",
      category: "internal",
      capabilities: [{ name: "ping", supportsNotify: true }],
      keepAlive: true,
      invokes: [],
    }),
    catalogRecipe({
      name: "flash",
      recipeScope: "session",
      category: "internal",
      capabilities: [{ name: "once" }],
      invokes: [],
    }),
    catalogRecipe({
      name: "scribe",
      recipeScope: "session",
      category: "internal",
      capabilities: [{ name: "once" }],
      tools: ["write_file", "edit_file", "shell"],
      invokes: [],
    }),
    catalogRecipe({
      name: "crew",
      recipeScope: "project",
      category: "internal",
      capabilities: [{ name: "ping" }],
      keepAlive: true,
      invokes: [],
    }),
  ]);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("caller");
  session.root.permissionMode = "yolo";
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, project, session };
}

function program(expr: string): ProgrammaticJob {
  return new ProgrammaticJob({
    toolCallId: "p1",
    argsJson: JSON.stringify({ expr, description: "test" }),
  });
}

function runOn(root: { head: SessionTurn | null }, chunk: ProgrammaticJob, agentRequestId = ""): SessionTurn {
  const turn = new SessionTurn({
    turnTail: root.head ?? new SessionSystemPrompt(),
    queue: [chunk],
    agentRequestId,
  });
  root.head = turn;
  return turn;
}

/** A worker id is pinned before durable delivery; manipulate only the delivered worker. */
async function deliveredCall(chunk: ProgrammaticJob, project: ProjectDaemon): Promise<{ readonly call: CallJob }> {
  const delivered = (row: unknown): row is CallJob =>
    row instanceof CallJob &&
    row.workerSessionId !== "" &&
    project.sessions[row.workerSessionId]?.root.agentCallbacks[row.uuid] !== undefined;
  await when(() => chunk.toolCalls.some(delivered), { timeout: TIMEOUT });
  const call = chunk.toolCalls.find(delivered);
  if (call == null) throw new Error("call was not delivered");
  // A Job is thenable. Returning it here would settle to its result, not the call.
  return { call };
}

function respondJson(root: { head: SessionTurn | null }, requestId: string, response: string): AgentCallbackJob {
  const job = new AgentCallbackJob({
    name: "agent__respond",
    argsJson: JSON.stringify({ requestId, response }),
    humanApprove: true,
  });
  root.head = new SessionTurn({
    turnTail: root.head ?? new SessionSystemPrompt(),
    queue: [job],
    agentRequestId: requestId,
  });
  return job;
}

describe("scheme_repl agent mixer", () => {
  it("bot/send waits for Scheme respond; bot/ask omitted-spec mints a worker; :readonly stamps worker desk", async () => {
    const { project, session } = await openHarness();

    const send = program('(bot/send \'echo "hi")');
    runOn(session.root, send);
    const { call } = await deliveredCall(send, project);
    expect(call).toBeInstanceOf(BotCallJob);
    const worker = project.sessions[call.workerSessionId]!;
    worker.root.permissionMode = "yolo";
    const reply = respondJson(worker.root, call.uuid, "pong");
    await when(() => send.completed && reply.completed, { timeout: TIMEOUT });

    const note = program('(agent/message \'echo "aside")');
    runOn(session.root, note);
    await when(() => note.completed, { timeout: TIMEOUT });
    const delivered = note.toolCalls.find((row): row is AgentMessageJob => row instanceof AgentMessageJob);

    const flash = program('(agent/call \'flash "once")');
    runOn(session.root, flash);
    const { call: flashCall } = await deliveredCall(flash, project);
    expect(flashCall).toBeInstanceOf(AgentCallJob);

    const ask = program('(bot/ask "classify")');
    runOn(session.root, ask);
    const { call: askCall } = await deliveredCall(ask, project);
    expect(askCall).toBeInstanceOf(AgentCallJob);
    const askWorker = project.sessions[askCall.workerSessionId]!;
    askWorker.root.permissionMode = "yolo";
    const askReply = respondJson(askWorker.root, askCall.uuid, "yes");
    await when(() => ask.completed && askReply.completed, { timeout: TIMEOUT });

    const ghost = program('(bot/send \'zzz-nope "no")');
    runOn(session.root, ghost);
    await when(() => ghost.completed, { timeout: TIMEOUT });

    const roAsk = program('(bot/ask "classify" :readonly #t)');
    runOn(session.root, roAsk);
    const { call: roAskCall } = await deliveredCall(roAsk, project);
    expect(roAskCall).toBeInstanceOf(AgentCallJob);
    const roAskWorker = project.sessions[roAskCall.workerSessionId]!;
    const omittedCatalog = sessionCatalog(roAskWorker.root);

    const named = program('(bot/ask \'scribe "judge" :readonly #t)');
    runOn(session.root, named);
    const { call: namedCall } = await deliveredCall(named, project);
    expect(namedCall).toBeInstanceOf(BotCallJob);
    const namedWorker = project.sessions[namedCall.workerSessionId]!;
    namedWorker.root.permissionMode = "yolo";
    const namedCatalog = sessionCatalog(namedWorker.root);
    const write = program('(write_file "out.txt" "nope")');
    runOn(namedWorker.root, write, namedCall.uuid);
    await when(() => write.completed, { timeout: TIMEOUT });

    const openNamed = program('(bot/ask \'scribe "judge")');
    runOn(session.root, openNamed);
    const { call: openCall } = await deliveredCall(openNamed, project);
    expect(openCall).toBeInstanceOf(BotCallJob);
    const openWorker = project.sessions[openCall.workerSessionId]!;
    openWorker.root.permissionMode = "yolo";
    const openWrite = program('(write_file "ok.txt" "hello")');
    runOn(openWorker.root, openWrite);
    await when(() => openWrite.completed, { timeout: TIMEOUT });

    expect({
      send: JSON.parse(send.receiptJson ?? "null"),
      callName: call.name,
      roster: session.root.botsRoster.echo,
      replyOk: JSON.parse(reply.receiptJson ?? "null").ok,
      message: JSON.parse(delivered?.receiptJson ?? "null"),
      flashRoster: session.root.botsRoster.flash,
      flashName: flashCall.name,
      ask: JSON.parse(ask.receiptJson ?? "null"),
      askName: askCall.name,
      askVoidLegal: askCall.voidLegal,
      askScope: askWorker.root.agent.spec.recipeScope,
      askClass: askWorker.root.agent.spec instanceof AskAgentSpec,
      askSpec: askWorker.root.agent.spec.name,
      askReadonly: askWorker.root.agent.spec instanceof AskAgentSpec && askWorker.root.agent.spec.readonly,
      askRoster: session.root.botsRoster._ask,
      ghost: JSON.parse(ghost.receiptJson ?? "null"),
      desk: {
        askName: roAskCall.name,
        askClass: roAskWorker.root.agent.spec instanceof AskAgentSpec,
        askReadonly: roAskWorker.root.agent.spec.readonly,
        askCallReadonly: roAskCall.readonly,
        askArgs: roAskCall.args,
        jsonWrite: omittedCatalog?.catalogEntry("write_file"),
        jsonEdit: omittedCatalog?.catalogEntry("edit_file"),
        jsonShell: omittedCatalog?.catalogEntry("shell"),
        jsonScheme: omittedCatalog?.catalogEntry("scheme_repl") != null,
        jsonVoid: omittedCatalog?.catalogEntry("agent__void"),
        namedName: namedCall.name,
        namedReadonly: namedCall.readonly,
        namedArgs: namedCall.args,
        namedCatalogWrite: namedCatalog?.catalogEntry("write_file") != null,
        writeOk: JSON.parse(write.receiptJson ?? "null").ok,
        writeText: JSON.parse(write.receiptJson ?? "null").text,
        writeInv: write.toolCalls.map((row) => row.name),
        openReadonly: openCall.readonly,
        openWriteName: openWrite.toolCalls[0]?.name,
        openWriteOk: JSON.parse(openWrite.receiptJson ?? "null").ok,
      },
    }).toEqual({
      send: { ok: true, value: ["pong"] },
      callName: "agent__send",
      roster: call.workerSessionId,
      replyOk: true,
      message: { ok: true },
      flashRoster: undefined,
      flashName: "agent__send",
      ask: { ok: true, value: ["yes"] },
      askName: "agent__ask",
      askVoidLegal: false,
      askScope: "",
      askClass: true,
      askSpec: "",
      askReadonly: false,
      askRoster: undefined,
      ghost: { ok: false, text: expect.stringMatching(/zzz-nope/), code: "unknown_recipe" },
      desk: {
        askName: "agent__ask",
        askClass: true,
        askReadonly: true,
        askCallReadonly: true,
        askArgs: { message: "classify" },
        jsonWrite: undefined,
        jsonEdit: undefined,
        jsonShell: undefined,
        jsonScheme: true,
        jsonVoid: undefined,
        namedName: "agent__ask",
        namedReadonly: true,
        namedArgs: { spec: "scribe", message: "judge" },
        namedCatalogWrite: true,
        writeOk: false,
        writeText: expect.stringMatching(/writable/),
        writeInv: [],
        openReadonly: false,
        openWriteName: "write_file",
        openWriteOk: true,
      },
    });
  }, 60_000);

  it("session worker live-follows caller remainder inputs; project worker does not", async () => {
    const { project, session } = await openHarness();
    session.root.permissionMode = "auto";
    session.root.addReadRoot("/opt/shared");
    const send = program('(bot/send \'echo "hi")');
    runOn(session.root, send);
    const { call } = await deliveredCall(send, project);
    expect(call).toBeInstanceOf(BotCallJob);
    const worker = project.sessions[call.workerSessionId]!;
    const inherited = {
      policy: worker.root.permissionMode,
      root: worker.root.readRoots["/opt/shared"],
    };
    session.root.permissionMode = "yolo";
    delete session.root.readRoots["/opt/shared"];
    await when(() => worker.root.permissionMode === "yolo" && worker.root.readRoots["/opt/shared"] === undefined, {
      timeout: TIMEOUT,
    });
    const crew = program('(bot/send \'crew "hi")');
    runOn(session.root, crew);
    const { call: crewCall } = await deliveredCall(crew, project);
    expect(crewCall).toBeInstanceOf(BotCallJob);
    const crewWorker = project.sessions[crewCall.workerSessionId]!;
    expect({
      inherited,
      followed: { policy: worker.root.permissionMode, root: worker.root.readRoots["/opt/shared"] },
      project: { policy: crewWorker.root.permissionMode, scope: crewWorker.root.agent.spec.recipeScope },
    }).toEqual({
      inherited: { policy: "auto", root: "session" },
      followed: { policy: "yolo", root: undefined },
      project: { policy: "manual", scope: "project" },
    });
  });

  it("eval timeout keeps child workers running in background, reports finished work, and allows log reading, continuation, and explicit job_stop", async () => {
    const { project, session } = await openHarness();

    // Case A: parallel program (`map`) hits timeout while Worker A finished and Worker B is still running.
    const send = new ProgrammaticJob({
      toolCallId: "p-parallel",
      argsJson: JSON.stringify({
        expr: `(map (lambda (pair) (agent/ask 'flash (car pair) :description (cdr pair))) '(("SECRET_BRIEF_A" . "Map alpha.") ("SECRET_BRIEF_B" . "Map beta.")))`,
        description: "parallel research",
        timeoutMs: 2_500,
      }),
    });
    const callerTurn = runOn(session.root, send);
    const hasBothDelivered = (): boolean =>
      send.toolCalls.filter(
        (row): row is AgentCallJob =>
          row instanceof AgentCallJob &&
          row.workerSessionId !== "" &&
          project.sessions[row.workerSessionId]?.root.agentCallbacks[row.uuid] === session.root.sessionId,
      ).length === 2;
    await when(hasBothDelivered, { timeout: TIMEOUT });

    const callA = send.toolCalls.find(
      (row): row is AgentCallJob => row instanceof AgentCallJob && row.argString("description") === "Map alpha.",
    );
    const callB = send.toolCalls.find(
      (row): row is AgentCallJob => row instanceof AgentCallJob && row.argString("description") === "Map beta.",
    );
    if (callA == null || callB == null) throw new Error("expected both parallel calls");

    const workerA = project.sessions[callA.workerSessionId];
    const workerB = project.sessions[callB.workerSessionId];
    if (workerA == null || workerB == null) throw new Error("expected both worker sessions");

    const replyA = respondJson(workerA.root, callA.uuid, "alpha report");
    await when(() => replyA.completed && callA.completed, { timeout: TIMEOUT });
    await when(() => send.completed, { timeout: TIMEOUT });

    const timeoutSnap = JSON.parse(send.receiptJson ?? "null") as { ok: boolean; text: string };
    const workerBFirstTurn = workerB.root.head;
    if (timeoutSnap.ok) throw new Error(`expected timeout, got ok: ${JSON.stringify(timeoutSnap)}`);

    // Parent reads logs (owned worker live log, completed job log, paged slice) and unowned worker is refused.
    const readLogs = program(
      `(agent/log "${workerB.sessionId}")\n(context_recall "job:${callA.uuid.slice(0, 8)}#log")\n(agent/log "${workerB.sessionId}" :offset 0 :length 40)`,
    );
    runOn(session.root, readLogs);
    await when(() => readLogs.completed, { timeout: TIMEOUT });

    const unownedLog = program('(agent/log "00000000-0000-0000-0000-000000000000")');
    runOn(session.root, unownedLog);
    await when(() => unownedLog.completed, { timeout: TIMEOUT });

    // Parent awaits running Worker B without a new message, then Worker B responds.
    const awaitB = program(`(agent/continue "${workerB.sessionId}")`);
    runOn(session.root, awaitB);
    await when(() => awaitB.toolCalls.some((row) => row instanceof AgentCallJob), { timeout: TIMEOUT });
    const replyB = respondJson(workerB.root, callB.uuid, "beta report");
    await when(() => replyB.completed && callB.completed && awaitB.completed, { timeout: TIMEOUT });

    // Parent sends a follow-up turn to the SAME Worker B session (preserving turnTail history).
    const followUp = program(`(agent/continue "${workerB.sessionId}" "Now check gamma.")`);
    runOn(session.root, followUp);
    const followCallDelivered = (): AgentCallJob | undefined =>
      followUp.toolCalls.find(
        (row): row is AgentCallJob =>
          row instanceof AgentCallJob &&
          row.workerSessionId === workerB.sessionId &&
          row.uuid !== callB.uuid &&
          workerB.root.agentCallbacks[row.uuid] === session.root.sessionId,
      );
    await when(() => followCallDelivered() != null, { timeout: TIMEOUT });
    const followCall = followCallDelivered();
    if (followCall == null) throw new Error("expected follow-up call");
    const workerBSecondTurn = workerB.root.head;
    const replyGamma = respondJson(workerB.root, followCall.uuid, "gamma report");
    await when(() => replyGamma.completed && followUp.completed, { timeout: TIMEOUT });

    // Case B: explicit job_stop cancels a background worker, and agent/continue without message resumes it.
    const timedOutC = new ProgrammaticJob({
      toolCallId: "p-stop",
      argsJson: JSON.stringify({
        expr: '(agent/ask \'flash "Brief C" :description "Scout C.")',
        description: "scout C",
        timeoutMs: 1_000,
      }),
    });
    runOn(session.root, timedOutC);
    const { call: callC } = await deliveredCall(timedOutC, project);
    const workerC = project.sessions[callC.workerSessionId];
    if (workerC == null) throw new Error("expected workerC session");
    await when(() => timedOutC.completed, { timeout: TIMEOUT });

    const listBg = new SystemToolJob({
      toolCallId: "stop-list",
      name: "job_stop",
      argsJson: JSON.stringify({}),
      humanApprove: true,
    });
    session.root.head = new SessionTurn({
      turnTail: session.root.head ?? new SessionSystemPrompt(),
      queue: [listBg],
    });
    await when(() => listBg.completed, { timeout: TIMEOUT });

    const cancelC = new SystemToolJob({
      toolCallId: "stop-c",
      name: "job_stop",
      argsJson: JSON.stringify({ job_id: callC.toolCallId }),
      humanApprove: true,
    });
    session.root.head = new SessionTurn({
      turnTail: session.root.head ?? new SessionSystemPrompt(),
      queue: [cancelC],
    });
    await when(() => cancelC.completed && callC.completed, { timeout: TIMEOUT });

    const workerCStoppedTurn = workerC.root.head;
    const resumeC = program(`(agent/continue "${workerC.sessionId}")`);
    runOn(session.root, resumeC);
    await when(
      () =>
        resumeC.toolCalls.some(
          (row) =>
            row instanceof AgentCallJob &&
            row.workerSessionId === workerC.sessionId &&
            workerC.root.agentCallbacks[row.uuid] === session.root.sessionId,
        ),
      { timeout: TIMEOUT },
    );
    const resumeCall = resumeC.toolCalls.find(
      (row): row is AgentCallJob => row instanceof AgentCallJob && row.workerSessionId === workerC.sessionId,
    );
    if (resumeCall == null) throw new Error("expected resume call");
    const workerCResumedTurn = workerC.root.head;
    const replyC = respondJson(workerC.root, resumeCall.uuid, "resumed report");
    await when(() => replyC.completed && resumeC.completed, { timeout: TIMEOUT });

    const turnInChain = (head: SessionTurn | null, target: SessionTurn | null): boolean => {
      for (let t: unknown = head; t instanceof SessionTurn; t = t.turnTail) {
        if (t === target) return true;
      }
      return false;
    };
    const logValues = (JSON.parse(readLogs.receiptJson ?? "null") as { ok: boolean; value: unknown[] }).value;
    expect({
      timeoutOk: timeoutSnap.ok,
      hasTimeoutHeader: timeoutSnap.text.includes("timed out after 2500ms"),
      hasInnerHeader: timeoutSnap.text.includes("Inner calls at timeout:"),
      hasCompletedAlpha: timeoutSnap.text.includes("status=completed") && timeoutSnap.text.includes("alpha report"),
      hasRunningBeta:
        timeoutSnap.text.includes("status=running_in_background") && timeoutSnap.text.includes(workerB.sessionId),
      leaksBriefA: timeoutSnap.text.includes("SECRET_BRIEF_A"),
      leaksBriefB: timeoutSnap.text.includes("SECRET_BRIEF_B"),
      callBAtTimeout: {
        background: callB.background,
        walkBoundary: callB.walkBoundary,
      },
      callerTurnOpenWork: callerTurn.openWork,
      workerBLogText: {
        hasWorkerId: String(logValues[0]).includes(workerB.sessionId),
        leaksBriefB: String(logValues[0]).includes("SECRET_BRIEF_B"),
      },
      workerALogText: {
        hasResult: String(logValues[1]).includes("alpha report"),
        leaksBriefA: String(logValues[1]).includes("SECRET_BRIEF_A"),
      },
      pagedSlice: String(logValues[2]).includes("chars 0-40 of "),
      unownedOk: JSON.parse(unownedLog.receiptJson ?? "null").ok,
      awaitB: JSON.parse(awaitB.receiptJson ?? "null"),
      followUp: JSON.parse(followUp.receiptJson ?? "null"),
      sameSessionMultiTurn: workerBSecondTurn !== workerBFirstTurn && turnInChain(workerBSecondTurn, workerBFirstTurn),
      listedIds: (JSON.parse(listBg.receiptJson ?? "null").value.jobs as Array<{ jobId: string }>).map((j) => j.jobId),
      cancelStatus: JSON.parse(cancelC.receiptJson ?? "null").value.status,
      callCCode: callC.outcome instanceof FailureOutcome ? callC.outcome.code : null,
      workerCStopped: workerCStoppedTurn?.reducerExited === true,
      resumeSameSession:
        workerCResumedTurn !== workerCStoppedTurn && turnInChain(workerCResumedTurn, workerCStoppedTurn),
      resumePromptHasContinue: workerCResumedTurn?.prompt.includes("Continue") ?? false,
      resumeC: JSON.parse(resumeC.receiptJson ?? "null"),
    }).toEqual({
      timeoutOk: false,
      hasTimeoutHeader: true,
      hasInnerHeader: true,
      hasCompletedAlpha: true,
      hasRunningBeta: true,
      leaksBriefA: false,
      leaksBriefB: false,
      callBAtTimeout: {
        background: true,
        walkBoundary: true,
      },
      callerTurnOpenWork: false,
      workerBLogText: {
        hasWorkerId: true,
        leaksBriefB: false,
      },
      workerALogText: {
        hasResult: true,
        leaksBriefA: false,
      },
      pagedSlice: true,
      unownedOk: false,
      awaitB: { ok: true, value: ["beta report"] },
      followUp: { ok: true, value: ["gamma report"] },
      sameSessionMultiTurn: true,
      listedIds: [callC.toolCallId],
      cancelStatus: "cancelled",
      callCCode: "cancelled",
      workerCStopped: true,
      resumeSameSession: true,
      resumePromptHasContinue: true,
      resumeC: { ok: true, value: ["resumed report"] },
    });
  }, 60_000);
});
