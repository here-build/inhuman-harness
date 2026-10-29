/**
 * scheme_repl agent mixer: bot send sits on BotCallJob; respond is the
 * agent__respond JSON tool; message does not wait; a disposable agent has no roster.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
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
} from "@inhuman.tools/harness-model";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

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
  beforeEach(() => resetLocalIDs());

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

  it("eval timeout cancels an owned child and force-stops its worker", async () => {
    const { project, session } = await openHarness();
    const send = new ProgrammaticJob({
      toolCallId: "p1",
      argsJson: JSON.stringify({
        expr: '(agent/call \'flash "once")',
        description: "test",
        timeoutMs: 2_000,
      }),
    });
    runOn(session.root, send);
    const { call } = await deliveredCall(send, project);
    expect(call).toBeInstanceOf(AgentCallJob);
    const worker = project.sessions[call.workerSessionId]!;
    await when(() => send.completed && call.completed, { timeout: TIMEOUT });
    const outcome = call.outcome;
    expect({
      bag: JSON.parse(send.receiptJson ?? "null"),
      call: {
        completed: call.completed,
        cancelled: call.cancelled,
        code: outcome instanceof FailureOutcome ? outcome.code : null,
      },
      row: worker.root.agentCallbacks[call.uuid],
      workerClosed: worker.root.head?.reducerExited === true,
    }).toEqual({
      bag: { ok: false, text: expect.stringMatching(/timed out after 2000ms/) },
      call: { completed: true, cancelled: true, code: "cancelled" },
      row: undefined,
      workerClosed: true,
    });
  }, 60_000);
});
