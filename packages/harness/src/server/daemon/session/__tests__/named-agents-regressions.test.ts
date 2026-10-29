import { mkdtemp, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  BotCallJob,
  CallJob,
  AgentCallNotification,
  AgentCallbackJob,
  CompletionExpectation,
  CompletionJob,
  isNoteClaimed,
  ReACTChunk,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  tapeCompletion,
  TurnNotificationChunk,
} from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { chatContentText, notificationMessagesOf, toolsFor, viewWire } from "@/providers/openai-compat";
import { catalogRecipe } from "@/tool-catalog";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const timeout = 3000;
async function setup() {
  const system = await realpath(await mkdtemp(join(tmpdir(), "agent-regression-k-")));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "agent-regression-p-")));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  kernel.catalog.replaceRecipes([
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
  const project = new ProjectDaemon(kernel, workspace);
  const caller = await project.session("caller");
  attachScriptedModel(kernel, caller, "dummy");
  onTestFinished(() => {
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { system, workspace, kernel, project, caller };
}
function closed(...jobs: Array<CallJob | SystemToolJob>) {
  return new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], doneWork: jobs, reducerExited: true });
}
async function invoke(env: Awaited<ReturnType<typeof setup>>, name = "worker") {
  const call = new BotCallJob({
    toolCallId: `call-${name}`,
    name: "agent__send",
    argsJson: JSON.stringify({ spec: name, message: "work" }),
    humanApprove: true,
  });
  env.caller.root.head = closed(call);
  await when(() => call.workerSessionId !== "" && env.kernel.sessionPlexus(call.workerSessionId)?.root.head != null, {
    timeout,
  });
  return { call, worker: env.kernel.liveSession(call.workerSessionId)! };
}
describe("named agents review regressions", { timeout: 15_000 }, () => {
  it("enforces omitted tool ceilings at wire, admission, and execution even for an approved forged job", async () => {
    const env = await setup();
    const { worker } = await invoke(env);
    const pew = new CompletionExpectation({ connectionId: "dummy" });
    worker.root.head = new SessionTurn({
      turnTail: worker.root.head!,
      doneWork: [new CompletionJob({ expectation: pew })],
      queue: [],
      reducerExited: true,
    });
    const respond = toolsFor(pew).find((tool) => tool.function.name === "agent__respond");
    const workerWires = toolsFor(pew).map((tool) => tool.function.name);
    const target = join(env.workspace, "untouched.txt");
    await writeFile(target, "before");
    const argsJson = JSON.stringify({ command: `echo after > ${target}` });
    const admitted = env.project.toolCalls.admit(
      { id: "forged", type: "function", function: { name: "shell", arguments: argsJson } },
      env.kernel.catalog,
      { session: worker.root },
    );
    const forged = new SystemToolJob({ toolCallId: "bypass", name: "shell", argsJson, humanApprove: true });
    worker.root.head = closed(forged);
    await when(() => forged.completed, { timeout });
    expect({
      wire: {
        host: workerWires.filter((name) => ["update_metadata", "context_need", "scheme_repl"].includes(name)).sort(),
        shell: workerWires.includes("shell"),
        leaf: workerWires.includes("call__leaf__run"),
        respond: {
          listed: workerWires.includes("agent__respond"),
          enum: (respond?.function.parameters as { properties?: { requestId?: { enum?: string[] } } })?.properties
            ?.requestId?.enum,
        },
      },
      admission: admitted.completed,
      execution: { outcome: forged.receiptJson, file: await readFile(target, "utf8") },
    }).toEqual({
      wire: {
        host: ["context_need", "scheme_repl", "update_metadata"],
        shell: false,
        leaf: false,
        // A fixed tool: the open ids ride in the round's system note, not in tools[].
        respond: { listed: true, enum: undefined },
      },
      admission: true,
      execution: { outcome: expect.stringContaining("outside worker tool ceiling"), file: "before" },
    });
  });

  it("open-call notifications land before the user message; late notes force-restart; closed turn ignores later notes", async () => {
    const env = await setup();
    const { call } = await invoke(env);
    call.background = true;
    const note = new AgentCallNotification({ message: "important progress" });
    call.notifications.push(note);
    const producer = env.caller.root.head!;
    env.caller.root.kvs.connection = scriptedConnectionId("dummy");
    const consumer = new SessionTurn({ turnTail: producer, prompt: prompt.user`continue` });
    env.caller.root.head = consumer;
    await when(() => consumer.work.some((work) => tapeCompletion(work) != null), { timeout });
    const completion = tapeCompletion(consumer.work.find((work) => tapeCompletion(work) != null));
    if (completion == null) throw new Error("expected completion");
    expect({
      callDone: call.completed,
      consumed: isNoteClaimed(note),
      beforeUser: completion.messages.some(
        (cell) => cell instanceof TurnNotificationChunk && cell.notificationText().includes("important progress"),
      ),
      wire: [...viewWire(completion)].some((row) => chatContentText(row.content).includes("important progress")),
      notify: chatContentText(notificationMessagesOf(completion)[0]?.content).includes("important progress"),
    }).toEqual({ callDone: false, consumed: true, beforeUser: true, wire: true, notify: true });

    const late = new AgentCallNotification({ message: "more later" });
    call.notifications.push(late);
    modelOf(env.caller).reply({ text: "done" });
    await when(() => consumer.doneWork.filter((chunk) => tapeCompletion(chunk) != null).length >= 2, { timeout });
    const second = tapeCompletion(consumer.doneWork.filter((chunk) => tapeCompletion(chunk) != null)[1]);
    if (second == null) throw new Error("expected second completion");
    expect({
      lateConsumed: isNoteClaimed(late),
      lateWire: [...viewWire(second)].some((row) => chatContentText(row.content).includes("more later")),
    }).toEqual({ lateConsumed: true, lateWire: true });
    modelOf(env.caller).reply({ text: "done" });
    await when(() => consumer.reducerExited, { timeout });
    const afterClose = new AgentCallNotification({ message: "too late" });
    call.notifications.push(afterClose);
    expect({
      reducerExited: consumer.reducerExited,
      reactAfterClose: consumer.queue.some((chunk) => chunk instanceof ReACTChunk),
      pending: env.caller.root.pendingNotifications.some((row) => row.message === "too late"),
    }).toEqual({ reducerExited: true, reactAfterClose: false, pending: true });

    const nestedEnv = await setup();
    const nestedInvoke = await invoke(nestedEnv);
    const nested = new BotCallJob({
      name: "agent__send",
      toolCallId: "nested",
      argsJson: JSON.stringify({ spec: "leaf", message: "work" }),
      background: true,
      humanApprove: true,
    });
    const turn = new SessionTurn({ turnTail: nestedInvoke.worker.root.head!, queue: [nested] });
    nestedInvoke.worker.root.head = turn;
    await when(
      () =>
        nested.workerSessionId !== "" &&
        nestedEnv.kernel.sessionPlexus(nested.workerSessionId)?.root.agentCallbacks[nested.uuid] != null,
      { timeout },
    );
    const leaf = nestedEnv.kernel.sessionPlexus(nested.workerSessionId)!;
    const callback = new AgentCallbackJob({
      name: "agent__respond",
      argsJson: JSON.stringify({ requestId: nestedInvoke.call.uuid, response: "done" }),
      humanApprove: true,
    });
    turn.pushChild(callback);
    await when(() => callback.completed && nestedInvoke.call.completed, { timeout });
    expect({
      completed: nested.completed,
      outcome: nested.sealedOutcomeJson(),
      row: leaf.root.agentCallbacks[nested.uuid],
    }).toEqual({
      completed: true,
      outcome: expect.stringContaining("rejected"),
      row: undefined,
    });
  });
});
