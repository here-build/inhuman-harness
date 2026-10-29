import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  callDeclaredTool,
  callMethod,
  CallerLedger,
  Dict,
  dispatchBoundary,
  projectionOf,
  hostPropose,
  loadProgram,
  NoteLog,
  parseBehaviorBlock,
  pinSources,
  Refusal,
  resolvePackageSurface,
  StateDirectory,
  toJS,
  type BoundReceiver,
} from "../index.js";
import type { BehaviorSelection } from "../manifest.js";
import { botDefinitionSchema } from "../schemas/bot-definition.js";
import { pluginManifestSchema, pluginStateSchema } from "../schemas/plugin-manifest.js";
import { PluginSurfaceError } from "../surface-error.js";
import { Proc, type ReducerDecl, type Registry, type Val } from "../value.js";
import { modelCatalog } from "./model-catalog.js";

const OPEN_PAGE_NOTE = "This page is still open. Validate, drop, or keep working — not a new user turn.";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, "../../../../../plugins/inhuman-plugin-tasks");
const GOAL = join(HERE, "../../../../../plugins/inhuman-plugin-goal");
const OFFLOAD = join(HERE, "../../../../../plugins/inhuman-plugin-offload-tingle");
const FUSION = join(HERE, "../../../../../plugins/inhuman-plugin-fusion");
const EXAM = "read_file tasks/write-completion-verdict";
function writePkg(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-surface-"));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}
async function loadBehavior(
  source: string,
  extra?: {
    readonly agentId?: string;
    readonly root?: string;
    readonly filename?: string;
    readonly config?: Record<string, unknown>;
    readonly environment?: ReadonlyMap<string, Proc>;
    readonly kind?: "behavior" | "state";
    readonly read?: (path: string) => string;
  },
): Promise<Registry> {
  const root = extra?.root ?? "/pkg";
  return loadProgram({
    agentId: extra?.agentId ?? "agent",
    source,
    filename: extra?.filename ?? join(root, "behavior.scm"),
    revision: "rev",
    root,
    read:
      extra?.read ??
      (() => {
        throw new Error("missing source");
      }),
    kind: extra?.kind ?? "behavior",
    config: extra?.config,
    environment: extra?.environment,
  });
}
function reducerOf(registry: Registry): ReducerDecl {
  if (registry.reducer == null) throw new Error("missing reducer");
  return registry.reducer;
}
function bind(ownerId: string, abi: string, methods: readonly string[]): BoundReceiver {
  return { alias: ownerId, ownerId, methods: new Set(methods), abi };
}
describe("manifest and consent", () => {
  it("resolves the design's bot frontmatter, state files, and mcp records", async () => {
    const root = writePkg({
      "plugin.json": JSON.stringify({
        extensions: {
          "tools.inhuman": {
            bots: ["./bots/examiner.prompt"],
            skills: ["./skills/examine"],
            states: { session: "./states/session.scm" },
            mcp: [{ name: "memory" }, { name: "shared", visibility: "public" }],
          },
        },
      }),
      "bots/examiner.prompt": `---
mode: instruct
tools: [read_file, grep, glob, list_dir]
behavior:
  program: ../behaviors/examiner/plugin.scm
  environment: ../behaviors/examiner/environment.ts
  configuration:
    requireVerdict: true
  bindings:
    offload:
      plugin: example
      scope: project
      methods: [get-memory, search-memory]
---
Examine the tree and report a grounded verdict.
`,
      "behaviors/examiner/plugin.scm": ";; examiner\n",
      "behaviors/examiner/environment.ts": "export {}\n",
      "states/session.scm": ";; state\n",
      "skills/examine": "skill\n",
    });
    const surface = resolvePackageSurface(root);
    const behavior = surface.bots[0]?.behavior;
    expect(behavior?.program.endsWith("behaviors/examiner/plugin.scm")).toBe(true);
    expect(behavior?.configuration).toEqual({ requireVerdict: true });
    expect(behavior?.bindings?.offload).toEqual({
      plugin: "example",
      scope: "project",
      methods: ["get-memory", "search-memory"],
    });
    expect(surface.states.map((row) => row.scope)).toEqual(["session"]);
    expect(surface.mcp).toEqual([
      { name: "memory", visibility: "private" },
      { name: "shared", visibility: "public" },
    ]);
    expect(surface.bots).toHaveLength(1);
    const loaded = await loadBehavior(behavior?.programSource ?? "", {
      root,
      filename: behavior?.programPath,
      config: behavior?.configuration,
    });
    expect(loaded.tools.size).toBe(0);
  });
  it("parses an old manifest, a states-only pack, and a bot without behavior", () => {
    const oldRoot = writePkg({
      "plugin.json": JSON.stringify({
        name: "unbranded",
        extensions: {
          "tools.inhuman": {
            plugins: [{ name: "unbranded", description: "bag", importPath: "./mod.js" }],
            commands: {
              goal: { description: "goal", importPath: "./goal.scm" },
            },
            notifyingHooks: [
              {
                type: "scheme",
                phase: "post",
                kind: "turn",
                path: "./hooks.scm",
              },
            ],
          },
        },
      }),
    });
    const parsed = pluginManifestSchema.parse(JSON.parse(readFileSync(join(oldRoot, "plugin.json"), "utf8")));
    const extension = parsed.extensions["tools.inhuman"];
    expect(extension.plugins).toEqual([{ importPath: "./mod.js" }]);
    expect(extension.commands.goal?.importPath).toBe("./goal.scm");
    expect(Object.hasOwn(extension, "notifyingHooks")).toBe(false);
    expect(resolvePackageSurface(oldRoot).bots).toEqual([]);
    const statesOnly = writePkg({
      "plugin.json": JSON.stringify({
        extensions: {
          "tools.inhuman": { states: { project: "./memory.scm" } },
        },
      }),
      "memory.scm": ";; memory\n",
    });
    const states = resolvePackageSurface(statesOnly);
    expect(states.bots).toEqual([]);
    expect(states.states).toHaveLength(1);
    expect(states.states[0]?.scope).toBe("project");
    const plain = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { bots: ["./plain.prompt"] } },
      }),
      "plain.prompt": "---\nmode: instruct\n---\nHello\n",
    });
    expect(resolvePackageSurface(plain).bots[0]?.behavior).toBeNull();
  });
  it("rejects escape, missing files, bad behavior, unknown scopes, and template replacement", () => {
    const root = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { bots: ["../outside.prompt"] } },
      }),
    });
    expect(() => resolvePackageSurface(root)).toThrow(/package escape/);
    const missing = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { bots: ["./missing.prompt"] } },
      }),
    });
    expect(() => resolvePackageSurface(missing)).toThrow(/missing source/);
    const badSkill = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { skills: ["./nope"] } },
      }),
    });
    expect(() => resolvePackageSurface(badSkill)).toThrow(/missing source/);
    const badBehavior = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { bots: ["./bot.prompt"] } },
      }),
      "bot.prompt": "---\nbehavior:\n  configuration:\n    a: 1\n---\n",
    });
    expect(() => resolvePackageSurface(badBehavior)).toThrow(/invalid behavior configuration/);
    expect(() => pluginStateSchema.parse({ workspace: "./x.scm" })).toThrow();
    const badScope = writePkg({
      "plugin.json": JSON.stringify({
        extensions: { "tools.inhuman": { states: { workspace: "./x.scm" } } },
      }),
      "x.scm": ";; x\n",
    });
    expect(() => resolvePackageSurface(badScope)).toThrow();
    expect(() =>
      botDefinitionSchema.parse({
        behavior: {
          program: "./a.scm",
          bindings: {
            tasks: { plugin: "tasks", scope: "nope", methods: ["incomplete"] },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseBehaviorBlock({
        program: "./a.scm",
        bindings: { tasks: { plugin: "tasks", scope: "session", methods: [] } },
      }),
    ).toThrow(/invalid behavior configuration/);
    const selection = parseBehaviorBlock({
      program: "./a.scm",
      bindings: {
        tasks: { plugin: "tasks", scope: "session", methods: ["incomplete"] },
      },
    });
    if (selection == null) throw new Error("selection");
    expect(() => sealBehaviorAgainstTemplate(selection, { program: "./other.scm" })).toThrow(
      /template inputs cannot replace/,
    );
    expect(sealBehaviorAgainstTemplate(selection, { temperature: 1 }).program).toBe("./a.scm");
    expect(botDefinitionSchema.parse({ behavior: { program: "./a.scm" } }).behavior?.program).toBe("./a.scm");
  });
});
describe("registration and pins", () => {
  it("gates exposure, keywords, depth, and the two interception kinds", async () => {
    const tool = await loadBehavior(`
      (define/tool 'shown :description "Shown" :expose 'tool :input (s/object) :handler (lambda (input) input))
      (define/tool 'local :expose 'procedure :input (s/object (s/field "q" (s/string))) :handler (lambda (input) input))
      (define/tool 'both-tool :description "Both" :expose 'both :input (s/object) :handler (lambda (input) input))
    `);
    expect(modelCatalog(tool).map((row) => row.name)).toEqual(["shown", "both-tool"]);
    expect(tool.tools.get("local")?.expose).toBe("procedure");
    expect(tool.tools.get("shown")?.question).toBe(null);
    await expect(
      async () =>
        await loadBehavior(`(define/tool 't :expose 'procedure :question "" :handler (lambda (input) input))`),
    ).rejects.toThrow(/non-empty/);
    await expect(
      async () => await loadBehavior(`(define/tool 'bare :expose 'tool :handler (lambda (input) input))`),
    ).rejects.toThrow(/exposed tool requires/);
    await expect(
      async () =>
        await loadBehavior(`(define/tool 'bare :description "d" :expose 'both :handler (lambda (input) input))`),
    ).rejects.toThrow(/exposed tool requires/);
    await expect(
      async () => await loadBehavior(`(define/tool 'bare :expose 'procedure :input 1 :handler (lambda (input) input))`),
    ).rejects.toThrow(/:input must be a schema/);
    await expect(
      async () => await loadBehavior(`(define/tool 't :expose 'procedure :handler (lambda (input) JSON.parse))`),
    ).rejects.toThrow(/JSON.parse/);
  });
  it("isolates two agents and pins the loaded module", async () => {
    const root = writePkg({
      "a.scm": `(define/tool 't :expose 'procedure :handler (lambda (input) input))\n`,
    });
    const required = await loadBehavior(readFileSync(join(root, "a.scm"), "utf8"), {
      root,
      filename: join(root, "a.scm"),
      read: (path) => readFileSync(path, "utf8"),
    });
    expect([...required.tools.keys()]).toEqual(["t"]);
    await expect(
      async () =>
        await loadBehavior(`
        (define/tool 't :expose 'procedure :handler (lambda (input) input))
        (define/tool 't :expose 'procedure :handler (lambda (input) input))
      `),
    ).rejects.toThrow(/duplicate tool/);
    const source = `(define/tool 't :expose 'procedure :handler (lambda (input) (:name configuration)))`;
    const left = await loadBehavior(source, {
      agentId: "left",
      config: { name: "left" },
    });
    const right = await loadBehavior(source, {
      agentId: "right",
      config: { name: "right" },
    });
    left.tools.delete("t");
    expect(right.tools.has("t")).toBe(true);
    expect(left.config.entries.name).toBe("left");
    expect(right.config.entries.name).toBe("right");
    const pin = pinSources("example", join(root, "a.scm"), required.loaded, { requireVerdict: true }, {});
    expect(pin.modules.map((row) => row.path)).toEqual([...required.loaded.keys()]);
    expect(pin.modules).toHaveLength(1);
    expect(
      pinSources(
        "example",
        join(root, "a.scm"),
        new Map([...required.loaded].map(([path]) => [path, `${path} edited`])),
        {},
        {},
      ).revision,
    ).not.toBe(pin.revision);
    expect(() => pinSources("example", "a.scm", new Map([["a.scm", "   "]]), {}, {})).toThrow(
      /pinned source unavailable/,
    );
  });
  it("rejects callback registration and loads state methods without a model tool", async () => {
    const outer = await loadBehavior(`
      (define/tool 'outer :description "d" :expose 'tool :input (s/object)
        :handler (lambda (input) (define/tool 'inner :expose 'procedure :handler (lambda (x) x))))
    `);
    await expect(async () => await callDeclaredTool(outer, "outer", new Dict({}))).rejects.toThrow(
      /callback-time registration/,
    );
    const session = await loadBehavior(readFileSync(join(TASKS, "behavior/session.scm"), "utf8"), {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/session.scm"),
    });
    expect(modelCatalog(session)).toEqual([]);
    expect([...session.methods.keys()]).toEqual([
      "incomplete",
      "create",
      "page",
      "start",
      "stamp",
      "drop",
      "after",
      "verdict",
      "validate",
    ]);
    expect(session.tools.size).toBe(0);
    await expect(
      async () =>
        await loadBehavior(`(define/tool 't :expose 'procedure :handler (lambda (input) input))`, { kind: "state" }),
    ).rejects.toThrow(/state module cannot register/);
    await expect(
      async () =>
        await loadBehavior(
          `
        (define/reducer :initial (lambda () #f) :reduce (lambda (state action) state))
        (define/method 'go :kind 'effect :input (s/object) :output (s/boolean) :handler (lambda (input state) state))
      `,
          { kind: "state" },
        ),
    ).rejects.toThrow(/method :kind/);
    await expect(
      async () =>
        await loadBehavior(
          `
        (define/reducer :initial (lambda () #f) :reduce (lambda (state action) state))
        (define/method 'go :kind 'query :input (s/object) :output (s/boolean) :handler (lambda (input state) state))
        (define/method 'go :kind 'query :input (s/object) :output (s/boolean) :handler (lambda (input state) state))
      `,
          { kind: "state" },
        ),
    ).rejects.toThrow(/duplicate method/);
    await expect(
      async () =>
        await loadBehavior(
          `
        (define/reducer :initial (lambda () #f) :reduce (lambda (state action) state))
        (define/reducer :initial (lambda () #f) :reduce (lambda (state action) state))
      `,
          { kind: "state" },
        ),
    ).rejects.toThrow(/multiple reducers/);
    const surface = resolvePackageSurface(OFFLOAD);
    const writer = surface.bots.find((bot) => bot.path.endsWith("writer.prompt"))?.behavior;
    const scout = surface.bots.find((bot) => bot.path.endsWith("scout.prompt"))?.behavior;
    if (writer == null || scout == null) throw new Error("offload bots");
    const writerRegistry = await loadBehavior(writer.programSource, {
      filename: writer.programPath,
      root: OFFLOAD,
    });
    expect(writerRegistry.tools.has("offload")).toBe(true);
    expect(writerRegistry.tools.has("tingle")).toBe(false);
    expect(
      modelCatalog(
        await loadBehavior(scout.programSource, {
          filename: scout.programPath,
          root: OFFLOAD,
        }),
      ).map((row) => row.name),
    ).toEqual(["tingle"]);
  });
  it("keeps an existing pin and rejects a forged render", async () => {
    const authored = JSON.stringify({ program: "./foreground.scm" });
    const existing = JSON.stringify({ program: "./old.scm" });
    expect(initialBehaviorPin("", authored)).toBe(authored);
    expect(initialBehaviorPin(existing, authored)).toBe(existing);
    expect(behaviorFromRender("./trusted.scm", "")).toBe("./trusted.scm");
    expect(behaviorFromRender("./trusted.scm", "./trusted.scm")).toBe("./trusted.scm");
    expect(() => behaviorFromRender("./trusted.scm", "./forged.scm")).toThrow(/forged render bundle/);
    const parent = await loadBehavior(`(define/tool 'parent-only :expose 'procedure :handler (lambda (input) input))`, {
      agentId: "parent",
    });
    const child = await loadBehavior(`(define/tool 'child-only :expose 'procedure :handler (lambda (input) input))`, {
      agentId: "child",
    });
    expect(child.tools.has("parent-only")).toBe(false);
    expect(parent.tools.has("child-only")).toBe(false);
  });
});
describe("scoped state", () => {
  it("serves a states-only method, isolates grants, and replays reads without rewriting", async () => {
    const directory = new StateDirectory();
    const memory = await loadBehavior(readFileSync(join(OFFLOAD, "behavior/project.scm"), "utf8"), {
      kind: "state",
      root: OFFLOAD,
      filename: join(OFFLOAD, "behavior/project.scm"),
    });
    const projectA = directory.open(
      directory.ownerId("offload", "project", "proj-a", "memory"),
      "project",
      "abi",
      reducerOf(memory),
      memory.methods,
    );
    const projectB = directory.open(
      directory.ownerId("offload", "project", "proj-b", "memory"),
      "project",
      "abi",
      reducerOf(memory),
      memory.methods,
    );
    const global = directory.open(
      directory.ownerId("offload", "global", "kernel", "memory"),
      "global",
      "abi",
      reducerOf(memory),
      memory.methods,
    );
    const writer = new CallerLedger();
    const scout = new CallerLedger();
    const writerBindings = new Map([
      ["offload", bind(projectA.id, projectA.abi, ["get-memory", "put-memory", "search"])],
    ]);
    const scoutBindings = new Map([["offload", bind(projectA.id, projectA.abi, ["get-memory", "search"])]]);
    const globalBindings = new Map([["global-offload", bind(global.id, global.abi, ["get-memory", "put-memory"])]]);
    expect(modelCatalog(memory)).toEqual([]);
    const refused = await callMethod({
      directory,
      caller: writer,
      bindings: writerBindings,
      receiver: "offload",
      method: "put-memory",
      args: { text: "fact", citation: "" },
      callId: "cite",
    });
    expect(refused).toBeInstanceOf(Refusal);
    expect(projectA.log).toHaveLength(0);
    expect(
      await callMethod({
        directory,
        caller: writer,
        bindings: writerBindings,
        receiver: "offload",
        method: "put-memory",
        args: { text: "fact", citation: "a.ts" },
        callId: "put-1",
      }),
    ).toBe("fact");
    expect(
      await callMethod({
        directory,
        caller: writer,
        bindings: writerBindings,
        receiver: "offload",
        method: "put-memory",
        args: { text: "fact", citation: "a.ts" },
        callId: "put-1",
      }),
    ).toBe("fact");
    expect(projectA.log).toHaveLength(1);
    await expect(
      async () =>
        await callMethod({
          directory,
          caller: writer,
          bindings: writerBindings,
          receiver: "offload",
          method: "put-memory",
          args: { text: "other", citation: "b.ts" },
          callId: "put-1",
        }),
    ).rejects.toThrow(/call id reuse/);
    await expect(
      async () =>
        await callMethod({
          directory,
          caller: scout,
          bindings: scoutBindings,
          receiver: "offload",
          method: "put-memory",
          args: { text: "nope", citation: "c.ts" },
          callId: "scout-put",
        }),
    ).rejects.toThrow(/method not granted/);
    expect(
      await callMethod({
        directory,
        caller: scout,
        bindings: scoutBindings,
        receiver: "offload",
        method: "get-memory",
        args: {},
        callId: "read-1",
      }),
    ).toBe("fact");
    expect(
      await callMethod({
        directory,
        caller: writer,
        bindings: writerBindings,
        receiver: "offload",
        method: "put-memory",
        args: { text: "newer", citation: "d.ts" },
        callId: "put-2",
      }),
    ).toBe("newer");
    expect(
      await callMethod({
        directory,
        caller: scout,
        bindings: scoutBindings,
        receiver: "offload",
        method: "get-memory",
        args: {},
        callId: "read-1",
      }),
    ).toBe("fact");
    await expect(
      async () =>
        await callMethod({
          directory,
          caller: writer,
          bindings: writerBindings,
          receiver: "offload",
          method: "put-memory",
          args: { text: "stale", citation: "e.ts" },
          callId: "stale",
          observedRevision: 0,
        }),
    ).rejects.toThrow(/stale commit/);
    expect(projectA.log).toHaveLength(2);
    const parallel = new CallerLedger();
    expect(
      await callMethod({
        directory,
        caller: parallel,
        bindings: new Map([["offload", bind(projectB.id, projectB.abi, ["put-memory", "get-memory", "search"])]]),
        receiver: "offload",
        method: "put-memory",
        args: { text: "bee", citation: "b.ts" },
        callId: "b",
      }),
    ).toBe("bee");
    expect(toJS(await projectionOf(projectA))).toMatchObject({
      body: "newer",
      revision: 2,
    });
    expect(toJS(await projectionOf(projectB))).toMatchObject({
      body: "bee",
      revision: 1,
    });
    expect(
      await callMethod({
        directory,
        caller: writer,
        bindings: globalBindings,
        receiver: "global-offload",
        method: "get-memory",
        args: {},
        callId: "global-read",
      }),
    ).toBe("");
    const long = "x".repeat(801);
    await callMethod({
      directory,
      caller: writer,
      bindings: writerBindings,
      receiver: "offload",
      method: "put-memory",
      args: { text: long, citation: "long.ts" },
      callId: "long",
    });
    expect(
      await callMethod({
        directory,
        caller: scout,
        bindings: scoutBindings,
        receiver: "offload",
        method: "search",
        args: { query: "x" },
        callId: "search-long",
      }),
    ).toBe("");
    const restarted = directory.restart(projectA.id);
    expect(toJS(await projectionOf(restarted))).toMatchObject({ body: long });
    expect(() => directory.rollback(projectA.id, 0)).toThrow(/does not undo accepted project/);
    const notes = new NoteLog();
    expect(notes.notes).toHaveLength(0);
  });
  it("rolls session and private logs back, seals verdicts, and keeps the bound session id", async () => {
    const directory = new StateDirectory();
    const sessionSource = readFileSync(join(TASKS, "behavior/session.scm"), "utf8");
    const projectSource = readFileSync(join(TASKS, "behavior/project.scm"), "utf8");
    const sessionRegistry = await loadBehavior(sessionSource, {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/session.scm"),
    });
    const projectRegistry = await loadBehavior(projectSource, {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/project.scm"),
    });
    const sessionId = "conversation";
    const session = directory.open(
      directory.ownerId("tasks", "session", sessionId, "notebook"),
      "session",
      "tasks-abi",
      reducerOf(sessionRegistry),
      sessionRegistry.methods,
    );
    const otherHelper = directory.open(
      directory.ownerId("tasks", "session", "helper-runtime", "notebook"),
      "session",
      "tasks-abi",
      reducerOf(sessionRegistry),
      sessionRegistry.methods,
    );
    const project = directory.open(
      directory.ownerId("tasks", "project", "proj", "promotion"),
      "project",
      "tasks-abi",
      reducerOf(projectRegistry),
      projectRegistry.methods,
    );
    const caller = new CallerLedger();
    const sessionBindings = new Map([
      ["tasks", bind(session.id, session.abi, ["incomplete", "create", "start", "stamp"])],
    ]);
    const projectBindings = new Map([
      ["project-tasks", bind(project.id, project.abi, ["accept", "accepted", "complete"])],
    ]);
    expect(
      await callMethod({
        directory,
        caller,
        bindings: sessionBindings,
        receiver: "tasks",
        method: "create",
        args: { "task-id": "t1", program: "" },
        callId: "empty-program",
      }),
    ).toEqual(new Refusal("task__create did not save the exam lambda"));
    expect(
      await callMethod({
        directory,
        caller,
        bindings: sessionBindings,
        receiver: "tasks",
        method: "create",
        args: { "task-id": "t1", program: EXAM, subject: "ship it" },
        callId: "create",
      }),
    ).toBe("t1");
    expect(
      toJS(
        await callMethod({
          directory,
          caller,
          bindings: sessionBindings,
          receiver: "tasks",
          method: "incomplete",
          args: {},
          callId: "pending",
        }),
      ),
    ).toEqual({ open: false, text: "t1 ship it" });
    expect(
      await callMethod({
        directory,
        caller,
        bindings: projectBindings,
        receiver: "project-tasks",
        method: "accept",
        args: { "task-id": "t1" },
        callId: "accept-1",
      }),
    ).toBe("t1");
    expect(
      await callMethod({
        directory,
        caller,
        bindings: projectBindings,
        receiver: "project-tasks",
        method: "accept",
        args: { "task-id": "t1" },
        callId: "accept-1",
      }),
    ).toBe("t1");
    expect(project.log).toHaveLength(1);
    expect(toJS(await projectionOf(project))).toEqual({
      accepted: "t1",
      done: false,
    });
    expect(
      await callMethod({
        directory,
        caller,
        bindings: sessionBindings,
        receiver: "tasks",
        method: "stamp",
        args: { "task-id": "t1", ok: true },
        callId: "stamp-pending",
        hostAuthority: true,
      }),
    ).toBeInstanceOf(Refusal);
    expect(toJS(await projectionOf(session))).toMatchObject({
      active: false,
      pending: 1,
    });
    await callMethod({
      directory,
      caller,
      bindings: sessionBindings,
      receiver: "tasks",
      method: "start",
      args: { "task-id": "t1" },
      callId: "start",
    });
    await expect(
      async () =>
        await callMethod({
          directory,
          caller,
          bindings: sessionBindings,
          receiver: "tasks",
          method: "stamp",
          args: { "task-id": "t1", ok: true },
          callId: "stamp-plugin",
        }),
    ).rejects.toThrow(/protected action/);
    expect(
      await callMethod({
        directory,
        caller,
        bindings: sessionBindings,
        receiver: "tasks",
        method: "stamp",
        args: { "task-id": "t1", ok: true },
        callId: "stamp-host",
        hostAuthority: true,
      }),
    ).toBe("stamped");
    expect(toJS(await projectionOf(session))).toMatchObject({
      active: false,
      pending: 0,
      pages: [{ id: "t1", status: "completed" }],
    });
    expect(
      await callMethod({
        directory,
        caller,
        bindings: sessionBindings,
        receiver: "tasks",
        method: "stamp",
        args: { "task-id": "t1", ok: false },
        callId: "stamp-again",
        hostAuthority: true,
      }),
    ).toBeInstanceOf(Refusal);
    expect(toJS(await projectionOf(session))).toMatchObject({
      pages: [{ id: "t1", status: "completed" }],
    });
    directory.rollback(session.id, 0);
    expect(toJS(await projectionOf(session))).toMatchObject({
      pending: 0,
      pages: [],
    });
    expect(toJS(await projectionOf(project))).toEqual({
      accepted: "t1",
      done: false,
    });
    expect(
      await callMethod({
        directory,
        caller,
        bindings: projectBindings,
        receiver: "project-tasks",
        method: "complete",
        args: {},
        callId: "complete",
      }),
    ).toBe("done");
    expect(toJS(await projectionOf(project))).toEqual({
      accepted: "t1",
      done: true,
    });
    expect(otherHelper.log).toHaveLength(0);
    const privateRegistry = await loadBehavior(
      `
      (define/reducer :initial (lambda () (dict :n 0)) :reduce (lambda (state action) (dict :n (+ (:n state) 1))))
      (define/method 'inc :kind 'command :input (s/object) :output (s/number)
        :handler (lambda (input state) (begin (state/propose (dict :type "inc")) (:n state))))
      (define/method 'peek :kind 'query :input (s/object) :output (s/object (s/field "n" (s/number)))
        :handler (lambda (input state) (begin (state/propose (dict :type "no")) state)))
    `,
      { kind: "state" },
    );
    const pocket = directory.open("pocket", "private", "abi", reducerOf(privateRegistry), privateRegistry.methods);
    const pocketBindings = new Map([["pocket", bind(pocket.id, pocket.abi, ["inc", "peek"])]]);
    await expect(
      async () =>
        await callMethod({
          directory,
          caller,
          bindings: pocketBindings,
          receiver: "pocket",
          method: "peek",
          args: {},
          callId: "peek",
        }),
    ).rejects.toThrow(/reducer cannot propose/);
    expect(pocket.log).toHaveLength(0);
    await callMethod({
      directory,
      caller,
      bindings: pocketBindings,
      receiver: "pocket",
      method: "inc",
      args: {},
      callId: "inc",
    });
    directory.rollback(pocket.id, 0);
    expect(pocket.log).toHaveLength(0);
    expect(project.log.length).toBeGreaterThan(0);
    const replaced = directory.open(project.id, "project", "abi-next", reducerOf(await memoryStandIn()), new Map());
    expect(replaced.abi).toBe(project.abi);
    await expect(
      callMethod({
        directory,
        caller,
        bindings: new Map([["project-tasks", bind(project.id, "abi-next", ["accepted"])]]),
        receiver: "project-tasks",
        method: "accepted",
        args: {},
        callId: "stale-abi",
      }),
    ).rejects.toThrow(/revision mismatch/);
    expect(() => reducerForReplay("old", "new", false)).toThrow(/migration or reset/);
    expect(reducerForReplay("old", "new", true)).toBe("new");
    expect(
      reattune({
        activeTurn: true,
        outstanding: [],
        current: "old-pin",
        next: "new-pin",
      }).active,
    ).toBe("old-pin");
    expect(
      reattune({
        activeTurn: false,
        outstanding: ["job"],
        current: "old-pin",
        next: "new-pin",
      }).outstanding,
    ).toBe("old-pin");
    expect(
      reattune({
        activeTurn: false,
        outstanding: [],
        current: "old-pin",
        next: "new-pin",
      }).active,
    ).toBe("new-pin");
  });
});
async function memoryStandIn(): Promise<Registry> {
  return await loadBehavior(
    `
    (define/reducer :initial (lambda () (dict :n 0)) :reduce (lambda (state action) state))
    (define/method 'noop :kind 'query :input (s/object) :output (s/object (s/field "n" (s/number))) :handler (lambda (input state) state))
  `,
    { kind: "state" },
  );
}
describe("notifications", () => {
  it("records only for round-end activation and drops unused notes", async () => {
    const registry = await loadBehavior(`
      (hook/round :post (lambda (round) (self/notify 'activating "open")))
      (hook/round :pre (lambda (round) (self/notify 'activating "early")))
    `);
    const notes = new NoteLog();
    const end = await dispatchBoundary({
      registry,
      point: "round",
      record: "round",
      notes,
      turnId: "t1",
    });
    expect(notes.peek("agent").map((note) => [note.text])).toEqual([["early"], ["open"]]);
    expect(end.originAtoms).toEqual([]);
    const ambient = await loadBehavior(`(hook/round :post (lambda (round) (self/notify 'ambient "pending")))`);
    const ambientNotes = new NoteLog();
    const ambientEnd = await dispatchBoundary({
      registry: ambient,
      point: "round",
      record: "round",
      notes: ambientNotes,
      turnId: "t1",
    });
    expect(ambientNotes.peek("agent").map((note) => note.text)).toEqual(["pending"]);
    expect(ambientEnd.originAtoms).toEqual([]);
    const quiet = await loadBehavior(`(hook/round :post (lambda (round) #f))`);
    const quietNotes = new NoteLog();
    await dispatchBoundary({
      registry: quiet,
      point: "round",
      record: "round",
      notes: quietNotes,
      turnId: "t1",
    });
    expect(quietNotes.peek("agent")).toEqual([]);
    const empty = await loadBehavior(`(hook/round :post (lambda (round) (self/notify 'activating "")))`);
    expect(
      (
        await dispatchBoundary({
          registry: empty,
          point: "round",
          record: "round",
          notes: new NoteLog(),
          turnId: "t1",
        })
      ).hookFailures.join(" "),
    ).toMatch(/activating requires a message/);
    const origin = await loadBehavior(`(hook/round :post (lambda (round) (self/notify "kept")))`);
    const originNotes = new NoteLog();
    const originEnd = await dispatchBoundary({
      registry: origin,
      point: "round",
      record: "round",
      notes: originNotes,
      turnId: "t1",
    });
    expect(originEnd.originAtoms).toEqual(["kept"]);
    expect(originNotes.peek("agent")).toEqual([]);
    const canceled = await dispatchBoundary({
      registry,
      point: "round",
      record: "round",
      notes: new NoteLog(),
      turnId: "t1",
      cancelled: true,
    });
    expect(canceled.hookFailures.join(" ")).toMatch(/canceled work is not reactivated/);
    notes.consume(
      "agent",
      notes.peek("agent").flatMap((note) => (note.id == null ? [] : [note.id])),
      "placed",
    );
    expect(() => notes.consume("agent", ["note-1"], "again")).toThrow(/consumed twice/);
    const expiring = new NoteLog();
    expiring.emit({
      agentId: "agent",
      mode: "activating",
      boundary: "round-end",
      message: "open",
      turnId: "t1",
    });
    expiring.expireUnused("agent", "t1");
    expect(expiring.peek("agent")).toEqual([]);
    const worker = new NoteLog();
    worker.emit({
      agentId: "worker",
      mode: "activating",
      boundary: "round-end",
      message: "child",
      turnId: "t1",
    });
    expect(worker.peek("parent")).toEqual([]);
    const sharedA = await loadBehavior(`(hook/round :post (lambda (round) (self/notify 'activating "a")))`, {
      agentId: "a",
    });
    const sharedB = await loadBehavior(`(hook/round :post (lambda (round) (self/notify 'activating "b")))`, {
      agentId: "b",
    });
    const shared = new NoteLog();
    await dispatchBoundary({
      registry: sharedA,
      point: "round",
      record: "round",
      notes: shared,
      turnId: "t1",
    });
    expect(shared.peek("b")).toEqual([]);
    await dispatchBoundary({
      registry: sharedB,
      point: "round",
      record: "round",
      notes: shared,
      turnId: "t1",
    });
    expect(shared.peek("a").some((note) => note.text !== "")).toBe(true);
    expect(shared.peek("b").some((note) => note.text !== "")).toBe(true);
  });
  it("gives methods no notify destination and lets a hook notify the method result", async () => {
    const directory = new StateDirectory();
    const registry = await loadBehavior(
      `
      (define/reducer :initial (lambda () (dict :body "")) :reduce (lambda (state action) (dict :body (:text action))))
      (define/method 'get-memory :kind 'query :input (s/object) :output (s/string) :handler (lambda (input state) (:body state)))
      (define/method 'put :kind 'command :input (s/object (s/field "text" (s/string))) :output (s/string)
        :handler (lambda (input state) (begin (state/propose (dict :type "put" :text (:text input))) (:text input))))
      (define/method 'wake :kind 'command :input (s/object) :output (s/object (s/field "body" (s/string)))
        :handler (lambda (input state) (begin (self/notify 'ambient "no") state)))
    `,
      { kind: "state" },
    );
    const owner = directory.open("mem", "project", "abi", reducerOf(registry), registry.methods);
    const caller = new CallerLedger();
    const bindings = new Map([["mem", bind(owner.id, owner.abi, ["get-memory", "put", "wake"])]]);
    await expect(
      async () =>
        await callMethod({
          directory,
          caller,
          bindings,
          receiver: "mem",
          method: "wake",
          args: {},
          callId: "wake",
        }),
    ).rejects.toThrow(/no notification destination/);
    expect(owner.log).toHaveLength(0);
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "mem",
      method: "put",
      args: { text: "fact" },
      callId: "put",
    });
    const notes = new NoteLog();
    expect(notes.notes).toHaveLength(0);
    const hook = await loadBehavior(
      `(hook/round :post (lambda (round) (self/notify 'activating (call/method 'mem 'get-memory))))`,
    );
    let seq = 0;
    await dispatchBoundary({
      registry: hook,
      point: "round",
      record: "round",
      notes,
      turnId: "t1",
      onMethod: async (receiver, method, kw) =>
        await callMethod({
          directory,
          caller,
          bindings,
          receiver,
          method,
          args: Object.fromEntries(kw),
          callId: `hook-${seq}`,
        }),
    });
    seq += 1;
    expect(notes.peek("agent")[0]?.text).toBe("fact");
  });
});
describe("notes and branch context", () => {
  it("consumes a note once and lets a round hook follow the branch decision", async () => {
    const notes = new NoteLog();
    const recorded = notes.emit({
      agentId: "agent",
      mode: "activating",
      boundary: "round-end",
      message: "open",
      turnId: "t1",
    });
    notes.consume("agent", [recorded.id], "placed");
    const hydrated = new NoteLog();
    hydrated.adopt(recorded);
    hydrated.adopt(recorded);
    expect(hydrated.notes).toHaveLength(1);
    expect(() => hydrated.consume("agent", [recorded.id], "again")).toThrow(/consumed twice/);
    expect(
      branchContextDecision({
        previousBranch: "main",
        nextBranch: "topic",
        freshContext: false,
      }),
    ).toBe("ambient");
    expect(
      branchContextDecision({
        previousBranch: "main",
        nextBranch: "main",
        freshContext: true,
      }),
    ).toBe("ambient");
    expect(
      branchContextDecision({
        previousBranch: "main",
        nextBranch: "main",
        freshContext: false,
      }),
    ).toBe("quiet");
    let decision = "quiet";
    const branch = await loadBehavior(
      `(hook/round :post (lambda (round) (if (equal? (branch-decision) "ambient") (self/notify 'ambient "branch") #f)))`,
      {
        environment: new Map([["branch-decision", new Proc("branch-decision", () => decision)]]),
      },
    );
    const branchNotes = new NoteLog();
    await dispatchBoundary({
      registry: branch,
      point: "round",
      record: "round",
      notes: branchNotes,
      turnId: "t1",
    });
    expect(branchNotes.peek("agent")).toEqual([]);
    decision = "ambient";
    await dispatchBoundary({
      registry: branch,
      point: "round",
      record: "round",
      notes: branchNotes,
      turnId: "t2",
    });
    expect(branchNotes.peek("agent").map((note) => note.text)).toEqual(["branch"]);
  });
});
describe("tasks, offload, and goal", () => {
  it("recites an open page, keeps pending ambient, and seals the exam", async () => {
    const directory = new StateDirectory();
    const sessionRegistry = await loadBehavior(readFileSync(join(TASKS, "behavior/session.scm"), "utf8"), {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/session.scm"),
    });
    const projectRegistry = await loadBehavior(readFileSync(join(TASKS, "behavior/project.scm"), "utf8"), {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/project.scm"),
    });
    const surface = resolvePackageSurface(TASKS);
    const behavior = surface.bots[0]?.behavior;
    if (behavior == null) throw new Error("tasks behavior");
    const hook = await loadBehavior(behavior.programSource, {
      agentId: "foreground",
      filename: behavior.programPath,
      root: TASKS,
    });
    const session = directory.open(
      "tasks-session",
      "session",
      "abi",
      reducerOf(sessionRegistry),
      sessionRegistry.methods,
    );
    const project = directory.open(
      "tasks-project",
      "project",
      "abi",
      reducerOf(projectRegistry),
      projectRegistry.methods,
    );
    const caller = new CallerLedger();
    const bindings = new Map<string, BoundReceiver>([
      ["tasks", bind(session.id, session.abi, ["incomplete", "create", "start"])],
      ["project-tasks", bind(project.id, project.abi, ["accept", "accepted", "complete"])],
    ]);
    let seq = 0;
    const notes = new NoteLog();
    const round = async () =>
      await dispatchBoundary({
        registry: hook,
        point: "round",
        record: "round",
        notes,
        turnId: "t1",
        onMethod: async (receiver, method, kw) => {
          seq += 1;
          return await callMethod({
            directory,
            caller,
            bindings,
            receiver,
            method,
            args: Object.fromEntries(kw),
            callId: `${receiver}.${method}#${seq}`,
          });
        },
      });
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("foreground")).toEqual([]);
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "tasks",
      method: "create",
      args: { "task-id": "t1", program: EXAM },
      callId: "create-1",
    });
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "tasks",
      method: "create",
      args: { "task-id": "t2", program: EXAM },
      callId: "create-2",
    });
    const pending = await round();
    expect(pending.originAtoms).toEqual([]);
    expect(notes.peek("foreground").map((note) => note.text)).toEqual(["t1\nt2"]);
    notes.consume(
      "foreground",
      notes.peek("foreground").flatMap((note) => (note.id == null ? [] : [note.id])),
      "placed-pending",
    );
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "tasks",
      method: "start",
      args: { "task-id": "t1" },
      callId: "start-1",
    });
    const opened = await round();
    expect(opened.originAtoms).toEqual([]);
    expect(notes.peek("foreground").map((note) => note.text)).toEqual([`t1\nt2\n\n${OPEN_PAGE_NOTE}`]);
    const firstOpen = notes.peek("foreground")[0]?.id ?? "";
    notes.consume("foreground", [firstOpen], "placed-open");
    const again = await round();
    expect(again.originAtoms).toEqual([]);
    expect(notes.peek("foreground")[0]?.id).not.toBe(firstOpen);
    notes.consume(
      "foreground",
      notes.peek("foreground").flatMap((note) => (note.id == null ? [] : [note.id])),
      "placed-open-2",
    );
    hostPropose(directory, session, new Dict({ type: "verdict", "task-id": "t2", ok: true }));
    expect(toJS(await projectionOf(session))).toMatchObject({ active: "t1" });
    hostPropose(directory, session, new Dict({ type: "verdict", "task-id": "t1", ok: true }));
    expect(toJS(await projectionOf(session))).toMatchObject({
      active: false,
      pending: 1,
      pages: [
        { id: "t1", status: "completed" },
        { id: "t2", status: "pending" },
      ],
    });
    const afterVerdict = await round();
    expect(afterVerdict.originAtoms).toEqual([]);
    expect(notes.peek("foreground").map((note) => note.text)).toEqual(["t2"]);
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "project-tasks",
      method: "accept",
      args: { "task-id": "t1" },
      callId: "accept",
    });
    directory.rollback(session.id, 0);
    expect(toJS(await projectionOf(project))).toEqual({
      accepted: "t1",
      done: false,
    });
    expect(toJS(await projectionOf(session))).toMatchObject({
      pending: 0,
      pages: [],
    });
  });
  it("drops a page, records an after edge, and refuses an unsealed exam", async () => {
    const directory = new StateDirectory();
    const sessionRegistry = await loadBehavior(readFileSync(join(TASKS, "behavior/session.scm"), "utf8"), {
      kind: "state",
      root: TASKS,
      filename: join(TASKS, "behavior/session.scm"),
    });
    const session = directory.open(
      "tasks-pages",
      "session",
      "abi",
      reducerOf(sessionRegistry),
      sessionRegistry.methods,
    );
    const caller = new CallerLedger();
    const bindings = new Map([
      ["tasks", bind(session.id, session.abi, ["incomplete", "create", "start", "drop", "after", "validate"])],
    ]);
    const call = async (method: string, args: Record<string, string>, callId: string) =>
      await callMethod({
        directory,
        caller,
        bindings,
        receiver: "tasks",
        method,
        args,
        callId,
      });
    expect(await call("create", { "task-id": "t1", program: EXAM }, "c1")).toBe("t1");
    expect(await call("create", { "task-id": "t2", program: EXAM }, "c2")).toBe("t2");
    expect(await call("after", { "task-id": "t2", after: "t2" }, "self")).toBeInstanceOf(Refusal);
    expect(await call("after", { "task-id": "t2", after: "t1" }, "edge")).toBe("after");
    expect(await call("after", { "task-id": "t2", after: "t1" }, "edge-again")).toBe("after");
    expect(await call("start", { "task-id": "t1" }, "start")).toBe("started");
    expect(toJS(await call("incomplete", {}, "open"))).toMatchObject({
      open: true,
    });
    const beforeExam = session.log.length;
    await expect(call("validate", { "task-id": "t1" }, "exam")).rejects.toThrow(/protected action/);
    expect(session.log).toHaveLength(beforeExam);
    expect(await call("drop", { "task-id": "t2", reason: "replaced" }, "drop-2")).toBe("dropped");
    expect(toJS(await call("incomplete", {}, "still-open"))).toEqual({
      open: true,
      text: `t1\n\n${OPEN_PAGE_NOTE}`,
    });
    expect(await call("drop", { "task-id": "t1", reason: "done by hand" }, "drop-1")).toBe("dropped");
    expect(toJS(await call("incomplete", {}, "quiet"))).toEqual({ open: false, text: "" });
    const projected = toJS(await projectionOf(session)) as {
      pages: {
        id: string;
        status: string;
        preds: string[];
      }[];
      pending: number;
      active: boolean | string;
    };
    expect(projected.pending).toBe(0);
    expect(projected.active).toBe(false);
    expect(projected.pages.map((page) => [page.id, page.status, page.preds])).toEqual([
      ["t1", "dropped", []],
      ["t2", "dropped", ["t1"]],
    ]);
    expect(await call("drop", { "task-id": "missing", reason: "nope" }, "missing")).toBeInstanceOf(Refusal);
  });
  it("ticks a session goal until it is exhausted and blocks on a failed round", async () => {
    const directory = new StateDirectory();
    const state = await loadBehavior(readFileSync(join(GOAL, "behavior/session.scm"), "utf8"), {
      kind: "state",
      root: GOAL,
      filename: join(GOAL, "behavior/session.scm"),
    });
    const surface = resolvePackageSurface(GOAL);
    const behavior = surface.bots[0]?.behavior;
    if (behavior == null) throw new Error("goal behavior");
    const hook = await loadBehavior(behavior.programSource, {
      agentId: "goal-bot",
      filename: behavior.programPath,
      root: GOAL,
    });
    const owner = directory.open("goal", "session", "abi", reducerOf(state), state.methods);
    const caller = new CallerLedger();
    const bindings = new Map([["goal", bind(owner.id, owner.abi, ["get", "set", "tick", "block"])]]);
    let seq = 0;
    const notes = new NoteLog();
    const round = async (core?: () => Val) =>
      await dispatchBoundary({
        registry: hook,
        point: "round",
        record: "round",
        notes,
        turnId: "t1",
        core,
        onMethod: async (receiver, method, kw) => {
          seq += 1;
          return await callMethod({
            directory,
            caller,
            bindings,
            receiver,
            method,
            args: Object.fromEntries(kw),
            callId: `${method}#${seq}`,
          });
        },
      });
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("goal-bot")).toEqual([]);
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "goal",
      method: "set",
      args: { text: "ship", loops: 2 },
      callId: "set",
    });
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("goal-bot").map((note) => note.text)).toEqual(["ship"]);
    expect(toJS(await projectionOf(owner))).toMatchObject({
      status: "active",
      loops: 1,
      text: "ship",
    });
    notes.consume(
      "goal-bot",
      notes.peek("goal-bot").flatMap((note) => (note.id == null ? [] : [note.id])),
      "r1",
    );
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("goal-bot").map((note) => note.text)).toEqual(["ship"]);
    expect(toJS(await projectionOf(owner))).toMatchObject({
      status: "exhausted",
      loops: 0,
    });
    notes.consume(
      "goal-bot",
      notes.peek("goal-bot").flatMap((note) => (note.id == null ? [] : [note.id])),
      "r2",
    );
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("goal-bot")).toEqual([]);
    await callMethod({
      directory,
      caller,
      bindings,
      receiver: "goal",
      method: "set",
      args: { text: "ship", loops: 2 },
      callId: "set-again",
    });
    const failed = await round(() => {
      throw new Error("boom");
    });
    expect(failed.failure).toBe("boom");
    expect(toJS(await projectionOf(owner))).toMatchObject({
      status: "blocked",
      loops: 2,
    });
    directory.rollback(owner.id, 0);
    expect(toJS(await projectionOf(owner))).toMatchObject({
      status: "none",
      loops: 0,
    });
  });
  it("lets the writer commit cited memory and keeps the scout on the read grant", async () => {
    const directory = new StateDirectory();
    const state = await loadBehavior(readFileSync(join(OFFLOAD, "behavior/project.scm"), "utf8"), {
      kind: "state",
      root: OFFLOAD,
      filename: join(OFFLOAD, "behavior/project.scm"),
    });
    const surface = resolvePackageSurface(OFFLOAD);
    const writerBehavior = surface.bots.find((bot) => bot.path.endsWith("writer.prompt"))?.behavior;
    const scoutBehavior = surface.bots.find((bot) => bot.path.endsWith("scout.prompt"))?.behavior;
    if (writerBehavior == null || scoutBehavior == null) throw new Error("offload behavior");
    const writer = await loadBehavior(writerBehavior.programSource, {
      agentId: "writer",
      filename: writerBehavior.programPath,
      root: OFFLOAD,
    });
    const scout = await loadBehavior(scoutBehavior.programSource, {
      agentId: "scout",
      filename: scoutBehavior.programPath,
      root: OFFLOAD,
    });
    const project = directory.open("offload-project", "project", "abi", reducerOf(state), state.methods);
    const global = directory.open("offload-global", "global", "abi", reducerOf(state), state.methods);
    const caller = new CallerLedger();
    const grants = new Map<string, BoundReceiver>([
      ["offload", bind(project.id, project.abi, ["get-memory", "put-memory", "search"])],
      ["global-offload", bind(global.id, global.abi, ["get-memory", "put-memory"])],
    ]);
    const readGrants = new Map<string, BoundReceiver>([
      ["offload", bind(project.id, project.abi, ["get-memory", "search"])],
    ]);
    const onMethod =
      (allowed: Map<string, BoundReceiver>, callId: string) =>
      async (receiver: string, method: string, kw: ReadonlyMap<string, Val>) =>
        await callMethod({
          directory,
          caller,
          bindings: allowed,
          receiver,
          method,
          args: Object.fromEntries(kw),
          callId,
        });
    expect(
      await callDeclaredTool(
        writer,
        "offload",
        new Dict({ text: "fact", citation: "" }),
        onMethod(grants, "empty-cite"),
      ),
    ).toBeInstanceOf(Refusal);
    expect(project.log).toHaveLength(0);
    expect(
      await callDeclaredTool(
        writer,
        "offload",
        new Dict({ text: "fact", citation: "a.ts" }),
        onMethod(grants, "req-1"),
      ),
    ).toBe("fact");
    expect(
      await callDeclaredTool(
        writer,
        "offload",
        new Dict({ text: "fact", citation: "a.ts" }),
        onMethod(grants, "req-1"),
      ),
    ).toBe("fact");
    expect(project.log).toHaveLength(1);
    await expect(
      async () =>
        await callDeclaredTool(
          writer,
          "offload",
          new Dict({ text: "other", citation: "b.ts" }),
          onMethod(grants, "req-1"),
        ),
    ).rejects.toThrow(/call id reuse/);
    await expect(
      async () =>
        await callMethod({
          directory,
          caller,
          bindings: grants,
          receiver: "offload",
          method: "put-memory",
          args: { text: "stale", citation: "c.ts" },
          callId: "stale",
          observedRevision: 0,
        }),
    ).rejects.toThrow(/stale commit/);
    expect(await callDeclaredTool(scout, "tingle", new Dict({ query: "fact" }), onMethod(readGrants, "search-1"))).toBe(
      "fact",
    );
    expect(
      await callMethod({
        directory,
        caller,
        bindings: grants,
        receiver: "global-offload",
        method: "get-memory",
        args: {},
        callId: "global",
      }),
    ).toBe("");
    expect(writer.tools.has("tingle")).toBe(false);
    expect(scout.tools.has("offload")).toBe(false);
  });
  it("fuses a plan and a granted memory read into one activating note", async () => {
    const directory = new StateDirectory();
    const planRegistry = await loadBehavior(readFileSync(join(FUSION, "behavior/session.scm"), "utf8"), {
      kind: "state",
      root: FUSION,
      filename: join(FUSION, "behavior/session.scm"),
    });
    const memoryRegistry = await loadBehavior(readFileSync(join(OFFLOAD, "behavior/project.scm"), "utf8"), {
      kind: "state",
      root: OFFLOAD,
      filename: join(OFFLOAD, "behavior/project.scm"),
    });
    const surface = resolvePackageSurface(FUSION);
    const behavior = surface.bots[0]?.behavior;
    if (behavior == null) throw new Error("fusion behavior");
    const memoryGrant = behavior.bindings?.offload;
    if (memoryGrant == null) throw new Error("fusion memory grant");
    expect(memoryGrant.methods).toEqual(["get-memory", "search"]);
    const hook = await loadBehavior(behavior.programSource, {
      agentId: "planner",
      filename: behavior.programPath,
      root: FUSION,
    });
    expect(hook.guards).toEqual([]);
    expect(hook.tools.size).toBe(0);
    expect(modelCatalog(hook)).toEqual([]);
    const plan = directory.open("fusion-session", "session", "abi", reducerOf(planRegistry), planRegistry.methods);
    const memory = directory.open("fusion-memory", "project", "abi", reducerOf(memoryRegistry), memoryRegistry.methods);
    const caller = new CallerLedger();
    const hookBindings = new Map<string, BoundReceiver>([
      ["plan", bind(plan.id, plan.abi, ["get", "advance", "recall", "block"])],
      ["offload", bind(memory.id, memory.abi, ["get-memory", "search"])],
    ]);
    const authorBindings = new Map<string, BoundReceiver>([
      ["plan", bind(plan.id, plan.abi, ["open", "get", "clear"])],
      ["offload", bind(memory.id, memory.abi, ["put-memory", "get-memory", "search"])],
    ]);
    let seq = 0;
    const notes = new NoteLog();
    const round = async (core?: () => Val) =>
      await dispatchBoundary({
        registry: hook,
        point: "round",
        record: "round",
        notes,
        turnId: "t1",
        core,
        onMethod: async (receiver, method, kw) => {
          seq += 1;
          return await callMethod({
            directory,
            caller,
            bindings: hookBindings,
            receiver,
            method,
            args: Object.fromEntries(kw),
            callId: `hook.${receiver}.${method}#${seq}`,
          });
        },
      });
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("planner")).toEqual([]);
    expect(
      await callMethod({
        directory,
        caller,
        bindings: authorBindings,
        receiver: "plan",
        method: "open",
        args: { text: "", steps: 2 },
        callId: "empty-plan",
      }),
    ).toBeInstanceOf(Refusal);
    expect(
      await callMethod({
        directory,
        caller,
        bindings: authorBindings,
        receiver: "plan",
        method: "open",
        args: { text: "ship", steps: 2 },
        callId: "open",
      }),
    ).toBe("ship");
    const missed = await round();
    expect(missed.originAtoms).toEqual([]);
    expect(notes.peek("planner")).toHaveLength(1);
    expect(notes.peek("planner").map((note) => note.text)).toEqual(["ship"]);
    expect(toJS(await projectionOf(plan))).toMatchObject({
      status: "active",
      steps: 1,
      recall: "",
    });
    notes.consume(
      "planner",
      notes.peek("planner").flatMap((note) => (note.id == null ? [] : [note.id])),
      "miss",
    );
    expect(
      await callMethod({
        directory,
        caller,
        bindings: authorBindings,
        receiver: "offload",
        method: "put-memory",
        args: { text: "ship: use the public API", citation: "api.ts" },
        callId: "remember",
      }),
    ).toBe("ship: use the public API");
    await expect(
      async () =>
        await callMethod({
          directory,
          caller,
          bindings: hookBindings,
          receiver: "offload",
          method: "put-memory",
          args: { text: "nope", citation: "api.ts" },
          callId: "planner-write",
        }),
    ).rejects.toThrow(/method not granted/);
    const fused = await round();
    expect(fused.originAtoms).toEqual([]);
    expect(notes.peek("planner")).toHaveLength(1);
    expect(notes.peek("planner").map((note) => note.text)).toEqual(["ship\nship: use the public API"]);
    expect(toJS(await projectionOf(plan))).toMatchObject({
      status: "done",
      steps: 0,
      recall: "ship: use the public API",
    });
    notes.consume(
      "planner",
      notes.peek("planner").flatMap((note) => (note.id == null ? [] : [note.id])),
      "fused",
    );
    expect((await round()).originAtoms).toEqual([]);
    expect(notes.peek("planner")).toEqual([]);
    directory.rollback(plan.id, 0);
    expect(toJS(await projectionOf(plan))).toMatchObject({
      status: "none",
      steps: 0,
    });
    expect(toJS(await projectionOf(memory))).toMatchObject({
      body: "ship: use the public API",
      revision: 1,
    });
    expect(() => directory.rollback(memory.id, 0)).toThrow(/does not undo accepted project/);
    await callMethod({
      directory,
      caller,
      bindings: authorBindings,
      receiver: "plan",
      method: "open",
      args: { text: "ship", steps: 2 },
      callId: "reopen",
    });
    const failed = await round(() => {
      throw new Error("boom");
    });
    expect(failed.failure).toBe("boom");
    expect(toJS(await projectionOf(plan))).toMatchObject({
      status: "blocked",
      steps: 2,
    });
  });
});

/** Template holes cannot replace the trusted program, environment, or bindings. */
function sealBehaviorAgainstTemplate(
  selection: BehaviorSelection,
  template: Readonly<Record<string, unknown>>,
): BehaviorSelection {
  PluginSurfaceError.invariant(
    !("program" in template || "environment" in template || "bindings" in template),
    "template inputs cannot replace behavior selection",
  );
  return selection;
}

/** Existing instances keep their pin. A new instance takes the authored selection. */
function initialBehaviorPin(existing: string, authored: string): string {
  if (existing.trim() !== "") return existing;
  return authored;
}

/** A rendered bundle cannot select a program other than the trusted one. */
function behaviorFromRender(trustedProgram: string, renderedProgram: string | undefined): string {
  PluginSurfaceError.invariant(
    renderedProgram == null || renderedProgram === "" || renderedProgram === trustedProgram,
    "forged render bundle cannot select behavior",
  );
  return trustedProgram;
}

type Attunement = {
  readonly activeTurn: boolean;
  readonly outstanding: readonly string[];
  readonly current: string;
  readonly next: string;
};

/** In-flight work keeps its originating revision. The next turn takes the new pin. */
function reattune(state: Attunement): {
  readonly active: string;
  readonly queued: string;
  readonly outstanding: string;
} {
  if (state.activeTurn || state.outstanding.length > 0) {
    return {
      active: state.current,
      queued: state.next,
      outstanding: state.current,
    };
  }
  return { active: state.next, queued: state.next, outstanding: "" };
}

/** Historical actions keep the reducer revision they were recorded with. */
function reducerForReplay(actionRevision: string, currentRevision: string, migrated: boolean): string {
  PluginSurfaceError.invariant(
    actionRevision === currentRevision || migrated,
    "incompatible reducer change requires migration or reset",
  );
  return migrated ? currentRevision : actionRevision;
}

/**
 * Branch context policy. A changed branch is ambient. An unchanged branch is
 * ambient again only when the context itself is fresh (after compaction).
 * The same branch in the same context stays quiet.
 */
function branchContextDecision(opts: {
  readonly previousBranch: string;
  readonly nextBranch: string;
  readonly freshContext: boolean;
}): "ambient" | "quiet" {
  if (opts.previousBranch !== opts.nextBranch || opts.freshContext) return "ambient";
  return "quiet";
}
