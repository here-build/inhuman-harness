import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BotCallJob,
  ProgrammaticJob,
  ReACTChunk,
  reactChunks,
  responseCall,
  ToolCallJob,
  SessionSystemPrompt,
  SessionTurn,
  tapeCompletion,
} from "@inhuman.tools/harness-model";
import { schemeReplDescription } from "@inhuman.tools/harness-scheme";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";

import {
  CallerLedger,
  callMethod,
  KernelStateStore,
  type ReducerDecl,
  StateDirectory,
  toJS,
  type Val,
} from "@/extensions";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { sessionCatalog } from "../../../toolkit/tool-table.js";
import { reflectKernel } from "../../kernel/fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 5_000;
const PLUGINS = fileURLToPath(new URL("../../../../../../../plugins", import.meta.url));

type Installed = {
  readonly kernel: KernelDaemon;
  readonly session: SessionDaemon;
};

async function withPlugins(
  packages: Record<string, string>,
  opts: {
    readonly config?: object;
    readonly files?: Record<string, string>;
  } = {},
): Promise<Installed> {
  const system = await mkdtemp(join(tmpdir(), "harness-behavior-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-behavior-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const pkgPath = join(system, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = { ...pkg.dependencies };
  for (const [npmName, root] of Object.entries(packages)) {
    pkg.dependencies[npmName] = "0.0.0";
    const link = join(system, "node_modules", npmName);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(root, link);
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (opts.config != null) {
    writeFileSync(join(system, "config.json"), JSON.stringify(opts.config));
  }
  for (const [path, text] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(workspace, path), text);
  }
  reflectKernel(system, kernel.plexus.root);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  attachScriptedModel(kernel, session);
  return { kernel, session };
}

function completionsOf(turn: SessionTurn) {
  const out = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

function goalOwner(kernel: KernelDaemon, sessionId: string): string {
  return kernel.behavior.directory.ownerId("inhuman-plugin-goal", "session", sessionId, "state");
}

async function goal(kernel: KernelDaemon, sessionId: string, method: string, args: Record<string, Val>) {
  const ownerId = goalOwner(kernel, sessionId);
  return callMethod({
    directory: kernel.behavior.directory,
    caller: new CallerLedger(),
    bindings: new Map([
      [
        "goal",
        {
          alias: "goal",
          ownerId,
          methods: new Set([method]),
          abi: kernel.behavior.directory.get(ownerId).abi,
        },
      ],
    ]),
    receiver: "goal",
    method,
    args,
    callId: `${method}-test`,
  });
}

test("the goal plugin's round hook continues a text-only turn until its loops are spent", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins({
    "@inhuman.tools/plugin-goal": join(PLUGINS, "inhuman-plugin-goal"),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`start`,
  });
  session.root.head = turn;

  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const pin = JSON.parse(session.root.agent.spec.behaviorPin) as {
    behaviors: { plugin: string; bot: string }[];
  };
  await goal(kernel, "s1", "set", { text: "ship it", loops: 1 });
  const first = completionsOf(turn)[0]!;
  modelOf(session).reply({ text: "working on it" });

  await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
  const second = completionsOf(turn)[1]!;
  modelOf(session).reply({ text: "done" });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });

  expect({
    pinned: pin.behaviors.map((row) => `${row.plugin}/${row.bot}`),
    firstNote: first.systemNote,
    secondNote: second.systemNote,
    completions: completionsOf(turn).length,
    log: kernel.behavior.directory.get(goalOwner(kernel, "s1")).log.map((action) => toJS(action)),
  }).toEqual({
    pinned: ["tasks/foreground", "inhuman-plugin-goal/foreground"],
    firstNote: "",
    secondNote: expect.stringContaining("ship it"),
    completions: 2,
    log: [{ type: "set", text: "ship it", loops: 1 }, { type: "tick" }],
  });
}, 15_000);

test("a failed round runs the goal's post-fail hook, which blocks it", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins({
    "@inhuman.tools/plugin-goal": join(PLUGINS, "inhuman-plugin-goal"),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`start`,
  });
  session.root.head = turn;

  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  await goal(kernel, "s1", "set", { text: "ship it", loops: 3 });
  await session.handleRequest("turn/cancel", { turnId: turn.uuid });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });

  expect(toJS(await goal(kernel, "s1", "get", {}))).toEqual({
    text: "ship it",
    status: "blocked",
    loops: 3,
  });
}, 15_000);

test("a plugin command calls its plugin's own state; the kernel lists /goal with its body", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins({
    "@inhuman.tools/plugin-goal": join(PLUGINS, "inhuman-plugin-goal"),
  });
  const call = (params: object) =>
    session.handleRequest("plugin/method", {
      plugin: "inhuman-plugin-goal",
      ...params,
    });
  const set = { method: "set", args: '{"loops": 32}', field: "text" };

  expect({
    body: kernel.plexus.root.commands.goal?.body,
    empty: await call({ ...set, input: "  " }),
    set: await call({ ...set, input: "ship it" }),
    get: await call({ method: "get" }),
    badArgs: await call({ method: "set", args: "[1]" }),
    unknown: await call({ method: "explode" }),
    missing: await session.handleRequest("plugin/method", {
      plugin: "gone",
      method: "get",
    }),
    log: kernel.behavior.directory.get(goalOwner(kernel, "s1")).log.map((action) => toJS(action)),
  }).toEqual({
    body: readFileSync(join(PLUGINS, "inhuman-plugin-goal/tools/inhuman/commands/goal.scm"), "utf8"),
    empty: { ok: false, error: "text is required" },
    set: { ok: true, value: "ship it" },
    get: { ok: true, value: { text: "ship it", status: "active", loops: 32 } },
    badArgs: { ok: false, error: "args must be a JSON object" },
    unknown: {
      ok: false,
      error: "inhuman-plugin-goal session state has no method explode",
    },
    missing: { ok: false, error: "plugin gone is not enabled" },
    log: [{ type: "set", text: "ship it", loops: 32 }],
  });
});

test("session plugin state lives on the session document and a rewind restores the turn's end state", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins({
    "@inhuman.tools/plugin-goal": join(PLUGINS, "inhuman-plugin-goal"),
  });
  const call = (method: string, extra: object = {}) =>
    session.handleRequest("plugin/method", {
      plugin: "inhuman-plugin-goal",
      method,
      ...extra,
    });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`start`,
  });
  session.root.head = turn;
  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  await goal(kernel, "s1", "set", { text: "first", loops: 1 });
  modelOf(session).reply({ text: "working" });
  await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
  const ended = await call("get");
  await call("set", {
    args: '{"loops": 5}',
    field: "text",
    input: "second",
  });
  const moved = await call("get");
  const liveLog = session.root.pluginState["inhuman-plugin-goal:state"];
  await session.handleRequest("turn/rewind", { turnId: turn.uuid });
  const rewound = await call("get");
  const reopened = new StateDirectory(
    new KernelStateStore(
      () => kernel.root,
      (id) => (id === "s1" ? session.root : undefined),
    ),
  );
  const ownerId = goalOwner(kernel, "s1");
  const restarted = reopened
    .open(ownerId, "session", "abi", {} as ReducerDecl, new Map())
    .log.map((action) => toJS(action));

  expect({
    ended,
    moved,
    liveLog: JSON.parse(liveLog ?? "[]"),
    rewound,
    snapshot: turn.pluginState,
    restarted,
  }).toEqual({
    ended: {
      ok: true,
      value: { text: "first", status: "exhausted", loops: 0 },
    },
    moved: { ok: true, value: { text: "second", status: "active", loops: 5 } },
    liveLog: [{ type: "set", text: "first", loops: 1 }, { type: "tick" }, { type: "set", text: "second", loops: 5 }],
    rewound: {
      ok: true,
      value: { text: "first", status: "exhausted", loops: 0 },
    },
    snapshot: {
      "inhuman-plugin-goal:state": JSON.stringify([{ type: "set", text: "first", loops: 1 }, { type: "tick" }]),
    },
    restarted: [{ type: "set", text: "first", loops: 1 }, { type: "tick" }],
  });
}, 15_000);

function inlinePackage(npmName: string, pluginName: string, files: Record<string, string>, extension?: object): string {
  const root = mkdtempSync(join(tmpdir(), "harness-behavior-plugin-"));
  const all = {
    "package.json": JSON.stringify({ name: npmName, version: "0.0.0" }),
    "plugin.json": JSON.stringify({
      name: pluginName,
      extensions: {
        "tools.inhuman": extension ?? { bots: ["./foreground.prompt"] },
      },
    }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const TOOLS_PROGRAM = `
(define/tool 'echo :description "Echo text back loudly" :expose 'tool
  :input (s/object (s/field "text" (s/string)))
  :handler (lambda (input) (string-append (:text input) "!")))
(define/tool 'ping :description "Answer pong" :expose 'tool :representation 'both :triggers-react-loop #f
  :input (s/object)
  :handler (lambda (input) "pong"))
`;

test("declared tools join the turn: JSON tools on the wire, the rest as scheme_repl symbols; both run", async () => {
  resetLocalIDs();
  const root = inlinePackage("@test/tools", "tools-plugin", {
    "foreground.prompt": "---\nattach: foreground\nbehavior:\n  program: ./foreground.scm\n---\nTools.\n",
    "foreground.scm": TOOLS_PROGRAM,
  });
  const { session } = await withPlugins({ "@test/tools": root });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`use them`,
  });
  session.root.head = turn;

  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const wire = new Set(turn.tools.entries.map((entry) => entry.name));
  const repl = turn.tools.entries.find((entry) => entry.name === "scheme_repl")?.description ?? "";
  modelOf(session).reply({
    calls: [
      responseCall("p1", "ping", "{}"),
      responseCall("e1", "scheme_repl", JSON.stringify({ expr: `(echo {text: "hi"})` })),
    ],
  });
  const ping = () => reactChunks(turn).find((chunk): chunk is ToolCallJob => chunk instanceof ToolCallJob);
  const program = () => reactChunks(turn).find((chunk) => chunk instanceof ProgrammaticJob);
  const inner = () => (program() as ProgrammaticJob | undefined)?.toolCalls[0];
  await when(() => ping()?.completed === true && program()?.completed === true, { timeout: TIMEOUT });

  expect({
    wire: { ping: wire.has("ping"), echo: wire.has("echo") },
    repl: { slug: repl.includes("tools-plugin"), echo: /\(echo\b/.test(repl) },
    ping: JSON.parse(ping()?.receiptJson ?? "") as unknown,
    echo: program()?.resultText(),
    judged: [ping()?.policyResult ?? null, inner()?.policyResult ?? null],
  }).toEqual({
    wire: { ping: true, echo: false },
    repl: { slug: true, echo: true },
    ping: { ok: true, text: "pong" },
    echo: expect.stringContaining("hi!"),
    judged: [null, null],
  });
}, 15_000);

const MEMO_FILES = {
  "writer.prompt": `---
description: Keeps project notes
tools: [read_file]
behavior:
  program: ./writer.scm
  bindings:
    memo:
      plugin: memo
      scope: project
      methods: [put]
---
Keep the notes you are asked to keep.
`,
  "writer.scm": `
(define/tool 'note :description "Keep a note" :expose 'tool :representation 'both :triggers-react-loop #f
  :input (s/object (s/field "text" (s/string)))
  :handler (lambda (input) (call/method 'memo 'put :text (:text input))))
`,
  "project.scm": `
(define/reducer
  :initial (lambda () (dict :notes (list)))
  :reduce (lambda (state action) (dict :notes (append (:notes state) (list (:text action))))))
(define/method 'put
  :kind 'command
  :input (s/object (s/field "text" (s/string)))
  :output (s/string)
  :handler (lambda (input state) (state/propose (dict :type "put" :text (:text input))) "kept"))
`,
};

test("a plugin bot is a named agent whose worker runs its pinned behavior", async () => {
  resetLocalIDs();
  const root = inlinePackage("@test/memo", "memo", MEMO_FILES, {
    bots: ["./writer.prompt"],
    states: { project: "./project.scm" },
  });
  const { kernel, session } = await withPlugins({ "@test/memo": root });
  const recipe = kernel.catalog.recipe("writer");
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`note hello`,
  });
  session.root.head = turn;

  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  const inventory = schemeReplDescription(sessionCatalog(session.root) ?? kernel.catalog);
  modelOf(session).reply({
    calls: [responseCall("e1", "scheme_repl", JSON.stringify({ expr: `(bot/send 'writer "keep: hello")` }))],
  });
  const call = () =>
    reactChunks(turn)
      .filter((chunk): chunk is ProgrammaticJob => chunk instanceof ProgrammaticJob)
      .flatMap((program) => program.children)
      .find((child): child is BotCallJob => child instanceof BotCallJob);
  await when(() => (call()?.workerSessionId ?? "") !== "", {
    timeout: TIMEOUT,
  });
  const worker = kernel.sessionPlexus(call()!.workerSessionId)!;
  const workerTurn = () => (worker.root.head instanceof SessionTurn ? worker.root.head : null);
  await when(() => workerTurn() != null && completionsOf(workerTurn()!).length === 1, { timeout: TIMEOUT });
  const pin = JSON.parse(worker.root.agent.spec.behaviorPin) as {
    behaviors: { plugin: string; bot: string }[];
  };
  const workerTools = new Set(workerTurn()!.tools.entries.map((entry) => entry.name));
  modelOf(session).reply({ calls: [responseCall("n1", "note", JSON.stringify({ text: "hello" }))] });
  const note = () =>
    reactChunks(workerTurn()!).find(
      (chunk): chunk is ToolCallJob => chunk instanceof ToolCallJob && chunk.name === "note",
    );
  await when(() => note()?.completed === true, { timeout: TIMEOUT });
  const ownerId = kernel.behavior.directory.ownerId("memo", "project", session.project.path, "state");

  expect({
    recipe: { tools: recipe?.spec.tools, behavior: recipe?.spec.behavior },
    listed: /writer\s+Keeps project notes/.test(inventory),
    pinned: pin.behaviors.map((row) => `${row.plugin}/${row.bot}`),
    workerTools: {
      note: workerTools.has("note"),
      shell: workerTools.has("shell"),
    },
    note: JSON.parse(note()!.receiptJson ?? "") as unknown,
    log: kernel.behavior.directory.get(ownerId).log.map((action) => toJS(action)),
  }).toEqual({
    recipe: {
      tools: ["read_file"],
      behavior: { plugin: "memo", bot: "writer" },
    },
    listed: true,
    pinned: ["memo/writer"],
    workerTools: { note: true, shell: false },
    note: { ok: true, text: "kept" },
    log: [{ type: "put", text: "hello" }],
  });
}, 20_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

/**
 * A deferred external plugin callback, installed after the real package and
 * state modules load. Dispatch, method proposals, daemon and document remain
 * live; only the plugin's completion is controlled by this fixture.
 */
function suspendPluginMutation(kernel: KernelDaemon, toolHook?: "read" | "agent") {
  const entered = deferred<void>();
  const release = deferred<void>();
  const returned = deferred<void>();
  const installed = new Set<string>();
  const install = (ownerId: string) => {
    if (installed.has(ownerId)) return;
    installed.add(ownerId);
    const method = kernel.behavior.directory.get(ownerId).methods.get("mark")!;
    const call = method.handler.call;
    Object.assign(method.handler, {
      call: async (...args: unknown[]) => {
        const result = await call(...args);
        entered.resolve();
        await release.promise;
        returned.resolve();
        return result;
      },
    });
  };
  const existing = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
  if (kernel.behavior.directory.has(existing)) install(existing);
  const attach = kernel.behavior.attach.bind(kernel.behavior);
  kernel.behavior.attach = async (opts) => {
    const attached = await attach(opts);
    if (toolHook) {
      for (const instance of attached.agent.instances.filter((row) => row.plugin === "stalled")) {
        instance.registry.hooks.splice(
          0,
          instance.registry.hooks.length,
          ...instance.registry.hooks.map((hook) => ({ ...hook, point: toolHook })),
        );
      }
    }
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", opts.agentId, "state");
    if (kernel.behavior.directory.has(ownerId)) install(ownerId);
    return attached;
  };
  onTestFinished(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve(), returned: returned.promise };
}

function latePluginNotes(kernel: KernelDaemon): string[] {
  return kernel.behavior.notes.notes
    .filter((note) => note.agentId === "s1" && note.message === "late plugin note")
    .map((note) => note.message);
}

function stalledPlugin(phase: "pre" | "post") {
  return inlinePackage(
    "@test/stalled",
    "stalled",
    {
      "foreground.prompt": `---
attach: foreground
behavior:
  program: ./foreground.scm
  bindings:
    state:
      plugin: stalled
      scope: session
      methods: [mark]
---
Suspended plugin callback.
`,
      "foreground.scm": `(hook/round :${phase} (lambda (round . ignored)
      (call/method 'state 'mark)
      (self/notify 'ambient "late plugin note")))`,
      "session.scm": `
(define/reducer :initial (lambda () 0) :reduce (lambda (state action) (+ state 1)))
(define/method 'mark :kind 'mutation :input (s/object) :output (s/number)
  :handler (lambda (input state) (state/propose "mark") (+ state 1)))`,
    },
    { bots: ["./foreground.prompt"], states: { session: "./session.scm" } },
  );
}

test.each(["pre", "post"] as const)(
  "a suspended round %s hook times out and cannot write state or notes after the turn exits",
  async (phase) => {
    resetLocalIDs();
    const { kernel, session } = await withPlugins({ "@test/stalled": stalledPlugin(phase) });
    await session.handleRequest("kv/set", { key: "plugin.hook-timeout-ms", value: "40" });
    const callback = suspendPluginMutation(kernel);
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`start` });
    session.root.head = turn;
    if (phase === "post") {
      await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
      modelOf(session).reply({ text: "done" });
    }
    await callback.entered;
    if (phase === "pre") {
      await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
      modelOf(session).reply({ text: "done" });
    }
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    const ended = { exited: turn.reducerExited, problem: session.root.pluginProblem };
    callback.release();
    await callback.returned;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
    expect({
      ended,
      log: kernel.behavior.directory.get(ownerId).log.map(toJS),
      notes: latePluginNotes(kernel),
      snapshot: turn.pluginState?.["stalled:state"] ?? "[]",
    }).toEqual({
      ended: { exited: true, problem: expect.stringContaining("plugin round hook: no answer in 40ms; skipped") },
      log: [],
      notes: [],
      snapshot: "[]",
    });
  },
  15_000,
);

test.each(["cancel", "park"] as const)(
  "%s stops a suspended pre hook before its deadline and revokes its eventual effects",
  async (stop) => {
    resetLocalIDs();
    const { kernel, session } = await withPlugins({ "@test/stalled": stalledPlugin("pre") });
    const callback = suspendPluginMutation(kernel);
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`start` });
    session.root.head = turn;
    await callback.entered;
    if (stop === "cancel") {
      await session.handleRequest("turn/cancel", { turnId: turn.uuid });
      await when(() => turn.reducerExited, { timeout: TIMEOUT });
    } else await session.park();
    callback.release();
    await callback.returned;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
    expect({
      exited: turn.reducerExited,
      completions: completionsOf(turn).length,
      log: kernel.behavior.directory.get(ownerId).log.map(toJS),
      notes: latePluginNotes(kernel),
    }).toEqual({ exited: stop === "cancel", completions: 0, log: [], notes: [] });
  },
  15_000,
);

test.each(["pre", "post"] as const)(
  "replacement during a %s hook fences the old wrap and its finalizer on the same document",
  async (stage) => {
    resetLocalIDs();
    const { kernel, session } = await withPlugins({ "@test/stalled": stalledPlugin(stage) });
    const callback = suspendPluginMutation(kernel);
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`keep this turn` });
    session.root.head = turn;
    if (stage === "post") {
      await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
      modelOf(session).reply({ text: "done" });
    }
    await callback.entered;
    const replacement = new SessionRuntime(session.plexus, { kind: "memory" });
    onTestFinished(() => replacement[Symbol.asyncDispose]());
    const before = Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64");
    callback.release();
    await callback.returned;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
    expect({
      current: session.sessionRuntime.isCurrent,
      exited: turn.reducerExited,
      completed: turn.completed,
      state: Buffer.from(Y.encodeStateAsUpdate(session.plexus.doc)).toString("base64"),
      log: kernel.behavior.directory.get(ownerId).log.map(toJS),
      notes: latePluginNotes(kernel),
    }).toEqual({ current: false, exited: false, completed: false, state: before, log: [], notes: [] });
  },
  15_000,
);

test("rewinding while a post hook awaits its state method prevents the old turn from changing the restored head", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins({ "@test/stalled": stalledPlugin("post") });
  const first = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`first` });
  session.root.head = first;
  await when(() => completionsOf(first).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => first.reducerExited, { timeout: TIMEOUT });
  const snapshot = first.pluginState;
  const callback = suspendPluginMutation(kernel);
  const second = new SessionTurn({ turnTail: first, prompt: prompt.user`second` });
  session.root.head = second;
  await when(() => completionsOf(second).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await callback.entered;
  await session.handleRequest("turn/rewind", { turnId: first.uuid });
  await when(() => second.reducerExited, { timeout: TIMEOUT });
  const before = latePluginNotes(kernel);
  callback.release();
  await callback.returned;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
  expect({
    head: session.root.head.uuid,
    document: session.root.pluginState,
    snapshot: first.pluginState,
    log: kernel.behavior.directory.get(ownerId).log.map(toJS),
    notes: latePluginNotes(kernel),
  }).toEqual({ head: first.uuid, document: snapshot, snapshot, log: ["mark"], notes: before });
}, 15_000);

test("a suspended tool post hook preserves the effect receipt at its deadline and cannot later mutate the ended turn", async () => {
  resetLocalIDs();
  const { kernel, session } = await withPlugins(
    { "@test/stalled": stalledPlugin("post") },
    { files: { "note.txt": "kept effect receipt" } },
  );
  await session.handleRequest("kv/set", { key: "plugin.hook-timeout-ms", value: "40" });
  const callback = suspendPluginMutation(kernel, "read");
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`read note` });
  session.root.head = turn;
  await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
  modelOf(session).reply({ calls: [responseCall("read", "read_file", JSON.stringify({ path: "note.txt" }))] });
  await callback.entered;
  await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
  modelOf(session).reply({ text: "done" });
  await when(() => turn.reducerExited, { timeout: TIMEOUT });
  const job = reactChunks(turn).find((chunk): chunk is ToolCallJob => chunk instanceof ToolCallJob)!;
  const receipt = job.receiptJson;
  callback.release();
  await callback.returned;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
  expect({
    receipt: JSON.parse(job.receiptJson ?? ""),
    unchanged: job.receiptJson === receipt,
    problem: session.root.pluginProblem,
    log: kernel.behavior.directory.get(ownerId).log.map(toJS),
    notes: latePluginNotes(kernel),
  }).toEqual({
    receipt: { ok: true, text: expect.stringContaining("kept effect receipt") },
    unchanged: true,
    problem: expect.stringContaining("plugin read_file hook: deadline exceeded; skipped"),
    log: [],
    notes: [],
  });
}, 15_000);

test.each(["finish", "timeout", "nested owner"] as const)(
  "a completed worker call joins its owning turn finalizer before the snapshot: %s",
  async (variant) => {
    const ending = variant === "timeout" ? "timeout" : "finish";
    resetLocalIDs();
    const memo = inlinePackage("@test/memo", "memo", MEMO_FILES, {
      bots: ["./writer.prompt"],
      states: { project: "./project.scm" },
    });
    const { kernel, session } = await withPlugins({ "@test/stalled": stalledPlugin("post"), "@test/memo": memo });
    if (ending === "timeout") await session.handleRequest("kv/set", { key: "plugin.hook-timeout-ms", value: "40" });
    const callback = suspendPluginMutation(kernel, "agent");
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`delegate` });
    if (variant === "nested owner") {
      const parent = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [] });
      turn.walkBoundary = true;
      parent.children.push(turn);
      session.root.head = parent;
    } else session.root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({
      calls: [responseCall("send", "scheme_repl", JSON.stringify({ expr: `(bot/send 'writer "answer")` }))],
    });
    const call = () =>
      reactChunks(turn)
        .filter((chunk): chunk is ProgrammaticJob => chunk instanceof ProgrammaticJob)
        .flatMap((program) => program.children)
        .find((child): child is BotCallJob => child instanceof BotCallJob);
    await when(() => (call()?.workerSessionId ?? "") !== "", { timeout: TIMEOUT });
    const worker = kernel.sessionPlexus(call()!.workerSessionId)!;
    await when(() => worker.root.head instanceof SessionTurn && completionsOf(worker.root.head).length === 1, {
      timeout: TIMEOUT,
    });
    modelOf(session).reply({
      calls: [
        responseCall(
          "respond",
          "agent__respond",
          JSON.stringify({ requestId: call()!.uuid, response: "worker result" }),
        ),
      ],
    });
    await callback.entered;
    await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    if (ending === "finish") {
      await when(
        () =>
          reactChunks(turn).some(
            (chunk) =>
              chunk instanceof ReACTChunk &&
              chunk.source?.expectation === completionsOf(turn)[1] &&
              chunk.decision?.kind === "halt",
          ),
        { timeout: TIMEOUT },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect({ callCompleted: call()!.completed, turnExited: turn.reducerExited }).toEqual({
        callCompleted: true,
        turnExited: false,
      });
      callback.release();
    }
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    if (ending === "timeout") callback.release();
    await callback.returned;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
    expect({
      receipt: JSON.parse(call()!.receiptJson ?? ""),
      log: kernel.behavior.directory.get(ownerId).log.map(toJS),
      snapshot: JSON.parse(turn.pluginState?.["stalled:state"] ?? "[]"),
      notes: latePluginNotes(kernel),
      problem: session.root.pluginProblem,
    }).toEqual({
      receipt: { ok: true, value: "worker result" },
      log: ending === "finish" ? ["mark"] : [],
      snapshot: ending === "finish" ? ["mark"] : [],
      notes: ending === "finish" ? ["late plugin note"] : [],
      problem: ending === "finish" ? null : expect.stringContaining("hook: deadline exceeded; skipped"),
    });
  },
  15_000,
);

test.each(["settle", "rewind"] as const)(
  "a retained background tool owns its post hook after its parent retires: %s",
  async (ending) => {
    resetLocalIDs();
    const { kernel, session } = await withPlugins(
      { "@test/stalled": stalledPlugin("post") },
      { files: { "note.txt": "background receipt" } },
    );
    const callback = suspendPluginMutation(kernel, "read");
    const earlier = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`earlier` });
    session.root.head = earlier;
    await when(() => completionsOf(earlier).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => earlier.reducerExited, { timeout: TIMEOUT });
    const turn = new SessionTurn({ turnTail: earlier, prompt: prompt.user`read in background` });
    session.root.head = turn;
    await when(() => completionsOf(turn).length === 1, { timeout: TIMEOUT });
    modelOf(session).reply({ calls: [responseCall("background-read", "read_file", '{"path":"note.txt"}')] });
    await callback.entered;
    const job = reactChunks(turn).find((chunk): chunk is ToolCallJob => chunk instanceof ToolCallJob)!;
    job.background = true;
    await when(() => completionsOf(turn).length === 2, { timeout: TIMEOUT });
    modelOf(session).reply({ text: "done" });
    await when(() => turn.reducerExited, { timeout: TIMEOUT });
    const overlay = new SessionTurn({ turnTail: turn, queue: [], reducerExited: true });
    session.root.head = overlay;
    expect({
      scheduled: session.root.work.includes(job),
      completed: job.completed,
      parentClosed: turn.reducerExited,
    }).toEqual({ scheduled: true, completed: false, parentClosed: true });
    if (ending === "rewind") {
      await session.handleRequest("turn/rewind", { turnId: earlier.uuid });
      await when(() => job.completed, { timeout: TIMEOUT });
    }
    callback.release();
    await callback.returned;
    await when(() => job.completed, { timeout: TIMEOUT });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const ownerId = kernel.behavior.directory.ownerId("stalled", "session", "s1", "state");
    expect({
      receipt: JSON.parse(job.receiptJson ?? ""),
      log: kernel.behavior.directory.get(ownerId).log.map(toJS),
      notes: latePluginNotes(kernel),
      problem: session.root.pluginProblem,
      head: session.root.head.uuid,
    }).toEqual({
      receipt: { ok: true, text: expect.stringContaining("background receipt") },
      log: ending === "settle" ? ["mark"] : [],
      notes: ending === "settle" ? ["late plugin note"] : [],
      problem: null,
      head: ending === "settle" ? overlay.uuid : earlier.uuid,
    });
  },
  15_000,
);
