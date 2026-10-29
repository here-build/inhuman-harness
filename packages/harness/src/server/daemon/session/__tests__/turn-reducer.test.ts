import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  callbackRequiredNote,
  CONTEXT_NEED_TOOL_NAME,
  CompletionExpectation,
  METADATA_SAME_ROUND_NOTE,
  reactChunks,
  ReACTChunk,
  tapeCompletion,
  responseCall,
  SessionSystemPrompt,
  SessionTurn,
  MCPToolJob,
  SystemToolJob,
  ToolCallJob,
  TurnPromptChunk,
} from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { expect, onTestFinished, test } from "vitest";

import { bindSessionCatalog } from "@/tool-catalog";

import { RpcInvalidParams } from "../../../contract.js";
import { HarnessDaemon } from "../../../daemon/server/HarnessDaemon.js";
import {
  attachScriptedModel,
  installScriptedModel,
  modelOf,
  scriptedConnectionId,
} from "../../../testkit/scripted-model.js";
import { KernelToolCatalog } from "../../../toolkit/tool-table.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

/** Vitest's 15s testTimeout is the outer bound; these guards only poll MobX
 * state, so a generous budget keeps a loaded machine from tripping them. */
const TIMEOUT = 10_000;
const REPLICA_MS = 5_000;

type Want = "idle" | "silent" | "callback" | "react-after-fail" | "tool";
type Door =
  | "retry-idle"
  | "continue-running"
  | "continue-success"
  | "continue-fail-no-wire"
  | "continue-fail"
  | "continue-cancel";

type Row = {
  name: string;
  prose?: string;
  callback?: boolean;
  metadata?: boolean;
  mixed?: boolean;
  door?: Door;
  want: Want;
};

const rows: Row[] = [
  { name: "text-only seals", prose: "hi", want: "silent" },
  { name: "open callback", prose: "I think yes", callback: true, want: "callback" },
  { name: "metadata-only keeps ReACT", prose: "", metadata: true, want: "idle" },
  { name: "metadata+prose seals", prose: "done", metadata: true, want: "silent" },
  { name: "mixed with a real tool still ReACTs", prose: "", mixed: true, want: "tool" },
  { name: "retry idle", door: "retry-idle", want: "silent" },
  { name: "continue while running is a no-op", door: "continue-running", want: "silent" },
  { name: "continue after success is a no-op", door: "continue-success", want: "silent" },
  { name: "continue after fail without connection", door: "continue-fail-no-wire", want: "silent" },
  { name: "continue after fail-seal mints ReACT", door: "continue-fail", want: "react-after-fail" },
  { name: "continue after cancel mints ReACT", door: "continue-cancel", want: "react-after-fail" },
];

test("ReACT loop: mint, tools, stamp source, recover from text, fail-seal, later turn bears previous", async () => {
  resetLocalIDs();

  const replica = await phaseMintReplicaSees();

  const session = await openSession();
  const root = session.root;
  const noTools = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello` });
  root.head = noTools;
  await when(() => completionsOf(noTools).length === 1, { timeout: TIMEOUT });
  const minted = completionsOf(noTools)[0]!;
  const mint = {
    promptChunk: reactChunks(noTools).find((chunk) => chunk instanceof TurnPromptChunk),
    promptText: minted.promptText,
    connectionId: minted.connectionId,
    model: minted.model,
    messages: minted.messages,
    reducerExited: noTools.reducerExited,
  };
  modelOf(session).reply({ text: "hi" });
  await when(() => noTools.reducerExited, { timeout: TIMEOUT });
  const mintSealed = { reducerExited: noTools.reducerExited, work: reactChunks(noTools).length };

  const toolTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
  root.head = toolTurn;
  await when(() => completionsOf(toolTurn).length === 1, { timeout: TIMEOUT });
  const firstToolCompletion = completionsOf(toolTurn)[0]!;
  modelOf(session).reply({ calls: [responseCall("call_1", "echo")] });
  await when(() => toolTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });
  const echo = toolTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
  const tools = {
    name: echo.name,
    toolCallId: echo.toolCallId,
    kind: echo instanceof SystemToolJob,
    parent: echo.parent,
    react: reactChunks(toolTurn).some((chunk) => chunk instanceof ReACTChunk),
    reducerExited: toolTurn.reducerExited,
  };
  echo.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  echo.humanApprove = false;
  await when(() => completionsOf(toolTurn).length === 2, { timeout: TIMEOUT });
  const second = completionsOf(toolTurn)[1]!;
  const secondRound = { promptText: second.promptText, messages: second.messages };
  modelOf(session).reply({ text: "done" });
  await when(() => toolTurn.reducerExited, { timeout: TIMEOUT });
  const toolsSealed = toolTurn.reducerExited;

  const catalog = new KernelToolCatalog();
  catalog.connectionHost = {
    connectionEntries: [
      {
        wireName: "mcp__mail__search",
        description: "search",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: { kind: "connection", connectionKey: "mail", serverToolName: "search" },
      },
    ],
  };
  bindSessionCatalog(root, catalog);
  const mailTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`search mail` });
  root.head = mailTurn;
  await when(() => completionsOf(mailTurn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ calls: [responseCall("call_1", "mcp__mail__search")] });
  await when(() => mailTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });
  const mailTool = mailTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
  const mail = {
    name: mailTool.name,
    kind: mailTool instanceof MCPToolJob,
    connectionKey: mailTool instanceof MCPToolJob ? mailTool.connectionKey : "",
    serverToolName: mailTool instanceof MCPToolJob ? mailTool.serverToolName : "",
    args: mailTool.args,
  };
  mailTool.receiptJson = JSON.stringify({ ok: true, value: { id: 1 } });
  mailTool.humanApprove = false;
  await when(() => completionsOf(mailTurn).length === 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => mailTurn.reducerExited, { timeout: TIMEOUT });

  const recoverTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`use echo` });
  root.head = recoverTurn;
  await when(() => completionsOf(recoverTurn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: `<tool_call>\n{"name": "echo", "arguments": {}}\n</tool_call>` });
  await when(() => recoverTurn.work.some((chunk) => chunk instanceof ToolCallJob), { timeout: TIMEOUT });
  const recoveredTool = recoverTurn.work.find((chunk) => chunk instanceof ToolCallJob)!;
  const recover = recoveredTool.name;
  recoveredTool.receiptJson = JSON.stringify({ ok: true, text: "ok" });
  recoveredTool.humanApprove = false;
  await when(() => completionsOf(recoverTurn).length === 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => recoverTurn.reducerExited, { timeout: TIMEOUT });

  const failTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`nope` });
  root.head = failTurn;
  await when(() => completionsOf(failTurn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ fail: "boom" });
  await when(() => failTurn.reducerExited, { timeout: TIMEOUT });
  const failSeal = {
    reducerExited: failTurn.reducerExited,
    completions: completionsOf(failTurn).length,
    tools: failTurn.work.some((chunk) => chunk instanceof ToolCallJob),
  };

  const genesis = new SessionSystemPrompt();
  const priorTurn = new SessionTurn({ turnTail: genesis, prompt: prompt.user`old` });
  root.head = priorTurn;
  await when(() => completionsOf(priorTurn).length === 1, { timeout: TIMEOUT });
  const prior = completionsOf(priorTurn)[0]!;
  const priorMessages = prior.messages;
  modelOf(session).reply({ text: "old-out" });
  await when(() => priorTurn.reducerExited, { timeout: TIMEOUT });
  const later = new SessionTurn({ turnTail: priorTurn, prompt: prompt.user`new` });
  root.head = later;
  await when(() => completionsOf(later).length === 1, { timeout: TIMEOUT });
  const laterMessages = completionsOf(later)[0]!.messages;
  modelOf(session).reply({ text: "ok" });
  await when(() => later.reducerExited, { timeout: TIMEOUT });

  expect({
    replica,
    mint,
    mintSealed,
    tools,
    secondRound,
    toolsSealed,
    mail,
    recover,
    failSeal,
    later: { priorMessages, laterMessages, reducerExited: later.reducerExited },
  }).toMatchObject({
    replica: {
      connection: scriptedConnectionId(),
      turn: true,
      prompt: "hello",
      turnTail: expect.any(SessionSystemPrompt),
      promptChunk: expect.any(TurnPromptChunk),
    },
    mint: {
      promptChunk: expect.any(TurnPromptChunk),
      promptText: "hello",
      connectionId: scriptedConnectionId(),
      model: "grok-4.6",
      messages: [],
      reducerExited: false,
    },
    mintSealed: { reducerExited: true, work: 3 },
    tools: {
      name: "echo",
      toolCallId: "call_1",
      kind: true,
      parent: toolTurn,
      react: true,
      reducerExited: false,
    },
    secondRound: { promptText: "", messages: [firstToolCompletion, echo] },
    toolsSealed: true,
    mail: {
      name: "mcp__mail__search",
      kind: true,
      connectionKey: "mail",
      serverToolName: "search",
      args: {},
    },
    recover: "echo",
    failSeal: { reducerExited: true, completions: 1, tools: false },
    later: { priorMessages: [], laterMessages: [prior], reducerExited: true },
  });
}, 40_000);

test.each(rows)(
  "loop-end lattice — $name",
  async (row) => {
    resetLocalIDs();
    const session = await openSession();
    if (row.door != null) {
      const { got, want } = await runDoor(session, row.door);
      expect(got).toEqual(want);
      return;
    }
    const { got, want } = await runLoopEnd(session, row);
    expect(got).toEqual(want);
  },
  15_000,
);

test("rename RPC and queued /rename set and clear the manual title", async () => {
  resetLocalIDs();
  const session = await openSession();
  const root = session.root;
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello there` });
  root.head = turn;
  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const auto = root.title;
  await session.handleRequest("rename", { title: "  Auth refactor  " });
  const renamed = { manual: root.manualTitle, title: root.title };
  admitQueue(root, prompt.user`/rename --auto`, turn.uuid);
  modelOf(session).reply({ text: "hi" });
  await when(() => turn.reducerExited && root.manualTitle === "" && root.promptQueue.length === 0, {
    timeout: TIMEOUT,
  });
  expect({ auto, renamed, cleared: { head: root.head, title: root.title } }).toEqual({
    auto: "hello there",
    renamed: { manual: "Auth refactor", title: "Auth refactor" },
    cleared: { head: turn, title: "hello there" },
  });
}, 15_000);

async function runLoopEnd(session: SessionDaemon, row: Row): Promise<{ got: unknown; want: unknown }> {
  const root = session.root;
  if (row.callback === true) {
    session.root.agent.spec.voidLegal = false;
    session.root.agentCallbacks.open = "caller";
  }
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`${promptFor(row)}`,
    ...(row.callback === true ? { agentRequestId: "open" } : {}),
  });
  root.head = turn;
  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const calls = callsOf(row);
  modelOf(session).reply({ text: row.prose ?? "", ...(calls != null ? { calls } : {}) });
  if (row.want === "silent") {
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
  } else {
    await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
  }

  const comps = completionsOf(turn);
  const react = reactChunks(turn).some((chunk) => chunk instanceof ReACTChunk && !chunk.skipped);
  const note = comps[1]?.systemNote ?? comps[0]?.systemNote ?? "";
  const got: Record<string, unknown> = {
    reducerExited: turn.reducerExited,
    react,
    completions: comps.length,
    note,
  };
  const want: Record<string, unknown> = {
    reducerExited: row.want === "silent",
    react: row.want !== "silent",
    completions: row.want === "silent" ? 1 : 2,
    note: expectedNote(row, session),
  };
  if (row.metadata === true || row.mixed === true) {
    got.title = root.title;
    want.title = row.mixed === true ? "List dir" : "Fix login";
  }
  if (row.metadata === true && (row.prose ?? "") === "") {
    got.description = root.turnDescription;
    got.glance = {
      status: session.kernel.plexus.root.sessions[session.sessionId]?.status,
      model: session.kernel.plexus.root.sessions[session.sessionId]?.model,
    };
    want.description = "doing it";
    want.glance = { status: "doing it", model: "grok-4.6" };
  }
  if (row.mixed === true) {
    const jobs = turn.work.filter((chunk): chunk is ToolCallJob => chunk instanceof ToolCallJob);
    got.names = jobs.map((job) => job.name);
    want.names = ["update_metadata", CONTEXT_NEED_TOOL_NAME, "list_dir"];
  }
  return { got, want };
}

async function runDoor(session: SessionDaemon, door: Door): Promise<{ got: unknown; want: unknown }> {
  const root = session.root;
  switch (door) {
    case "retry-idle":
      return {
        got: { result: await session.handleRequest("turn/retry", {}), head: root.head },
        want: { result: { ok: true }, head: null },
      };
    case "continue-running": {
      const okTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello` });
      root.head = okTurn;
      await when(() => completionsOf(okTurn).length === 1, { timeout: TIMEOUT });
      const result = await session.handleRequest("turn", { prompt: "", kind: "continue" });
      return {
        got: {
          result,
          uuid: root.head?.uuid,
          steer: root.steerQueue.map((row) => row.text),
          queue: root.promptQueue.map((row) => row.text),
        },
        want: { result: { ok: true }, uuid: okTurn.uuid, steer: [], queue: [] },
      };
    }
    case "continue-success": {
      const okTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hello` });
      root.head = okTurn;
      await when(() => completionsOf(okTurn).length === 1, { timeout: TIMEOUT });
      modelOf(session).reply({ text: "hi" });
      await when(() => okTurn.reducerExited, { timeout: TIMEOUT });
      const result = await session.handleRequest("turn", { prompt: "", kind: "continue" });
      return {
        got: { result, uuid: root.head?.uuid },
        want: { result: { ok: true }, uuid: okTurn.uuid },
      };
    }
    case "continue-fail-no-wire": {
      const failTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`nope` });
      root.head = failTurn;
      await when(() => completionsOf(failTurn).length === 1, { timeout: TIMEOUT });
      modelOf(session).reply({ fail: "boom" });
      await when(() => failTurn.reducerExited, { timeout: TIMEOUT });
      await session.handleRequest("kv/clear", { key: "connection" });
      return {
        got: await rejected(session.handleRequest("turn", { prompt: "", kind: "continue" })),
        want: { ok: false, invalid: true },
      };
    }
    case "continue-fail": {
      const failTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`nope` });
      root.head = failTurn;
      await when(() => completionsOf(failTurn).length === 1, { timeout: TIMEOUT });
      const failed = completionsOf(failTurn)[0]!;
      modelOf(session).reply({ fail: "boom" });
      await when(() => failTurn.reducerExited, { timeout: TIMEOUT });
      const result = await session.handleRequest("turn", { prompt: "", kind: "continue" });
      const continued = root.head;
      await when(() => continued != null && completionsOf(continued).length === 1, { timeout: TIMEOUT });
      const next = completionsOf(continued!)[0]!;
      const got = {
        result,
        newTurn: continued?.uuid !== failTurn.uuid,
        prompt: continued?.prompt,
        promptText: next.promptText,
        messages: next.messages,
      };
      modelOf(session).reply({ text: "ok" });
      await when(() => continued!.reducerExited, { timeout: TIMEOUT });
      return {
        got,
        want: { result: { ok: true }, newTurn: true, prompt: "", promptText: "", messages: [failed] },
      };
    }
    case "continue-cancel": {
      const run = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`run` });
      root.head = run;
      await when(() => completionsOf(run).length === 1, { timeout: TIMEOUT });
      const live = completionsOf(run)[0]!;
      await session.handleRequest("turn/cancel", { turnId: run.uuid });
      await when(() => run.reducerExited, { timeout: TIMEOUT });
      const result = await session.handleRequest("turn", { prompt: "", kind: "continue" });
      const afterCancel = root.head;
      await when(() => afterCancel != null && completionsOf(afterCancel).length === 1, {
        timeout: TIMEOUT,
      });
      const resumed = completionsOf(afterCancel!)[0]!;
      const got = {
        cancelled: {
          cancelRequested: run.cancelRequested,
          cancelled: run.cancelled,
          liveOutcome: live.outcome,
          continue: run.lastTurnIncomplete,
        },
        result,
        newTurn: afterCancel?.uuid !== run.uuid,
        promptText: resumed.promptText,
        messages: resumed.messages,
      };
      modelOf(session).reply({ text: "ok" });
      await when(() => afterCancel!.reducerExited, { timeout: TIMEOUT });
      return {
        got,
        want: {
          cancelled: { cancelRequested: true, cancelled: true, liveOutcome: "failed", continue: true },
          result: { ok: true },
          newTurn: true,
          promptText: "",
          messages: [live],
        },
      };
    }
  }
}

function promptFor(row: Row): string {
  if (row.callback === true) return "answer";
  if (row.mixed === true) return "use echo";
  if (row.metadata === true) return "fix login";
  return "hello";
}

function expectedNote(row: Row, session: SessionDaemon): string {
  switch (row.want) {
    case "idle":
      return METADATA_SAME_ROUND_NOTE;
    case "callback":
      return callbackRequiredNote(false, session.root.openCallbackRows());
    default:
      return "";
  }
}

function callsOf(row: Row) {
  if (row.mixed === true) {
    return [
      responseCall("r1", "list_dir", JSON.stringify({ path: "." })),
      responseCall("n1", CONTEXT_NEED_TOOL_NAME, JSON.stringify({ min_remaining_tokens: 10 })),
      responseCall("m1", "update_metadata", JSON.stringify({ current_turn_title: "List dir" })),
    ];
  }
  if (row.metadata === true) {
    return [metadataCall("m1", "Fix login")];
  }
  return undefined;
}

async function rejected(
  promise: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; invalid: boolean }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, invalid: error instanceof RpcInvalidParams };
  }
}

async function phaseMintReplicaSees(): Promise<unknown> {
  const kernel = realpathSync(mkdtempSync(join(tmpdir(), "harness-react-mint-k-")));
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "harness-react-mint-p-")));
  try {
    await using daemon = new HarnessDaemon(kernel);
    await daemon.listen();
    await using client = await Client.start(kernel, workspace);
    installScriptedModel(await daemon.kernel());
    await client.request("kv/set", { key: "connection", value: scriptedConnectionId() });
    await client.request("kv/set", { key: "model", value: "m1" });
    await when(() => client.sessionRoot.kvs.connection === scriptedConnectionId(), { timeout: REPLICA_MS });
    await expect(client.request("turn", { prompt: "hello" })).resolves.toEqual({ ok: true });
    await when(() => client.sessionRoot.head instanceof SessionTurn && client.sessionRoot.head.prompt === "hello", {
      timeout: REPLICA_MS,
    });
    const first = client.sessionRoot.head;
    return {
      connection: client.sessionRoot.kvs.connection,
      turn: first instanceof SessionTurn,
      prompt: first instanceof SessionTurn ? first.prompt : "",
      turnTail: first instanceof SessionTurn ? first.turnTail : null,
      promptChunk:
        first instanceof SessionTurn ? reactChunks(first).find((chunk) => chunk instanceof TurnPromptChunk) : null,
    };
  } finally {
    rmSync(kernel, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function metadataCall(id: string, title: string) {
  return responseCall(
    id,
    "update_metadata",
    JSON.stringify({ current_turn_title: title, current_turn_description: "doing it" }),
  );
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-react-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-react-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return session;
}
