import { exec } from "@here.build/arrival";
import { PlexusAwareness } from "@here.build/plexus";
import { defaultCommands } from "@inhuman.tools/harness/testkit";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  admitQueue,
  clampChars,
  CompletionExpectation,
  CompletionJob,
  publishKernelSeat,
  reactChunks,
  tapeCompletion,
  SESSION_TITLE_MAX_CHARS,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  CommandSpec,
  KernelPlexus,
  KernelRoot,
  SessionPlexus,
  steerFirstQueued,
} from "@inhuman.tools/harness-model";
import { forwardPlexusAwareness, ingestPlexusAwareness } from "@inhuman.tools/harness-peer/awareness";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { ConnectionSpec, DriverSpec, reportRole, revalidationDemandOf } from "@inhuman.tools/plexus-expectations";
import { expect, test, vi } from "vitest";
import * as Y from "yjs";

import { imageCapability } from "../../interpreter/imageCapability.js";
import { uiCapability, UiNode } from "../../interpreter/uiCapability.js";
import { paintChildrenOf } from "../paint-dom.js";
import { bootComposerDraft, Tea } from "../tea.js";

type RpcCall = { method: string; params: unknown };

test("Tea submit joins text parts and sends an image beside the prompt", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  using tea = new Tea(client, () => undefined);
  const pasted = "line\n".repeat(400);
  tea.handle({
    kind: "submit",
    parts: [{ text: "see " }, { text: pasted }],
    command: null,
  });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 1);
  expect(calls[0]).toEqual({ method: "turn", params: { prompt: `see ${pasted}` } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  tea.handle({
    kind: "submit",
    parts: [{ text: "look " }, { image: { mime: "image/png", bytes: new Uint8Array([0x89, 0x50]) } }],
    command: null,
  });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 2);
  expect(calls[1]).toEqual({
    method: "turn",
    params: {
      prompt: "look ",
      visuals: [{ mime: "image/png", bytesBase64: Buffer.from(new Uint8Array([0x89, 0x50])).toString("base64") }],
    },
  });
});

test("Tea admitting keys: fire, continue, queue, steer, cancel without sealing", async () => {
  const bare = localClient();
  const bareCalls: RpcCall[] = [];
  bare.request = async (method, params) => {
    bareCalls.push({ method, params });
    return { ok: true };
  };
  using bareTea = new Tea(bare, () => undefined);
  bareTea.handle({ kind: "input_events", events: [..."hello"].map((key) => ({ key })) });
  bareTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => bareCalls.length === 1 && bareTea.draft.draft === "");
  const fired = { calls: [...bareCalls], draft: bareTea.draft.draft };

  const empty = localClient();
  const emptyCalls: RpcCall[] = [];
  empty.request = async (method, params) => {
    emptyCalls.push({ method, params });
  };
  using emptyTea = new Tea(empty, () => undefined);
  emptyTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await flushMicrotasks();
  const emptyEnter = [...emptyCalls];

  const failed = localClient();
  const failedCalls: RpcCall[] = [];
  failed.request = async (method, params) => {
    failedCalls.push({ method, params });
    return { ok: true };
  };
  failed.sessionRoot.head = closedTurn("failed");
  using failedTea = new Tea(failed, () => undefined);
  failedTea.handle({ kind: "input_events", events: [{ key: "Enter", ctrl: true }] });
  await flushMicrotasks();
  const persistMod = [...failedCalls];
  failedTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => failedCalls.some((call) => call.method === "turn"));
  const continued = [...failedCalls];

  const ok = localClient();
  const okCalls: RpcCall[] = [];
  ok.request = async (method, params) => {
    okCalls.push({ method, params });
    return { ok: true };
  };
  ok.sessionRoot.head = closedTurn("successful");
  using okTea = new Tea(ok, () => undefined);
  okTea.handle({ kind: "input_events", events: [{ key: " " }] });
  okTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await flushMicrotasks();

  const queued = localClient();
  const queuedCalls: RpcCall[] = [];
  queued.request = async (method, params) => {
    queuedCalls.push({ method, params });
    if (method === "turn" && typeof params === "object" && params !== null) {
      const rec = params as { prompt?: unknown; kind?: unknown };
      if (rec.kind === "queue" && typeof rec.prompt === "string") {
        const turn = queued.sessionRoot.findRunningTurn();
        if (turn != null) admitQueue(queued.sessionRoot, prompt.user`${rec.prompt}`, turn.uuid);
      }
    }
    // The daemon decides the inbox move; the client only names the row.
    if (method === "queue/steer-first" && (params as { id?: unknown }).id === queued.sessionRoot.promptQueue[0]?.uuid) {
      steerFirstQueued(queued.sessionRoot);
    }
    return { ok: true };
  };
  queued.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hello`,
  });
  using queuedTea = new Tea(queued, () => undefined);
  queuedTea.handle({ kind: "input_events", events: [..."later"].map((key) => ({ key })) });
  queuedTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => queued.sessionRoot.promptQueue.length === 1);
  const queuedPhase = {
    calls: [...queuedCalls],
    draft: queuedTea.draft.draft,
    queue: queued.sessionRoot.promptQueue.map((row) => row.text),
  };
  const laterId = queued.sessionRoot.promptQueue[0]?.uuid;
  queuedTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => queuedCalls.length === 2);
  const steered = {
    call: queuedCalls[1],
    steer: queued.sessionRoot.steerQueue.map((row) => row.text),
    queue: queued.sessionRoot.promptQueue.map((row) => row.text),
  };

  expect({
    fired,
    emptyEnter,
    persistMod,
    continued,
    successful: okCalls,
    queued: queuedPhase,
    steered,
  }).toEqual({
    fired: { calls: [{ method: "turn", params: { prompt: "hello" } }], draft: "" },
    emptyEnter: [],
    persistMod: [],
    continued: [{ method: "turn", params: { prompt: "", kind: "continue" } }],
    successful: [],
    queued: {
      calls: [{ method: "turn", params: { prompt: "later", kind: "queue" } }],
      draft: "",
      queue: ["later"],
    },
    steered: { call: { method: "queue/steer-first", params: { id: laterId } }, steer: ["later"], queue: [] },
  });
});

test("Tea #busy holds the next keystroke until turn resolves", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    await held;
    return { ok: true };
  };
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [..."hello"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 1 && tea.draft.draft === "");
  tea.handle({ kind: "input_events", events: [..."next"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await flushMicrotasks();
  const whileHeld = { calls: [...calls], draft: tea.draft.draft };
  release();
  // #run clears #busy on the microtask after the held request settles.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  tea.handle({ kind: "input_events", events: [..."after"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 2);
  expect({ whileHeld, after: { calls: [...calls], draft: tea.draft.draft } }).toEqual({
    whileHeld: { calls: [{ method: "turn", params: { prompt: "hello" } }], draft: "" },
    after: {
      calls: [
        { method: "turn", params: { prompt: "hello" } },
        { method: "turn", params: { prompt: "after" } },
      ],
      draft: "",
    },
  });
});

test("Tea double-Esc cancel then empty Enter continues", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  const chunk = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: chunk })],
    queue: [],
  });
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  const before = paintedCompletionState(tea);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => calls.some((call) => call.method === "turn/cancel"));
  // The daemon has not echoed the cancel: the replica is unwritten, yet the tape already paints it.
  expect({
    calls,
    painted: { before, pending: paintedCompletionState(tea) },
    requested: turn.cancelRequested,
    cancelled: turn.cancelled,
    reducerExited: turn.reducerExited,
    outcome: chunk.outcome,
  }).toEqual({
    calls: [{ method: "turn/cancel", params: { turnId: turn.uuid } }],
    painted: { before: "live", pending: "successful" },
    requested: false,
    cancelled: false,
    reducerExited: false,
    outcome: null,
  });
  ackTurnCancel(turn);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "turn"));
  expect(calls.at(-1)).toEqual({ method: "turn", params: { prompt: "", kind: "continue" } });
});

test("Tea Enter: continue waits for cancel ack, not the request", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  const chunk = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: chunk })],
    queue: [],
  });
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  turn.cancelRequested = true;
  turn.reducerExited = true;
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toEqual([]);
  ackTurnCancel(turn);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "turn"));
  expect(calls).toEqual([{ method: "turn", params: { prompt: "", kind: "continue" } }]);
});

test("Tea persist-mod Enter retries a live backoff; bare empty Enter does not", async () => {
  {
    const client = localClient();
    const calls: RpcCall[] = [];
    client.request = async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    };
    const chunk = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [new CompletionJob({ expectation: chunk })],
      queue: [],
    });
    client.sessionRoot.head = turn;
    const hub = chunk.awareness;
    if (hub == null) throw new Error("completion is not homed");
    reportRole(hub, chunk.uuid, { retryUntilMs: Date.now() + 60_000 });
    using tea = new Tea(client, () => undefined);
    tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual([]);
    tea.handle({ kind: "input_events", events: [{ key: "Enter", ctrl: true }] });
    await waitFor(() => calls.some((call) => call.method === "turn/retry"));
    expect(calls).toEqual([{ method: "turn/retry", params: {} }]);
  }

  vi.useFakeTimers();
  try {
    let now = 1_000;
    const elapsed = localClient();
    const elapsedCalls: RpcCall[] = [];
    elapsed.request = async (method, params) => {
      elapsedCalls.push({ method, params });
      return { ok: true };
    };
    const elapsedChunk = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
    const elapsedTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [new CompletionJob({ expectation: elapsedChunk })],
      queue: [],
    });
    elapsed.sessionRoot.head = elapsedTurn;
    const elapsedHub = elapsedChunk.awareness;
    if (elapsedHub == null) throw new Error("completion is not homed");
    reportRole(elapsedHub, elapsedChunk.uuid, { retryUntilMs: 1_500 });
    using elapsedTea = new Tea(elapsed, () => undefined, { now: () => now });
    now = 1_500;
    vi.advanceTimersByTime(500);
    elapsedTea.handle({ kind: "input_events", events: [{ key: "Enter", ctrl: true }] });
    expect(elapsedCalls).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("Tea Tab on a catalog prefix rewrites the verb", async () => {
  const client = localClient();
  client.kernelRoot.commands = { model: defaultCommandSpec("model") };
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [..."/mo"].map((key) => ({ key })) });
  await waitForRow(tea, "/model");
  const prefix = tea.draft.draft;
  tea.handle({ kind: "input_events", events: [{ key: "Tab" }] });
  const completed = tea.draft.draft;
  tea.handle({ kind: "input_events", events: [..."gro"].map((key) => ({ key })) });
  expect({ prefix, completed, remainder: tea.draft.draft }).toEqual({
    prefix: "/mo",
    completed: "/model ",
    remainder: "/model gro",
  });
});

test.each([
  {
    name: "connect existing Work",
    draft: "/connect",
    picker: "Work",
    seed: (client: Client) => {
      const openai = new DriverSpec({
        name: "openai-compat",
        description: "OpenAI-compatible",
        importPath: "test:openai",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
      });
      client.kernelRoot.drivers = { "openai-compat": openai };
      client.kernelRoot.connections = { work: new ConnectionSpec({ driver: openai, name: "Work" }) };
      client.sessionRoot.lastUsedConnectionModel = { work: "gpt-4" };
      client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
    },
    expected: [
      { method: "kv/set", params: { key: "connection", value: "work", remember: "1" } },
      { method: "kv/set", params: { key: "model", value: "gpt-4", remember: "1" } },
    ],
  },
  {
    name: "connect without cached model picks the highest version",
    draft: "/connect",
    picker: "Work",
    seed: (client: Client) => {
      const openai = new DriverSpec({
        name: "openai-compat",
        description: "OpenAI-compatible",
        importPath: "test:openai",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
      });
      const work = new ConnectionSpec({ driver: openai, name: "Work" });
      work.live = { models: ["gpt-4o", "gpt-4.1", "gpt-5"] };
      client.kernelRoot.drivers = { "openai-compat": openai };
      client.kernelRoot.connections = { work };
      client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
    },
    expected: [
      { method: "kv/set", params: { key: "connection", value: "work", remember: "1" } },
      { method: "kv/set", params: { key: "model", value: "gpt-5", remember: "1" } },
    ],
  },
  {
    name: "connect without cached model keeps the first id when none carry a version",
    draft: "/connect",
    picker: "Work",
    seed: (client: Client) => {
      const openai = new DriverSpec({
        name: "openai-compat",
        description: "OpenAI-compatible",
        importPath: "test:openai",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
      });
      const work = new ConnectionSpec({ driver: openai, name: "Work" });
      work.live = { models: ["ghost", "spectre"] };
      client.kernelRoot.drivers = { "openai-compat": openai };
      client.kernelRoot.connections = { work };
      client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
    },
    expected: [
      { method: "kv/set", params: { key: "connection", value: "work", remember: "1" } },
      { method: "kv/set", params: { key: "model", value: "ghost", remember: "1" } },
    ],
  },
  {
    name: "connect cached model beats a higher live version",
    draft: "/connect",
    picker: "Work",
    seed: (client: Client) => {
      const openai = new DriverSpec({
        name: "openai-compat",
        description: "OpenAI-compatible",
        importPath: "test:openai",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
      });
      const work = new ConnectionSpec({ driver: openai, name: "Work" });
      work.live = { models: ["gpt-4o", "gpt-5"] };
      client.kernelRoot.drivers = { "openai-compat": openai };
      client.kernelRoot.connections = { work };
      client.sessionRoot.lastUsedConnectionModel = { work: "gpt-4o" };
      client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
    },
    expected: [
      { method: "kv/set", params: { key: "connection", value: "work", remember: "1" } },
      { method: "kv/set", params: { key: "model", value: "gpt-4o", remember: "1" } },
    ],
  },
  {
    name: "adopt unused openrouter",
    draft: "/connect",
    picker: "openrouter",
    seed: (client: Client) => {
      client.kernelRoot.drivers = {
        openrouter: new DriverSpec({
          name: "openrouter",
          description: "OpenRouter",
          importPath: "test:openrouter",
          abilityClaim: ["completion"],
          multiplicity: "add-by-default",
        }),
      };
      client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
    },
    expected: [{ method: "connect/adopt", params: { driver: "openrouter", name: "openrouter" } }],
  },
  {
    name: "/model gpt-4",
    draft: "/model",
    picker: "gpt-4",
    applyKv: true,
    seed: (client: Client) => {
      const openai = new DriverSpec({
        name: "openai-compat",
        description: "OpenAI-compatible",
        importPath: "test:openai",
        abilityClaim: ["completion"],
        multiplicity: "add-as-secondary",
      });
      const work = new ConnectionSpec({ driver: openai, name: "Work" });
      work.live = { models: ["gpt-4"] };
      client.kernelRoot.drivers = { "openai-compat": openai };
      client.kernelRoot.connections = { work };
      client.kernelRoot.commands = { model: defaultCommandSpec("model") };
    },
    expected: [
      { method: "kv/set", params: { key: "connection", value: "work", remember: "1" } },
      { method: "kv/set", params: { key: "model", value: "gpt-4", remember: "1" } },
    ],
  },
  {
    name: "/mcp adopt",
    draft: "/mcp",
    picker: "Add MCP",
    reply: { id: "sentry" },
    seed: (client: Client) => {
      client.kernelRoot.drivers = {
        "mcp-http": new DriverSpec({
          name: "mcp-http",
          description: "MCP Streamable HTTP",
          importPath: "mcp-http",
          abilityClaim: ["mcp"],
          multiplicity: "add-as-secondary",
        }),
      };
      client.kernelRoot.commands = { mcp: defaultCommandSpec("mcp") };
    },
    expected: [{ method: "mcp-server/adopt", params: {} }],
  },
  {
    name: "/compact plugin shadow",
    draft: "/compact keep",
    reply: { ok: true, compacted: false },
    seed: (client: Client) => {
      client.kernelRoot.commands = {
        compact: new CommandSpec({
          verb: "compact",
          description: "plugin shadow",
          body: `(harness/action 'kv/set :params (dict :key "shadow" :value "1"))`,
        }),
      };
    },
    expected: [{ method: "compact", params: { focus: "keep" } }],
  },
])("Tea pick-wire $name", async (row) => {
  expect(await playPickWire(row)).toEqual(row.expected);
});

test("Tea pick-wire hides LM Studio duplicate offer", async () => {
  const hideOpenai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  hideOpenai.offers = [
    {
      name: "LM Studio",
      description: "Local OpenAI-compat :1234",
      live: true,
      adoptable: true,
      settings: { baseUrl: "http://127.0.0.1:1234/v1" },
    },
  ];
  const hideWork = new ConnectionSpec({ driver: hideOpenai, name: "Work" });
  hideWork.configuration = { baseUrl: "http://127.0.0.1:1234/v1" };
  const kernel = new KernelRoot();
  kernel.drivers = { "openai-compat": hideOpenai };
  kernel.connections = { work: hideWork };
  const values = await exec(defaultCommandBody("connect"), {
    capabilities: [imageCapability, uiCapability],
    config: { kernel },
  });
  const surface = values.at(-1);
  if (!(surface instanceof UiNode)) throw new Error("connect.scm did not eval to a UiNode");
  expect(surface.choices.map((row) => row.action.map((leaf) => ({ method: leaf.op, params: leaf.params })))).toEqual([
    [{ method: "kv/set", params: { key: "connection", value: "work", remember: "1" } }],
  ]);
});

test("connect.scm paints needs-auth ahead of the stored sign-in", async () => {
  const grok = new DriverSpec({
    name: "grok",
    description: "Grok subscription",
    importPath: "test:grok",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const wire = new ConnectionSpec({ driver: grok, name: "Grok" });
  wire.readyState = "ready";
  wire.live = {
    catalogName: "Grok",
    auth: "needs-auth",
    identity: { displayName: "Ada", plan: "SuperGrokPro" },
    account: { balance: { balance: "5", currency: { code: "USD", symbol: "$" } } },
  };
  const kernel = new KernelRoot();
  kernel.drivers = { grok };
  kernel.connections = { grok: wire };
  const values = await exec(defaultCommandBody("connect"), {
    capabilities: [imageCapability, uiCapability],
    config: { kernel },
  });
  const surface = values.at(-1);
  if (!(surface instanceof UiNode)) throw new Error("connect.scm did not eval to a UiNode");
  const row = surface.choices.find((choice) => choice.name === "Grok");
  expect({ description: row?.description, health: row?.health, annotation: row?.annotation }).toEqual({
    description: "needs auth — reconnect",
    health: "degraded",
    annotation: "",
  });
});

test("connect.scm says reconnect for a refused key and keeps a timeout as the connection error", async () => {
  const openai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  const refused = new ConnectionSpec({ driver: openai, name: "OpenAI" });
  refused.readyState = "failed";
  refused.error = "models probe GET https://api.openai.com/v1/models: HTTP 401";
  refused.live = { auth: "needs-auth", identity: { displayName: "Ada" } };
  const down = new ConnectionSpec({ driver: openai, name: "LM Studio" });
  down.readyState = "failed";
  down.error = "connect ETIMEDOUT 10.0.0.1:1";
  down.live = { auth: "needs-auth", identity: { displayName: "Ada" } };
  const kernel = new KernelRoot();
  kernel.drivers = { "openai-compat": openai };
  kernel.connections = { openai: refused, studio: down };
  const values = await exec(defaultCommandBody("connect"), {
    capabilities: [imageCapability, uiCapability],
    config: { kernel },
  });
  const surface = values.at(-1);
  if (!(surface instanceof UiNode)) throw new Error("connect.scm did not eval to a UiNode");
  const row = (name: string) => surface.choices.find((choice) => choice.name === name);
  expect({
    openai: row("OpenAI")?.description,
    studio: row("LM Studio")?.description,
  }).toEqual({
    openai: "The key was refused. Reconnect.",
    studio: "connect ETIMEDOUT 10.0.0.1:1",
  });
});

test("Tea looks at the drivers an open /connect list offers, until it closes", async () => {
  const client = localClient();
  const openai = new DriverSpec({
    name: "openai-compat",
    description: "OpenAI-compatible",
    importPath: "test:openai",
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  });
  openai.offers = [
    {
      name: "OpenAI-compatible",
      description: "Any OpenAI-compatible endpoint",
      live: false,
      adoptable: true,
      settings: {},
    },
  ];
  client.kernelRoot.drivers = { "openai-compat": openai };
  client.kernelRoot.commands = { connect: defaultCommandSpec("connect") };
  const looked = () => revalidationDemandOf(client.kernelPlexus.awareness, { kind: "driver", name: "openai-compat" });
  expect(looked()).toBe("none");
  const tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [..."/connect"].map((key) => ({ key })) });
  await waitForRow(tea, "OpenAI-compatible");
  expect(looked()).toBe("secondary");
  tea[Symbol.dispose]();
  expect(looked()).toBe("none");
});

test("Tea passes quota windows for Cmd/Ctrl overlay; paint owns remaining", () => {
  const client = localClient();
  const chatgpt = new DriverSpec({
    name: "chatgpt",
    description: "ChatGPT subscription",
    importPath: "test:chatgpt",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const wire = new ConnectionSpec({ driver: chatgpt, name: "chatgpt" });
  wire.live = {
    catalogName: "ChatGPT",
    account: {
      identity: { shortName: "", name: "" },
      identityDetail: { shortName: "", name: "", kind: "subscription" },
      balanceDetail: {
        windows: [
          { label: "5h", remainingPercent: 67, resetAt: 7200 },
          { label: "weekly", remainingPercent: 20, resetAt: 259_200 },
        ],
      },
    },
  };
  client.kernelRoot.drivers = { chatgpt };
  client.kernelRoot.connections = { chatgpt: wire };
  client.sessionRoot.applyKvs([
    { form: "kv-set", key: "connection", value: "chatgpt" },
    { form: "kv-set", key: "model", value: "gpt-5.4" },
  ]);
  using tea = new Tea(client, () => undefined);
  expect(tea.quotaWindows).toEqual([
    { remainingPercent: 67, resetAt: 7200 },
    { remainingPercent: 20, resetAt: 259_200 },
  ]);
});

test("Tea /agentic asks the daemon for spec.resident; /background asks, then quits", async () => {
  const quits: number[] = [];
  const residentNotes: boolean[] = [];
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    // Stand in for the daemon: it alone writes the resident bit.
    if (method === "resident/set") client.sessionRoot.agent.spec.resident = (params as { resident: boolean }).resident;
    return { ok: true };
  };
  using tea = new Tea(client, () => undefined, {
    quit: () => {
      quits.push(1);
    },
    resident: (on) => {
      residentNotes.push(on);
    },
  });

  tea.handle({ kind: "input_events", events: [..."/agentic maybe"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  expect({ calls: [...calls], draft: tea.draft.draft, quits }).toEqual({
    calls: [],
    draft: "/agentic maybe",
    quits: [],
  });

  tea.handle({ kind: "input_events", events: [{ key: "Escape" }, { key: "Escape" }] });
  tea.handle({ kind: "input_events", events: [..."/agentic true"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  expect({ resident: client.sessionRoot.agent.spec.resident, draft: tea.draft.draft, quits }).toEqual({
    resident: true,
    draft: "",
    quits: [],
  });

  tea.handle({ kind: "input_events", events: [..."/agentic false"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const afterFalse = client.sessionRoot.agent.spec.resident;
  tea.handle({ kind: "input_events", events: [..."/background"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => quits.length === 1);
  expect({
    calls: calls.map((call) => call.params),
    afterFalse,
    resident: client.sessionRoot.agent.spec.resident,
    quits,
    note: residentNotes.at(-1),
  }).toEqual({
    calls: [{ resident: true }, { resident: false }, { resident: true }],
    afterFalse: false,
    resident: true,
    quits: [1],
    note: true,
  });
});

test("Tea Shift+Tab asks the daemon for each next policy without writing its replica", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [
      { key: "Tab", shift: true },
      { key: "Tab", shift: true },
    ],
  });
  await waitFor(() => calls.length === 2);
  expect({ calls, replica: client.sessionRoot.permissionMode }).toEqual({
    calls: [
      { method: "policy/set", params: { policy: "auto" } },
      { method: "policy/set", params: { policy: "yolo" } },
    ],
    replica: "manual",
  });
});

test("Tea Enter on /quit and /new call host deps; remainder seeds draft; busy cancels first", async () => {
  const quits: number[] = [];
  const replacements: Array<{ path: string; draft?: string }> = [];
  const client = localClient();
  using tea = new Tea(client, () => undefined, {
    quit: () => {
      quits.push(1);
    },
    replaceSession: (opts) => {
      replacements.push(opts);
    },
  });
  tea.handle({ kind: "input_events", events: [..."/quit"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const afterQuit = { quits: [...quits], replacements: [...replacements] };
  tea.handle({ kind: "input_events", events: [..."/new"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const afterNew = [...replacements];
  replacements.length = 0;
  tea.handle({ kind: "input_events", events: [..."/new fix login"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  const afterRemainder = [...replacements];

  const busy = localClient();
  const calls: RpcCall[] = [];
  const busyReplacements: Array<{ path: string; draft?: string }> = [];
  busy.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  busy.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
  });
  using busyTea = new Tea(busy, () => undefined, {
    replaceSession: (opts) => {
      busyReplacements.push(opts);
    },
  });
  const turnId = busy.sessionRoot.head!.uuid;
  busyTea.handle({ kind: "input_events", events: [..."/new"].map((key) => ({ key })) });
  busyTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => busyReplacements.length === 1);
  expect({
    afterQuit,
    afterNew,
    afterRemainder,
    busy: { calls, replacements: busyReplacements, cancelRequested: busy.sessionRoot.head?.cancelRequested },
  }).toEqual({
    afterQuit: { quits: [1], replacements: [] },
    afterNew: [{ path: "/tmp/p" }],
    afterRemainder: [{ path: "/tmp/p", draft: "fix login" }],
    busy: {
      calls: [{ method: "turn/cancel", params: { turnId } }],
      replacements: [{ path: "/tmp/p" }],
      cancelRequested: false,
    },
  });
});

test("Tea /new with another window on the session does not cancel the shared turn", async () => {
  const shared = localClient();
  const calls: RpcCall[] = [];
  const replacements: Array<{ path: string; draft?: string }> = [];
  shared.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  shared.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
  });
  publishKernelSeat(shared.kernelPlexus.awareness, shared.sessionId);
  const peer = new PlexusAwareness(new Y.Doc());
  const stop = forwardPlexusAwareness(peer, (frame) => ingestPlexusAwareness(shared.kernelPlexus.awareness, frame));
  publishKernelSeat(peer, shared.sessionId);
  using tea = new Tea(shared, () => undefined, {
    replaceSession: (opts) => {
      replacements.push(opts);
    },
  });
  tea.handle({ kind: "input_events", events: [..."/new"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  expect({
    calls,
    replacements,
    cancelRequested: shared.sessionRoot.head?.cancelRequested,
  }).toEqual({
    calls: [],
    replacements: [{ path: "/tmp/p" }],
    cancelRequested: false,
  });
  stop();
  peer.destroy();
});

test("bootComposerDraft seeds /connect when no completion wire", () => {
  const openai = new DriverSpec({
    name: "openai-compat",
    importPath: "test:openai",
    abilityClaim: ["completion"],
  });
  const mcp = new DriverSpec({ name: "mcp", importPath: "test:mcp", abilityClaim: ["mcp"] });
  const work = new ConnectionSpec({ driver: openai, name: "Work" });
  const gmail = new ConnectionSpec({ driver: mcp, name: "gmail" });
  expect({
    empty: bootComposerDraft(undefined, []),
    blank: bootComposerDraft("", []),
    carried: bootComposerDraft("fix login", []),
    mcpOnly: bootComposerDraft(undefined, [gmail]),
    completion: bootComposerDraft(undefined, [work]),
    carriedOnWire: bootComposerDraft("fix login", [work]),
  }).toEqual({
    empty: "/connect",
    blank: "/connect",
    carried: "fix login",
    mcpOnly: "/connect",
    completion: undefined,
    carriedOnWire: "fix login",
  });
});

test("Tea catalog Enter on /new mints without a second Enter", async () => {
  const replacements: Array<{ path: string; draft?: string; sessionId?: string }> = [];
  const client = localClient();
  using tea = new Tea(client, () => undefined, {
    replaceSession: (opts) => {
      replacements.push(opts);
    },
  });
  tea.handle({ kind: "input_events", events: [..."/"].map((key) => ({ key })) });
  await waitForRow(tea, "/new");
  tea.handle({ kind: "picker_activate", key: "catalog:new" });
  expect({ replacements, draft: tea.draft.draft }).toEqual({
    replacements: [{ path: "/tmp/p" }],
    draft: "",
  });
});

test("Tea Enter on /rename fires rename and clears", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    const title =
      typeof params === "object" && params !== null && "title" in params && typeof params.title === "string"
        ? params.title
        : "";
    client.sessionRoot.manualTitle = clampChars(title, SESSION_TITLE_MAX_CHARS);
    return { ok: true, title };
  };
  using tea = new Tea(client, () => undefined);
  tea.handle({
    kind: "input_events",
    events: [..."/rename Auth refactor"].map((key) => ({ key })),
  });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "rename"));
  expect({
    calls,
    draft: tea.draft.draft,
    title: tea.sessionTitle,
  }).toEqual({
    calls: [{ method: "rename", params: { title: "Auth refactor" } }],
    draft: "",
    title: "Auth refactor",
  });

  tea.handle({
    kind: "input_events",
    events: [..."/rename --auto"].map((key) => ({ key })),
  });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 2);
  expect({
    calls,
    title: tea.sessionTitle,
  }).toEqual({
    calls: [
      { method: "rename", params: { title: "Auth refactor" } },
      { method: "rename", params: { title: "" } },
    ],
    title: "",
  });
});

test("update_metadata claims the composer title without manualTitle", () => {
  const client = localClient();
  using tea = new Tea(client, () => undefined);
  const empty = tea.sessionTitle;
  const job = new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: "m1",
    name: "update_metadata",
    argsJson: JSON.stringify({ current_turn_title: "From scheme", current_turn_description: "" }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [job],
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(job);
  client.sessionRoot.head = turn;
  const fromScheme = tea.sessionTitle;
  client.sessionRoot.manualTitle = "Auth refactor";
  const manual = tea.sessionTitle;
  client.sessionRoot.manualTitle = "";
  expect({
    empty,
    fromScheme,
    manual,
    clearedManual: tea.sessionTitle,
  }).toEqual({
    empty: "",
    fromScheme: "From scheme",
    manual: "Auth refactor",
    clearedManual: "From scheme",
  });
});

test("first prompt is not a claimed composer title", () => {
  const client = localClient();
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hello`,
    reducerExited: true,
    queue: [],
  });
  client.sessionRoot.head = turn;
  using tea = new Tea(client, () => undefined);
  expect(tea.sessionTitle).toBe("");
});

test("Tea park confirm drop accept", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "connect/drop") {
      return { form: "ui", pending: "p1", body: '(harness/confirm :title "Remove work?")' };
    }
    return { ok: true };
  };
  client.kernelRoot.commands = { go: parkChoice("connect/drop", { id: "work" }) };
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [..."/go"].map((key) => ({ key })) });
  await waitForRow(tea, "row");
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === 1 && tea.callbackSurface?.name === "Remove work?");
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "ui/resolve"));
  expect(calls).toEqual([
    { method: "connect/drop", params: { id: "work" } },
    { method: "ui/resolve", params: { pending: "p1", kind: "accept" } },
  ]);
});

/** A browser-sign-in park: the daemon owns the callback, the client opens the URL. */
const PASTE_PARK = (url: string) =>
  `(harness/open-url :url "${url}" :description "Authorize in the browser" :input 'password)`;

test("Tea park browser sign-in: Enter opens and answers opened, Esc cancels the wait", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  const opened: string[] = [];
  let finish: (value: unknown) => void = () => undefined;
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "connect/adopt") {
      return {
        form: "ui",
        pending: "p-url",
        body: PASTE_PARK("https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A9%2Fcallback"),
      };
    }
    if (method === "ui/resolve" && (params as { kind?: string }).kind === "opened") {
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { ok: true };
  };
  client.kernelRoot.commands = { go: parkChoice("connect/adopt", { driver: "openrouter" }) };
  using tea = new Tea(client, () => undefined, {
    open: (url) => {
      opened.push(url);
    },
  });
  tea.handle({ kind: "input_events", events: [..."/go"].map((key) => ({ key })) });
  await waitForRow(tea, "row");
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => tea.callbackSurface?.name === "Continue");
  // The field is the paste door; nothing opens until the user asks.
  expect(opened).toEqual([]);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "ui/resolve"));
  const url = "https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A9%2Fcallback";
  expect(opened).toEqual([url]);
  tea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
  await waitFor(() => calls.some((call) => (call.params as { kind?: string }).kind === "cancel"));
  finish({ ok: false });
  await waitFor(() => tea.callbackSurface === null);
  expect(calls).toEqual([
    { method: "connect/adopt", params: { driver: "openrouter" } },
    { method: "ui/resolve", params: { pending: "p-url", kind: "opened", url } },
    { method: "ui/resolve", params: { pending: "p-url", kind: "cancel" } },
  ]);
});

test("Tea park browser sign-in: typed text is the answer and nothing opens", async () => {
  const client = localClient();
  const calls: RpcCall[] = [];
  const opened: string[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "connect/adopt") {
      return { form: "ui", pending: "p-url", body: PASTE_PARK("https://openrouter.ai/auth?code_challenge=abc") };
    }
    return { id: "openrouter" };
  };
  client.kernelRoot.commands = { go: parkChoice("connect/adopt", { driver: "openrouter" }) };
  using tea = new Tea(client, () => undefined, {
    open: (url) => {
      opened.push(url);
    },
  });
  tea.handle({ kind: "input_events", events: [..."/go"].map((key) => ({ key })) });
  await waitForRow(tea, "row");
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => tea.callbackSurface?.name === "Continue");
  tea.handle({ kind: "input_events", events: [..."sk-or-pasted"].map((key) => ({ key })) });
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.some((call) => call.method === "kv/set"));
  expect({ opened, calls }).toEqual({
    opened: [],
    calls: [
      { method: "connect/adopt", params: { driver: "openrouter" } },
      { method: "ui/resolve", params: { pending: "p-url", kind: "text", input: "sk-or-pasted" } },
      { method: "kv/set", params: { key: "connection", value: "openrouter" } },
    ],
  });
});

test("Tea park Esc-cancel", async () => {
  const escClient = localClient();
  const escCalls: RpcCall[] = [];
  escClient.request = async (method, params) => {
    escCalls.push({ method, params });
    if (method === "connect/drop") {
      return { form: "ui", pending: "p3", body: '(harness/confirm :title "Remove work?")' };
    }
    return { ok: false };
  };
  escClient.kernelRoot.commands = { go: parkChoice("connect/drop", { id: "work" }) };
  using escTea = new Tea(escClient, () => undefined);
  escTea.handle({ kind: "input_events", events: [..."/go"].map((key) => ({ key })) });
  await waitForRow(escTea, "row");
  escTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => escCalls.length === 1);
  await waitFor(() => {
    escTea.handle({ kind: "input_events", events: [{ key: "Escape" }] });
    return escCalls.some((call) => call.method === "ui/resolve");
  });
  expect(escCalls).toEqual([
    { method: "connect/drop", params: { id: "work" } },
    { method: "ui/resolve", params: { pending: "p3", kind: "cancel" } },
  ]);
});

test("Tea park Nous Portal device-code", async () => {
  const nousClient = localClient();
  const nousOpened: string[] = [];
  const nousCalls: RpcCall[] = [];
  nousClient.request = async (method, params) => {
    nousCalls.push({ method, params });
    if (method === "connect/adopt") {
      return {
        form: "ui",
        pending: "p-nous",
        body: `(harness/open-url :url "https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH" :description "Approve Nous Portal in the browser, then continue")`,
      };
    }
    return { id: "nous-portal" };
  };
  nousClient.kernelRoot.commands = { go: parkChoice("connect/adopt", { driver: "nous" }) };
  using nousTea = new Tea(nousClient, () => undefined, {
    open: (url) => {
      nousOpened.push(url);
    },
  });
  nousTea.handle({ kind: "input_events", events: [..."/go"].map((key) => ({ key })) });
  await waitForRow(nousTea, "row");
  nousTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => nousOpened.length > 0);
  expect(nousOpened).toEqual(["https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH"]);
  nousTea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => nousCalls.some((call) => call.method === "kv/set") && nousTea.draft.draft === "/model");
  expect(nousCalls).toEqual([
    { method: "connect/adopt", params: { driver: "nous" } },
    {
      method: "ui/resolve",
      params: {
        pending: "p-nous",
        kind: "opened",
        url: "https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH",
      },
    },
    { method: "kv/set", params: { key: "connection", value: "nous-portal" } },
  ]);
  expect(nousTea.draft.draft).toBe("/model");
});

type PickWireRow = {
  draft: string;
  picker?: string;
  seed: (client: Client) => void;
  reply?: unknown;
  applyKv?: boolean;
  expected: RpcCall[];
};

async function playPickWire(row: PickWireRow): Promise<RpcCall[]> {
  const client = localClient();
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (row.applyKv === true && method === "kv/set" && typeof params === "object" && params !== null) {
      const rec = params as { key?: unknown; value?: unknown };
      if (typeof rec.key === "string" && typeof rec.value === "string") {
        client.sessionRoot.applyKvs([{ form: "kv-set", key: rec.key, value: rec.value }]);
      }
    }
    return row.reply;
  };
  row.seed(client);
  using tea = new Tea(client, () => undefined);
  tea.handle({ kind: "input_events", events: [...row.draft].map((key) => ({ key })) });
  if (row.picker !== undefined) await waitForRow(tea, row.picker);
  tea.handle({ kind: "input_events", events: [{ key: "Enter" }] });
  await waitFor(() => calls.length === row.expected.length);
  return calls;
}

function parkChoice(op: string, params: Record<string, string>): CommandSpec {
  const entries = Object.entries(params)
    .map(([key, value]) => `:${key} "${value}"`)
    .join(" ");
  return new CommandSpec({
    verb: "go",
    body: `(harness/choice :choices (list
             (harness/choice :name "row"
               :action (list (harness/action '${op} :params (dict ${entries}))))))`,
  });
}

function defaultCommandSpec(verb: "connect" | "model" | "mcp"): CommandSpec {
  const rec = defaultCommands().find((row) => row.verb === verb);
  if (rec === undefined) throw new Error(`missing default command ${verb}`);
  return new CommandSpec({
    verb: rec.verb,
    description: rec.description,
    source: rec.source,
    body: rec.body,
  });
}

function defaultCommandBody(verb: "connect" | "model" | "mcp"): string {
  return defaultCommandSpec(verb).body;
}

function ackTurnCancel(turn: SessionTurn): void {
  turn.cancelRequested = true;
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null && pew.outcome == null) {
      pew.fail("cancel", "terminate", "null");
    }
  }
  turn.cancelled = true;
  turn.reducerExited = true;
}

function closedTurn(outcome: "successful" | "failed"): SessionTurn {
  const chunk = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`hi` });
  chunk.outcome = outcome;
  if (outcome === "failed") chunk.endDetail = "boom";
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    reducerExited: true,
    doneWork: [new CompletionJob({ expectation: chunk })],
    queue: [],
  });
}

function localClient(): Client {
  return new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot()),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
}

async function waitForRow(tea: Tea, name: string): Promise<void> {
  await waitFor(() => (tea.commandChoices ?? []).some((row) => row.name === name));
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The painted state of the first completion on the tape. */
function paintedCompletionState(tea: Tea): unknown {
  tea.flushPaint();
  const walk = (node: object): unknown => {
    if ("kind" in node && node.kind === "completion" && "state" in node) return node.state;
    for (const child of paintChildrenOf(node as Parameters<typeof paintChildrenOf>[0])) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(tea.paintRoot);
}
