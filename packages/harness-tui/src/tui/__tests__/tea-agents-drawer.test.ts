/**
 * Agents drawer chords. Unique failure: leftover ← after Esc-clear
 * opens the drawer, or Enter mints while the drawer is open.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  AgentCallNotification,
  BotCallJob,
  KernelPlexus,
  KernelRoot,
  ProgrammaticJob,
  SessionOverview,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { Client, ProjectPlexus } from "@inhuman.tools/harness-sdk";
import { expect, test } from "vitest";

import { prepareAgentsPeek } from "../agents-drawer.js";
import type { AgentsPaintInstance, ComposerPaintInstance } from "../paint-dom.js";
import { Tea } from "../tea.js";

type RpcCall = { method: string; params: unknown };

function localClient(): Client {
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  seedLiveAgents(client);
  seedSessions(client);
  return client;
}

function seedSessions(client: Client): void {
  client.projectRoot.sessions[client.sessionId] = "";
  client.projectRoot.sessions["s-auth"] = "";
  client.kernelRoot.sessions[client.sessionId] = new SessionOverview({
    title: "Here",
    lastMessageAt: 20,
  });
  client.kernelRoot.sessions["s-auth"] = new SessionOverview({
    title: "Auth refactor",
    lastMessageAt: 10,
  });
}

function seedLiveAgents(client: Client): void {
  const explore = new AgentCallJob({
    toolCallId: "call-explore",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "explore", message: "map the repo" }),
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
  client.kernelRoot.sessions["w-chief"] = new SessionOverview({
    specName: "chief",
    recipeScope: "session",
    keepAlive: true,
  });
  client.kernelRoot.sessions["w-explore"] = new SessionOverview({
    specName: "explore",
    status: "mapping",
    midMotion: true,
    oneShot: true,
  });
  client.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    doneWork: [explore, chief],
    queue: [],
  });
}

function spy(client: Client): RpcCall[] {
  const calls: RpcCall[] = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  return calls;
}

function press(tea: Tea, ...keys: Array<string | { key: string; ctrl?: boolean; shift?: boolean }>): void {
  tea.handle({
    kind: "input_events",
    events: keys.map((key) => (typeof key === "string" ? { key } : key)),
  });
  tea.flushPaint();
}

function typeText(tea: Tea, text: string): void {
  press(tea, ...text);
}

function agentsOf(tea: Tea): AgentsPaintInstance | null {
  for (const child of tea.paintRoot.children) {
    if (child.kind === "agents") return child as AgentsPaintInstance;
  }
  return null;
}

function composerOf(tea: Tea): ComposerPaintInstance {
  const composer = tea.paintRoot.children.find((child) => child.kind === "composer");
  if (composer === undefined) throw new Error("composer not found");
  return composer as ComposerPaintInstance;
}

test("only left on an empty input opens; drawer focus disables and protects the composer", async () => {
  const client = localClient();
  const calls = spy(client);
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();

  typeText(tea, "keep me");
  press(tea, "ArrowLeft");
  expect({
    draft: tea.draft.draft,
    cursor: tea.draft.cursor,
    open: agentsOf(tea)?.open ?? false,
  }).toEqual({ draft: "keep me", cursor: 6, open: false });

  press(tea, "Escape", "Escape", "ArrowLeft");
  expect({
    draft: tea.draft.draft,
    open: agentsOf(tea)?.open ?? false,
    focus: agentsOf(tea)?.focusKey,
    composerInteractive: composerOf(tea).interactive,
  }).toEqual({
    draft: "",
    open: true,
    focus: "call:call-explore",
    composerInteractive: false,
  });

  typeText(tea, "not input");
  const policy = client.sessionRoot.permissionMode;
  press(tea, { key: "Tab", shift: true });
  press(tea, "ArrowDown");
  press(tea, "Enter");
  expect({
    draft: tea.draft.draft,
    policy: client.sessionRoot.permissionMode,
    focus: agentsOf(tea)?.focusKey,
    open: agentsOf(tea)?.open,
    calls,
  }).toEqual({
    draft: "",
    policy,
    focus: "bot:w-chief",
    open: true,
    calls: [],
  });

  press(tea, "ArrowRight");
  expect({
    open: agentsOf(tea)?.open ?? false,
    interactive: composerOf(tea).interactive,
  }).toEqual({ open: false, interactive: true });

  press(tea, "ArrowLeft");
  tea.handle({ kind: "activate", key: "agents:overlay:backdrop" });
  tea.flushPaint();
  expect({
    open: agentsOf(tea)?.open ?? false,
    interactive: composerOf(tea).interactive,
  }).toEqual({ open: false, interactive: true });

  typeText(tea, "/");
  press(tea, "ArrowLeft");
  expect({
    open: agentsOf(tea)?.open ?? false,
    draft: tea.draft.draft,
  }).toEqual({ open: false, draft: "/" });
});

test("ask cover wins over the drawer", () => {
  const client = localClient();
  const leaf = new SystemToolJob({
    toolCallId: "ask-1",
    name: "edit_file",
    argsJson: JSON.stringify({ path: "a.ts" }),
    policyResult: "ask",
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`edit`,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  client.sessionRoot.head = turn;
  tea.flushPaint();
  press(tea, "ArrowLeft");
  expect(agentsOf(tea)?.open ?? false).toBe(false);
});

test("scheme bag is not a drawer row", () => {
  const client = localClient();
  const nested = new BotCallJob({
    toolCallId: "call-qa",
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "qa", message: "check" }),
    workerSessionId: "w-qa",
  });
  const bag = new ProgrammaticJob({
    toolCallId: "bag-qa",
    background: true,
    argsJson: JSON.stringify({ expr: "(parallel)" }),
  });
  bag.pushInvocation(nested);
  const explore = new AgentCallJob({
    toolCallId: "call-explore",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "explore", message: "map" }),
    workerSessionId: "w-explore",
  });
  client.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    doneWork: [bag, explore],
    queue: [],
  });
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  press(tea, "ArrowLeft");
  const opened = agentsOf(tea)?.focusKey;
  press(tea, "j");
  expect({ opened, next: agentsOf(tea)?.focusKey }).toEqual({
    opened: "call:call-qa",
    next: "call:call-explore",
  });
});

test("Enter or activate on another session restores it; this session just closes", () => {
  const client = localClient();
  const replacements: Array<{ path: string; sessionId?: string }> = [];
  using tea = new Tea(client, () => undefined, {
    replaceSession: (opts) => {
      replacements.push({ path: opts.path, sessionId: opts.sessionId });
    },
  });
  tea.flushPaint();
  press(tea, "ArrowLeft");
  for (let i = 0; i < 24; i++) {
    if (agentsOf(tea)?.focusKey === "session:s-auth") break;
    press(tea, "j");
  }
  press(tea, "Enter");
  const enter = [...replacements];
  replacements.length = 0;
  tea.handle({ kind: "activate", key: "session:s-auth:name" });
  const activate = [...replacements];
  replacements.length = 0;
  tea.handle({ kind: "activate", key: `session:${client.sessionId}` });
  tea.flushPaint();
  expect({
    enter,
    activate,
    self: { replacements, open: agentsOf(tea)?.open ?? false },
  }).toEqual({
    enter: [{ path: "/tmp/p", sessionId: "s-auth" }],
    activate: [{ path: "/tmp/p", sessionId: "s-auth" }],
    self: { replacements: [], open: false },
  });
});

test("hover focuses a session and does not swap", () => {
  const client = localClient();
  const replacements: Array<{ sessionId?: string }> = [];
  using tea = new Tea(client, () => undefined, {
    replaceSession: (opts) => {
      replacements.push({ sessionId: opts.sessionId });
    },
  });
  tea.flushPaint();
  press(tea, "ArrowLeft");
  tea.handle({ kind: "agents_hover", key: `session:${client.sessionId}` });
  tea.flushPaint();
  const hovered = agentsOf(tea)?.focusKey;
  press(tea, "j");
  expect({
    hovered,
    afterJ: agentsOf(tea)?.focusKey,
    replacements,
    open: agentsOf(tea)?.open,
  }).toEqual({
    hovered: `session:${client.sessionId}`,
    afterJ: "session:s-auth",
    replacements: [],
    open: true,
  });
});

test("hover focuses a live subagent and peeks recap ask notify model", () => {
  const client = localClient();
  const explore = client.agentCalls.find((call) => call.toolCallId === "call-explore");
  if (explore == null) throw new Error("missing explore call");
  explore.notifications.push(new AgentCallNotification({ message: "found auth" }));
  client.kernelRoot.sessions["w-explore"] = new SessionOverview({
    specName: "explore",
    status: "mapping the repo",
    model: "haiku",
    lastPrompt: "map the repo",
    unfinished: "ask",
    askLine: "confirm shell command?",
    asking: true,
    oneShot: true,
  });
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  press(tea, "ArrowLeft");
  tea.handle({ kind: "agents_hover", key: "call:call-explore:name" });
  tea.flushPaint();
  const hovered = agentsOf(tea)!;
  const hoveredKey = hovered.focusKey;
  const peek = prepareAgentsPeek({
    meterLeft: hovered.meterLeft,
    meterRight: hovered.meterRight,
    open: hovered.open,
    focusKey: hoveredKey,
    scroll: hovered.scroll,
    rows: hovered.rows,
    previewKey: hovered.previewKey,
  });
  const row = hovered.rows.find((item) => item.key === "call:call-explore");
  press(tea, "j");
  expect({
    hovered: hoveredKey,
    afterJ: agentsOf(tea)?.focusKey,
    row: {
      recap: row?.recap,
      model: row?.model,
      askLine: row?.askLine,
      result: row?.result,
      notifies: row?.notifies,
    },
    peekKeys: peek && "children" in peek ? peek.children?.map((child) => child.key) : null,
  }).toEqual({
    hovered: "call:call-explore",
    afterJ: "bot:w-chief",
    row: {
      recap: "mapping the repo",
      model: "haiku",
      askLine: "confirm shell command?",
      result: "",
      notifies: ["found auth"],
    },
    peekKeys: ["agents:peek:status", "agents:peek:ask", "agents:peek:notify", "agents:peek:gap", "agents:peek:model"],
  });
});

test("session peek paints glance fields and hides on the current session", () => {
  const client = localClient();
  client.kernelRoot.sessions["s-auth"] = new SessionOverview({
    title: "Auth refactor",
    lastMessageAt: 10,
    model: "sonnet",
    lastPrompt: "rotate the cookie",
    status: "cookie rotate",
    unfinished: "ask",
    askLine: "confirm shell command?",
    asking: true,
  });
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  press(tea, "ArrowLeft");
  for (let i = 0; i < 24; i++) {
    if (agentsOf(tea)?.focusKey === "session:s-auth") break;
    press(tea, "j");
  }
  const other = agentsOf(tea)!;
  const otherPeek = prepareAgentsPeek({
    meterLeft: other.meterLeft,
    meterRight: other.meterRight,
    open: other.open,
    focusKey: other.focusKey,
    scroll: other.scroll,
    rows: other.rows,
    previewKey: other.previewKey,
  });
  for (let i = 0; i < 24; i++) {
    if (agentsOf(tea)?.focusKey === `session:${client.sessionId}`) break;
    press(tea, "k");
  }
  const self = agentsOf(tea)!;
  const selfPeek = prepareAgentsPeek({
    meterLeft: self.meterLeft,
    meterRight: self.meterRight,
    open: self.open,
    focusKey: self.focusKey,
    scroll: self.scroll,
    rows: self.rows,
    previewKey: self.previewKey,
  });
  const auth = other.rows.find((row) => row.key === "session:s-auth");
  expect({
    auth: {
      recap: auth?.recap,
      model: auth?.model,
      current: auth?.current,
    },
    otherKeys: otherPeek && "children" in otherPeek ? otherPeek.children?.map((child) => child.key) : null,
    selfPeek,
  }).toEqual({
    auth: {
      recap: "cookie rotate",
      model: "sonnet",
      current: false,
    },
    otherKeys: ["agents:peek:status", "agents:peek:gap", "agents:peek:model"],
    selfPeek: null,
  });
});

test("Enter on a subagent opens sneak-peek; Esc closes it; other keys stay inert", () => {
  const client = localClient();
  const worker = SessionPlexus.create("w-explore", "/tmp/p");
  worker.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`map the repo`,
    doneWork: [],
    queue: [],
  });
  client.adoptPeek(worker);
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  press(tea, "ArrowLeft");
  press(tea, "Enter");
  tea.flushPaint();
  const openedAgents = agentsOf(tea);
  const preview = tea.paintRoot.children.find((child) => child.kind === "preview");
  const promptNode = preview?.kind === "preview" ? preview.children[0]?.children[0] : undefined;
  const opened = {
    previewKey: openedAgents?.previewKey,
    focus: openedAgents?.focusKey,
    peek: openedAgents
      ? prepareAgentsPeek({
          meterLeft: openedAgents.meterLeft,
          meterRight: openedAgents.meterRight,
          open: openedAgents.open,
          focusKey: openedAgents.focusKey,
          scroll: openedAgents.scroll,
          rows: openedAgents.rows,
          previewKey: openedAgents.previewKey,
        })
      : null,
    tape: promptNode?.kind === "speech" ? { voice: promptNode.voice, text: promptNode.text } : promptNode?.kind,
  };
  press(tea, "j");
  press(tea, "ArrowRight");
  const during = {
    focus: agentsOf(tea)?.focusKey,
    open: agentsOf(tea)?.open,
    previewKey: agentsOf(tea)?.previewKey,
  };
  press(tea, "Escape");
  tea.flushPaint();
  const afterEsc = {
    previewKey: agentsOf(tea)?.previewKey,
    open: agentsOf(tea)?.open,
    preview: tea.paintRoot.children.some((child) => child.kind === "preview"),
  };
  tea.handle({ kind: "activate", key: "call:call-explore:name" });
  tea.flushPaint();
  expect({
    opened,
    during,
    afterEsc,
    viaClick: agentsOf(tea)?.previewKey,
  }).toEqual({
    opened: {
      previewKey: "call:call-explore",
      focus: "call:call-explore",
      peek: null,
      tape: { voice: "user", text: "map the repo" },
    },
    during: {
      focus: "call:call-explore",
      open: true,
      previewKey: "call:call-explore",
    },
    afterEsc: { previewKey: "", open: true, preview: false },
    viaClick: "call:call-explore",
  });
});

test("click outside sneak-peek closes it; drawer stays open", () => {
  const client = localClient();
  const worker = SessionPlexus.create("w-explore", "/tmp/p");
  worker.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`map the repo`,
    doneWork: [],
    queue: [],
  });
  client.adoptPeek(worker);
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  press(tea, "ArrowLeft");
  press(tea, "Enter");
  tea.flushPaint();
  tea.handle({ kind: "activate", key: "agents:preview-overlay:backdrop" });
  tea.flushPaint();
  expect({
    previewKey: agentsOf(tea)?.previewKey,
    open: agentsOf(tea)?.open,
    preview: tea.paintRoot.children.some((child) => child.kind === "preview"),
  }).toEqual({ previewKey: "", open: true, preview: false });
});

test("a click on a finished subagent mention opens sneak-peek; the drawer stays closed", () => {
  const client = new Client(
    "/tmp/k",
    "/tmp/p",
    "s",
    KernelPlexus.bootstrap(new KernelRoot({ approvalAskThrottleMs: 0 })),
    ProjectPlexus.create("/tmp/p"),
    SessionPlexus.create("s", "/tmp/p"),
  );
  const done = new AgentCallJob({
    toolCallId: "call-done",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "qa", message: "check the edge" }),
    workerSessionId: "w-done",
  });
  done.completed = true;
  done.receiptJson = JSON.stringify({ ok: true, text: "checked" });
  client.sessionRoot.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    doneWork: [done],
    queue: [],
  });
  const worker = SessionPlexus.create("w-done", "/tmp/p");
  worker.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`check the edge`,
    doneWork: [],
    queue: [],
  });
  client.adoptPeek(worker);
  using tea = new Tea(client, () => undefined);
  tea.flushPaint();
  expect(agentsOf(tea)?.rows.some((row) => row.key === "call:call-done") ?? false).toBe(false);
  tea.handle({ kind: "activate", key: "mention:call-done" });
  tea.flushPaint();
  const promptNode = tea.paintRoot.children.find((child) => child.kind === "preview")?.children[0]?.children[0];
  const opened = {
    previewKey: agentsOf(tea)?.previewKey,
    open: agentsOf(tea)?.open ?? false,
    row: agentsOf(tea)?.rows.some((row) => row.key === "call:call-done") ?? false,
    tape: promptNode?.kind === "speech" ? promptNode.text : promptNode?.kind,
  };
  press(tea, "Escape");
  tea.flushPaint();
  expect({
    opened,
    afterEsc: {
      previewKey: agentsOf(tea)?.previewKey ?? "",
      open: agentsOf(tea)?.open ?? false,
      preview: tea.paintRoot.children.some((child) => child.kind === "preview"),
    },
  }).toEqual({
    opened: {
      previewKey: "call:call-done",
      open: false,
      row: false,
      tape: "check the edge",
    },
    afterEsc: { previewKey: "", open: false, preview: false },
  });
});
