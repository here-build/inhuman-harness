/**
 * Frozen worlds for stories: real plexus documents built locally, the way the
 * daemon would have left them, and a dial that serves them without a socket.
 *
 * A world is plain construction. Build the models, bootstrap each document,
 * and hand the dial the result; nothing here imitates the reducer or the
 * daemon's timing. A story that wants a later state mutates the same models.
 */
import type { RegionGraph } from "@here.build/arrival-provenance";
import { Plexus } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  AgentCallNotification,
  CompletionExpectation,
  CompletionJob,
  FailureOutcome,
  FileMutateToolJob,
  BotSpec,
  KernelPlexus,
  KernelRoot,
  ProgrammaticJob,
  SessionOverview,
  SessionPlexus,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
  type ToolCallJob,
  TurnNotificationChunk,
  type SessionUnfinished,
  type TurnChunk,
} from "@inhuman.tools/harness-model";
import { resolvedTip } from "@inhuman.tools/harness-model/session";
import { ProjectPlexus } from "@inhuman.tools/harness-peer";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { makeObservable, observable, runInAction } from "mobx";

import { serveWorkflow, type WorkflowRun } from "./workflow-world.js";
import type { Dial, Link } from "../client/dial.js";
import type { RouteTarget } from "../shell/path.js";
import { turnsOldestFirst } from "../shell/tape-read.js";

export const PROJECT = "/Users/ada/work/harness";
export const OTHER_PROJECT = "/Users/ada/work/kley";

/* Jobs: one builder per thing a turn can hold. */

type ToolOptions = {
  /** The result text. Omit with `live` for a call still running. */
  readonly result?: string;
  readonly value?: unknown;
  readonly failed?: boolean;
  readonly live?: boolean;
};

function outcome(options: ToolOptions): string | null {
  if (options.live === true) return null;
  if (options.value !== undefined) return JSON.stringify({ ok: options.failed !== true, value: options.value });
  return JSON.stringify({ ok: options.failed !== true, text: options.result ?? "" });
}

export function tool(name: string, args: Record<string, unknown>, options: ToolOptions = {}): SystemToolJob {
  return new SystemToolJob({
    name,
    argsJson: JSON.stringify(args),
    completed: options.live !== true,
    outcomeJson: outcome(options),
  });
}

export const read = (path: string, text: string, options: Omit<ToolOptions, "result"> = {}) =>
  tool("read_file", { path }, { ...options, result: text });
export const listDir = (path: string, entries: readonly string[]) =>
  tool("list_dir", { path }, { result: entries.join("\n") });
export const grep = (pattern: string, matches: readonly string[], options: { path?: string } & ToolOptions = {}) =>
  tool(
    "grep",
    { pattern, ...(options.path == null ? {} : { path: options.path }) },
    { result: matches.join("\n"), ...options },
  );
export const glob = (pattern: string, paths: readonly string[], options: ToolOptions = {}) =>
  tool("glob", { pattern }, { result: paths.join("\n"), ...options });

export function shell(
  command: string,
  output: string,
  options: { readonly exitCode?: number; readonly cwd?: string; readonly live?: boolean } = {},
): SystemToolJob {
  return tool(
    "shell",
    { command, ...(options.cwd == null ? {} : { cwd: options.cwd }) },
    options.live === true
      ? { live: true }
      : {
          value: { stdout: output, stderr: "", exitCode: options.exitCode ?? 0 },
          failed: (options.exitCode ?? 0) !== 0,
        },
  );
}

export function edit(
  path: string,
  prior: string,
  oldString: string,
  newString: string,
  options: { readonly live?: boolean } = {},
): FileMutateToolJob {
  return new FileMutateToolJob({
    name: "edit_file",
    argsJson: JSON.stringify({ path, old_string: oldString, new_string: newString }),
    completed: options.live !== true,
    outcomeJson: options.live === true ? null : JSON.stringify({ ok: true, text: `edited ${path}` }),
    existed: true,
    priorContent: prior,
  });
}

export function write(
  path: string,
  content: string,
  options: { readonly prior?: string; readonly failed?: string } = {},
) {
  return new FileMutateToolJob({
    name: "write_file",
    argsJson: JSON.stringify({ path, content }),
    completed: true,
    outcomeJson: JSON.stringify(
      options.failed == null ? { ok: true, text: `wrote ${path}` } : { ok: false, text: options.failed },
    ),
    existed: options.prior != null,
    priorContent: options.prior ?? null,
  });
}

/** A round of speech: what the model said, what it thought first, which model said it. */
export function speech(
  text: string,
  options: { readonly thought?: string; readonly model?: string; readonly connection?: string } = {},
): CompletionJob {
  const expectation = new CompletionExpectation({ connectionId: options.connection ?? "chatgpt" });
  expectation.model = options.model ?? "gpt-6.1-sol";
  expectation.responseText = text;
  expectation.responseThought = options.thought ?? "";
  return new CompletionJob({ expectation });
}

/** The left lane's title and description: the call the model makes to name its stretch of work. */
export function title(name: string, description = ""): SystemToolJob {
  return new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    name: "update_metadata",
    argsJson: JSON.stringify({ current_turn_title: name, current_turn_description: description }),
    completed: true,
  });
}

export const task = (
  verb: "create" | "start" | "drop" | "validate",
  taskId: string,
  extra: Record<string, unknown> = {},
) => tool(`task__${verb}`, { taskId, ...extra }, { result: "ok" });
export const goal = (objective: string) => tool("goal__set", { objective }, { result: "ok" });

/** A scheme batch and the calls it made, sealed. A `live` one is still running. */
export function scheme(
  expr: string,
  calls: readonly ToolCallJob[],
  description = "",
  options: { readonly live?: boolean } = {},
): ProgrammaticJob {
  const live = options.live === true;
  const job = new ProgrammaticJob({
    toolCallId: `scheme-${expr.length}`,
    toolName: "scheme_repl",
    argsJson: JSON.stringify({ expr, ...(description === "" ? {} : { description }) }),
    outcomeJson: live ? null : JSON.stringify({ ok: true, value: ["#t"] }),
    completed: !live,
  });
  for (const call of calls) job.pushInvocation(call);
  return job;
}

/**
 * An agent this session spawned. `worker` is the session the kernel glances.
 * A background call (the default) leaves its result as a notification for
 * {@link settled} to claim; a call that waited closes in its own round.
 */
export function agent(
  spec: string,
  message: string,
  options: {
    readonly worker: string;
    readonly background?: boolean;
    readonly live?: boolean;
    readonly failed?: string;
    readonly cancelled?: boolean;
  },
): AgentCallJob {
  const background = options.background ?? true;
  const job = new AgentCallJob({
    toolCallId: `call-${options.worker}`,
    name: background ? "agent__send" : "agent__ask",
    argsJson: JSON.stringify({ spec, message }),
    workerSessionId: options.worker,
    background,
    voidLegal: background,
    cancelled: options.cancelled === true,
    completed: options.live !== true,
  });
  if (options.live === true) return job;
  if (options.failed != null) job.outcome = new FailureOutcome({ message: options.failed });
  else if (options.cancelled !== true) job.outcome = new SuccessfulOutcome({ valueJson: JSON.stringify("done") });
  if (background) {
    job.notifications.push(new AgentCallNotification({ message: `job ${job.toolCallId} finished`, result: true }));
  }
  return job;
}

/** A round taking in background results: the notifications the daemon claims onto a turn. */
export function settled(...calls: readonly AgentCallJob[]): TurnNotificationChunk {
  return new TurnNotificationChunk({
    notifications: calls.flatMap((call) => call.notifications.filter((n) => n.result)),
  });
}

/* Turns and sessions. */

export type TurnSpec = {
  readonly prompt: string;
  readonly work: readonly TurnChunk[];
  /** The executor is still inside the turn. */
  readonly live?: boolean;
  /** A question the model left for you when the turn ended. */
  readonly question?: string;
};

/** A call the policy sent to the human: it waits on the composer's cover. Build it `live`. */
export function asking<T extends SystemToolJob>(job: T): T {
  if (job.completed) throw new Error("an ask is a call that has not run: build it live");
  job.policyResult = "ask";
  return job;
}

export function turn(spec: TurnSpec, tail: SessionTurn | SessionSystemPrompt = new SessionSystemPrompt()): SessionTurn {
  const made = new SessionTurn({
    turnTail: tail,
    prompt: prompt.user`${spec.prompt}`,
    queue: [],
    doneWork: [...spec.work],
    reducerExited: spec.live !== true,
    permissionMode: "manual",
    questionLine: spec.question ?? "",
  });
  for (const chunk of made.doneWork) made.pushChild(chunk);
  return made;
}

export type SessionSpec = {
  readonly id: string;
  readonly project?: string;
  /** A manual rename. Without one the title comes from the tape, as it does live. */
  readonly title?: string;
  readonly turns: readonly TurnSpec[];
  readonly kvs?: Readonly<Record<string, string>>;
};

export function session(spec: SessionSpec): SessionPlexus {
  const root = new SessionRoot({ sessionId: spec.id, path: spec.project ?? PROJECT });
  if (spec.title != null) root.manualTitle = spec.title;
  let head: SessionTurn | null = null;
  for (const next of spec.turns) head = turn(next, head ?? new SessionSystemPrompt());
  root.head = head;
  const plexus = Plexus.bootstrap(root) as SessionPlexus;
  if (spec.kvs != null) {
    plexus.root.applyKvs(Object.entries(spec.kvs).map(([key, value]) => ({ form: "kv-set", key, value })));
  }
  return plexus;
}

/* The kernel: connections, projects, and the glance rows the sidebar lists. */

export type WireSpec = {
  readonly id: string;
  readonly name: string;
  /** The driver it runs on; defaults to its id. */
  readonly driver?: string;
  /** Its endpoint, as `/connect` reads it to tell which offers are taken. */
  readonly baseUrl?: string;
  readonly models: readonly string[];
  readonly can?: readonly string[];
  readonly failed?: string;
  readonly identity?: Record<string, unknown>;
  readonly keyMask?: string;
  readonly account?: Record<string, unknown>;
};

const HOUR = 3600;

export const WIRES: readonly WireSpec[] = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-mini"],
    identity: { displayName: "Ada Lovelace", plan: "pro" },
    account: {
      balanceDetail: {
        windows: [
          { label: "5h", remainingPercent: 62, resetAt: now() + 3 * HOUR },
          { label: "weekly", remainingPercent: 84, resetAt: now() + 5 * 24 * HOUR },
        ],
      },
    },
  },
  {
    id: "grok",
    name: "Grok",
    models: ["grok-4.7", "grok-4.7-build-fast"],
    identity: { displayName: "ada_l" },
    account: { balanceDetail: { windows: [{ label: "weekly", remainingPercent: 10, resetAt: now() + 42 * HOUR }] } },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    models: ["anthropic/claude-opus-5.5", "x-ai/grok-4.7", "qwen/qwen4-coder"],
    keyMask: "sk-or-...8768",
    account: { balance: { balance: "74.75", currency: { code: "USD", symbol: "$" } } },
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    driver: "openai-compat",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: ["qwen4-coder-32b"],
    failed: "connect ECONNREFUSED 127.0.0.1:1234",
  },
  { id: "web", name: "Web search", models: ["search"], can: ["web-search"] },
];

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** One kernel glance row: what the daemon projects from a session it runs. */
export type GlanceRow = {
  readonly title?: string;
  readonly model?: string;
  /** What the worker last said it is doing. */
  readonly status?: string;
  readonly askLine?: string;
  readonly specName?: string;
  readonly oneShot?: boolean;
  readonly lastPrompt?: string;
  readonly at?: number;
  readonly openTurn?: boolean;
  readonly asking?: boolean;
  readonly unfinished?: SessionUnfinished;
};

/** A local server the daemon found answering on a known port. */
export type LocalServer = { readonly name: string; readonly port: number; readonly path?: string };

export type KernelSpec = {
  /** Local servers the openai-compat driver offers as live. */
  readonly local?: readonly LocalServer[];
  readonly projects?: readonly string[];
  readonly sessions?: Readonly<Record<string, GlanceRow>>;
  readonly bots?: Readonly<Record<string, string>>;
  readonly wires?: readonly WireSpec[];
};

const REMOTE_OFFERS: readonly (readonly [string, string])[] = [
  ["OpenAI", "https://api.openai.com/v1"],
  ["Groq", "https://api.groq.com/openai/v1"],
  ["DeepSeek", "https://api.deepseek.com/v1"],
  ["Mistral", "https://api.mistral.ai/v1"],
  ["Together", "https://api.together.ai/v1"],
  ["xAI", "https://api.x.ai/v1"],
  ["Gemini", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ["Fireworks", "https://api.fireworks.ai/inference/v1"],
  ["Cerebras", "https://api.cerebras.ai/v1"],
  ["Perplexity", "https://api.perplexity.ai"],
];

function offer(name: string, description: string, baseUrl: string | null, live: boolean) {
  return { name, description, live, adoptable: true, settings: baseUrl == null ? {} : { baseUrl } };
}

/** The completion drivers a daemon registers, with the offers each advertises. */
function driverCatalog(local: readonly LocalServer[]): DriverSpec[] {
  const driver = (
    name: string,
    description: string,
    multiplicity: "add-by-default" | "add-as-secondary",
    offers: readonly object[],
  ): DriverSpec => {
    const made = new DriverSpec({ name, description, abilityClaim: ["completion"], multiplicity });
    made.offers = offers;
    return made;
  };
  return [
    driver("chatgpt", "ChatGPT subscription", "add-by-default", [
      offer("ChatGPT", "ChatGPT subscription", "https://chatgpt.com/backend-api/codex", true),
    ]),
    driver("grok", "Grok subscription", "add-by-default", [
      offer("Grok", "Grok subscription", "https://cli-chat-proxy.grok.com/v1", true),
    ]),
    driver("openrouter", "OpenRouter", "add-by-default", [
      offer("OpenRouter", "OpenRouter API", "https://openrouter.ai/api/v1", true),
    ]),
    driver("nous", "Nous Portal", "add-by-default", [
      offer("Nous Portal", "Nous Research inference API", "https://inference-api.nousresearch.com/v1", true),
    ]),
    driver("openai-compat", "OpenAI-compatible", "add-as-secondary", [
      ...local.map((server) =>
        offer(
          server.name,
          `Local OpenAI-compat :${server.port}`,
          `http://127.0.0.1:${server.port}${server.path ?? "/v1"}`,
          true,
        ),
      ),
      offer("OpenAI-compatible", "Any OpenAI-compatible endpoint", null, false),
      ...REMOTE_OFFERS.map(([name, url]) => offer(name, name, url, false)),
    ]),
  ];
}

function addWire(root: KernelRoot, wire: WireSpec): void {
  const name = wire.driver ?? wire.id;
  const driver = root.drivers[name] ?? new DriverSpec({ name, abilityClaim: [...(wire.can ?? ["completion"])] });
  root.drivers[name] = driver;
  const connection = new ConnectionSpec({ driver, name: wire.name });
  if (wire.baseUrl != null) connection.configuration = { baseUrl: wire.baseUrl };
  root.connections[wire.id] = connection;
}

function stampWire(plexus: KernelPlexus, wire: WireSpec): void {
  plexus.root.connections[wire.id].stampProcess({
    readyState: wire.failed == null ? "ready" : "failed",
    error: wire.failed ?? "",
    live: {
      models: [...wire.models],
      ...(wire.identity == null ? {} : { identity: wire.identity }),
      ...(wire.keyMask == null ? {} : { keyMask: wire.keyMask }),
      ...(wire.account == null ? {} : { account: wire.account }),
    },
  });
}

export function kernel(spec: KernelSpec = {}): KernelPlexus {
  const root = new KernelRoot();
  root.approvalAskThrottleMs = 1000;
  for (const path of spec.projects ?? [PROJECT]) root.projects[path] = "";
  for (const [id, row] of Object.entries(spec.sessions ?? {})) {
    root.sessions[id] = new SessionOverview({
      title: row.title ?? "",
      lastPrompt: row.lastPrompt ?? "",
      lastMessageAt: row.at ?? Date.now(),
      openTurn: row.openTurn ?? false,
      asking: row.asking ?? false,
      unfinished: row.unfinished ?? "",
      model: row.model ?? "",
      status: row.status ?? "",
      askLine: row.askLine ?? "",
      specName: row.specName ?? "",
      oneShot: row.oneShot ?? false,
    });
  }
  for (const [name, sessionId] of Object.entries(spec.bots ?? {})) root.botsRoster[name] = sessionId;
  for (const driver of driverCatalog(spec.local ?? [])) root.drivers[driver.name] = driver;
  for (const wire of spec.wires ?? WIRES) addWire(root, wire);
  const plexus = KernelPlexus.bootstrap(root);
  for (const wire of spec.wires ?? WIRES) stampWire(plexus, wire);
  return plexus;
}

export function project(
  path: string,
  sessions: readonly string[],
  bots: Readonly<Record<string, string>> = {},
): ProjectPlexus {
  const plexus = ProjectPlexus.create(path);
  for (const id of sessions) plexus.root.sessions[id] = "";
  for (const [name, id] of Object.entries(bots)) plexus.root.botsRoster[name] = id;
  return plexus;
}

/**
 * A world around some sessions: each session's project holds it, and the
 * kernel lists it the way the daemon's glance would (its title, its prompt).
 */
export function worldOf(
  sessions: readonly SessionPlexus[],
  options: {
    readonly kernel?: Omit<KernelSpec, "sessions">;
    readonly extraSessions?: KernelSpec["sessions"];
    /** Worker sessions: the kernel glances them, no project lists them. */
    readonly workers?: KernelSpec["sessions"];
    /** Worker documents a peek opens. */
    readonly peeks?: () => readonly SessionPlexus[];
    /** Program runs the daemon would stream, by the program's `toolCallId`. */
    readonly workflows?: Readonly<Record<string, WorkflowRun>>;
    readonly refuse?: boolean;
    readonly link?: Link;
    readonly connect?: ConnectScripts;
    readonly portless?: boolean;
  } = {},
): StoryDial {
  const byProject = new Map<string, string[]>();
  for (const plexus of sessions) {
    const ids = byProject.get(plexus.root.path) ?? [];
    ids.push(plexus.root.sessionId);
    byProject.set(plexus.root.path, ids);
  }
  const extra = options.extraSessions ?? {};
  const listed = [...byProject.keys(), ...(options.kernel?.projects ?? [])];
  const paths = [...new Set(listed.length === 0 ? [PROJECT] : listed)];
  const rows: Record<string, GlanceRow> = { ...options.workers, ...extra };
  for (const [index, plexus] of sessions.entries()) {
    const head = plexus.root.head;
    // The fields the daemon's glance reads off the same root.
    rows[plexus.root.sessionId] = {
      title: plexus.root.title,
      lastPrompt: head == null ? "" : String(head.prompt),
      at: Date.now() - index * 60_000,
      openTurn: plexus.root.openTurn,
      asking: plexus.root.asking,
      unfinished: plexus.root.unfinished,
    };
  }
  return new StoryDial({
    kernel: kernel({ ...options.kernel, projects: paths, sessions: rows }),
    projects: paths.map((path) =>
      project(path, [...(byProject.get(path) ?? []), ...(path === PROJECT ? Object.keys(extra) : [])]),
    ),
    sessions,
    refuse: options.refuse === true,
    ...(options.link == null ? {} : { link: options.link }),
    ...(options.connect == null ? {} : { connect: options.connect }),
    portless: options.portless === true,
    ...(options.peeks == null ? {} : { peeks: options.peeks() }),
    ...(options.workflows == null ? {} : { workflows: options.workflows }),
  });
}

/* The dial: the same surface the frame reads, over frozen documents. */

export type WorldSpec = {
  readonly kernel: KernelPlexus | null;
  readonly projects?: readonly ProjectPlexus[];
  readonly sessions?: readonly SessionPlexus[];
  /** What the dial says about its line to the daemon. */
  readonly link?: Link;
  /** Hold every route in attaching: the frame's pending face. */
  readonly attaching?: boolean;
  /** The session port answers every write with a refusal. */
  readonly refuse?: boolean;
  /** How `connect/adopt` goes, per provider. */
  readonly connect?: ConnectScripts;
  /** The kernel replica is up but no RPC port is bound yet: nothing can be written. */
  readonly portless?: boolean;
  /** Sessions only a peek opens: workers no project lists. */
  readonly peeks?: readonly SessionPlexus[];
  /** Program runs the daemon would stream, by the program's `toolCallId`. */
  readonly workflows?: Readonly<Record<string, WorkflowRun>>;
};

export type RpcCall = { readonly method: string; readonly params: unknown };

/**
 * What the daemon answers at one point of a connect flow: a park body (a
 * Scheme string, as the daemon sends it), the connection it made, a refusal,
 * an RPC error, silence until cancelled, or any of those after a delay (`next`).
 */
export type ConnectReply =
  | string
  | { readonly done: string; readonly wire?: WireSpec }
  | { readonly refused: true }
  | { readonly fail: string }
  | { readonly hang: true }
  | { readonly after: number; readonly next: ConnectReply };

/** Replies in order: the first answers `connect/adopt`, each next one a `ui/resolve`. Keyed by driver, or `driver:name`. */
export type ConnectScripts = Readonly<Partial<Record<string, readonly ConnectReply[]>>>;

type Port = { request: (method: string, params: unknown) => Promise<unknown> };

/**
 * Serves a world to the frame. `follow` commits a route's documents at once.
 * The session port applies what the composer writes to the same models, so a
 * story stays interactive: a picked model lands in `kvs`, a sent message
 * opens a turn, Stop seals it.
 */
function rewindStory(root: SessionRoot, turnId: string): { ok: false } | { ok: true; turnId: string } {
  const ceiling = resolvedTip(root.head, root.tip);
  if (ceiling == null) return { ok: false };
  let loaded: SessionTurn | null = null;
  let unit: SessionTurn | null = ceiling;
  const seen = new Set<SessionTurn>();
  while (unit != null && !seen.has(unit)) {
    seen.add(unit);
    if (unit.uuid === turnId) loaded = unit;
    const tail: unknown = unit.turnTail;
    unit = tail instanceof SessionTurn ? tail : null;
  }
  if (loaded == null) return { ok: false };
  root.rewindHead(loaded, ceiling);
  return { ok: true, turnId: loaded.uuid };
}

export class StoryDial {
  kernel: KernelPlexus | null;
  readonly projects = new Map<string, ProjectPlexus>();
  project: ProjectPlexus | null = null;
  session: SessionPlexus | null = null;
  sessionRpc: Port | null = null;
  kernelRpc: Port | null = null;
  target: RouteTarget = { kind: "kernel" };
  requestedTarget: RouteTarget = { kind: "kernel" };
  link: Link | null;
  attaching: boolean;
  readonly calls: RpcCall[] = [];
  readonly #sessions = new Map<string, SessionPlexus>();
  readonly #peeks = new Map<string, SessionPlexus>();
  readonly #holdAttaching: boolean;
  readonly #refuse: boolean;
  readonly #scripts: ConnectScripts;
  readonly #portless: boolean;
  readonly #workflows: Readonly<Record<string, WorkflowRun>>;
  readonly #kernelPort: Port = {
    request: async (method, params) => {
      this.calls.push({ method, params });
      if (method === "connect/adopt" || method === "ui/resolve") return this.#connect(null, method, params);
      return this.#settings(method, params);
    },
  };
  #skills: {
    name: string;
    description: string;
    location: string;
    invoke: string;
    scope: "project" | "home";
  }[] = [
    {
      name: "review",
      description: "Look at the diff again",
      location: `${PROJECT}/.agents/skills/review/SKILL.md`,
      invoke: "review",
      scope: "project",
    },
    {
      name: "ponytail",
      description: "The shortest change that works",
      location: "/Users/ada/.agents/skills/ponytail/SKILL.md",
      invoke: "ponytail",
      scope: "home",
    },
  ];
  /** Parked flows by pending id: where each is in its script, and who waits on a hung reply. */
  readonly #parks = new Map<string, { script: readonly ConnectReply[]; at: number; release?: () => void }>();

  constructor(world: WorldSpec) {
    this.kernel = world.kernel;
    for (const plexus of world.projects ?? []) this.projects.set(plexus.root.path, plexus);
    for (const plexus of world.sessions ?? []) this.#sessions.set(plexus.root.sessionId, plexus);
    for (const plexus of world.peeks ?? []) this.#peeks.set(plexus.root.sessionId, plexus);
    this.link = world.link ?? null;
    this.#holdAttaching = world.attaching === true;
    this.#refuse = world.refuse === true;
    this.#scripts = world.connect ?? {};
    this.#portless = world.portless === true;
    this.#workflows = world.workflows ?? {};
    this.kernelRpc = this.#portless ? null : this.#kernelPort;
    this.attaching = this.#holdAttaching;
    makeObservable(this, {
      kernel: observable.ref,
      projects: observable,
      project: observable.ref,
      session: observable.ref,
      sessionRpc: observable.ref,
      kernelRpc: observable.ref,
      target: observable.ref,
      requestedTarget: observable.ref,
      link: observable.ref,
      attaching: observable,
    });
  }

  look(): void {}

  /** A worker's document, as the daemon would sync it. One that is not built is unreachable. */
  async peek(sessionId: string): Promise<{ plexus: SessionPlexus; release: () => void }> {
    const plexus = this.#peeks.get(sessionId) ?? this.#sessions.get(sessionId);
    if (plexus == null) throw new Error(`no session ${sessionId}`);
    return { plexus, release: () => undefined };
  }

  /** The daemon's feed for one program: its run, served as frames. A program with no run kept has no graph. */
  workflow(
    sessionId: string,
    jobId: string,
    onGraph: (graph: RegionGraph | null, done: boolean) => void,
    signal: AbortSignal,
  ): void {
    const root = this.#sessions.get(sessionId)?.root;
    const program =
      root == null
        ? undefined
        : turnsOldestFirst(root)
            .flatMap((held) => [...held.doneWork, ...held.queue])
            .find((chunk): chunk is ProgrammaticJob => chunk instanceof ProgrammaticJob && chunk.uuid === jobId);
    const run = program === undefined ? undefined : this.#workflows[program.toolCallId];
    if (program === undefined || run === undefined) onGraph(null, true);
    else serveWorkflow(run, () => program.toolCalls, onGraph, signal);
  }

  prepareMint(): void {}

  async follow(target: RouteTarget): Promise<void> {
    runInAction(() => {
      this.requestedTarget = target;
      if (this.#holdAttaching) return;
      const sessionId = "sessionId" in target ? target.sessionId : null;
      const path = "path" in target ? target.path : null;
      const opened = sessionId == null ? null : (this.#sessions.get(sessionId) ?? null);
      this.target = target;
      this.project = path == null ? null : (this.projects.get(path) ?? null);
      this.session = opened;
      this.sessionRpc =
        opened == null || this.#portless
          ? null
          : { request: (method, params) => this.#request(opened, method, params) };
      this.kernelRpc = this.#portless ? null : this.#kernelPort;
      this.attaching = false;
    });
  }

  async #request(opened: SessionPlexus, method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.#refuse) return { ok: false };
    if (method === "connect/adopt" || method === "ui/resolve") return this.#connect(opened, method, params);
    const args = (params ?? {}) as Record<string, unknown>;
    if (method === "turn/rewind" && typeof args.turnId === "string") return rewindStory(opened.root, args.turnId);
    runInAction(() => {
      const root = opened.root;
      if (method === "kv/set" && typeof args.key === "string" && typeof args.value === "string") {
        root.applyKvs([{ form: "kv-set", key: args.key, value: args.value }]);
      }
      if (method === "turn" && typeof args.prompt === "string") {
        root.head = turn({ prompt: args.prompt, work: [], live: true }, root.head ?? new SessionSystemPrompt());
      }
      if (method === "turn/cancel" && root.head != null) root.head.reducerExited = true;
      if (method === "policy/set" && (args.policy === "manual" || args.policy === "auto" || args.policy === "yolo")) {
        root.permissionMode = args.policy;
        if (this.kernel != null) this.kernel.root.defaultPermissionMode = args.policy;
      }
    });
    return { ok: true };
  }

  /** Settings writes land on the same documents the dialog is reading. */
  #settings(method: string, params: unknown): unknown {
    const args = (params ?? {}) as Record<string, unknown>;
    const root = this.kernel?.root;
    return runInAction(() => {
      switch (method) {
        case "skill/list":
          return { skills: this.#skills };
        case "skill/write": {
          const name = String(args.name);
          const scope = args.scope === "home" ? "home" : "project";
          const row = {
            name,
            description: typeof args.description === "string" ? args.description : "",
            location:
              scope === "home"
                ? `/Users/ada/.agents/skills/${name}/SKILL.md`
                : `${PROJECT}/.agents/skills/${name}/SKILL.md`,
            invoke: name,
            scope,
          } as const;
          this.#skills = [...this.#skills.filter((skill) => skill.name !== name || skill.scope !== scope), row];
          return row;
        }
        case "skill/remove":
          this.#skills = this.#skills.filter((skill) => !(skill.name === args.name && skill.scope === args.scope));
          return { ok: true as const };
        case "plugin/set": {
          const plugin = root?.plugins[String(args.name)];
          if (plugin != null) {
            if (typeof args.enabled === "boolean") plugin.enabled = args.enabled;
            if (typeof args.foreground === "boolean") Object.assign(plugin, { foreground: args.foreground });
          }
          return { ok: true as const };
        }
        case "config/set":
          if (root != null) applyStoryConfig(root, args);
          return { ok: true as const };
        case "connect/set-enabled": {
          const spec = root?.connections[String(args.id)];
          if (spec != null) spec.configuration = { ...spec.configuration, enabled: args.enabled === true };
          return { ok: true as const };
        }
        case "connect/drop":
          if (root != null) delete root.connections[String(args.id)];
          return { ok: true as const };
        case "connect/always-allow": {
          const spec = root?.connections[String(args.id)];
          const toolName = typeof args.tool === "string" ? args.tool : "";
          const existing = Array.isArray(spec?.configuration.alwaysAllow) ? spec.configuration.alwaysAllow : [];
          if (spec != null && toolName !== "" && !existing.includes(toolName)) {
            spec.configuration = { ...spec.configuration, alwaysAllow: [...existing, toolName] };
          }
          return { ok: true as const };
        }
        case "connect/exclude-tool": {
          const spec = root?.connections[String(args.id)];
          const toolName = typeof args.tool === "string" ? args.tool : "";
          const existing = Array.isArray(spec?.configuration.tools) ? spec.configuration.tools : [];
          const rule = `!${toolName}`;
          if (spec != null && toolName !== "" && !existing.includes(rule)) {
            spec.configuration = { ...spec.configuration, tools: [...existing, rule] };
          }
          return { ok: true as const };
        }
        case "mcp-server/search": {
          const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
          const servers = [
            {
              name: "dev.sentry/mcp",
              title: "Sentry",
              description: "Errors and traces.",
              install: "https://mcp.sentry.dev/mcp",
            },
            {
              name: "io.github.example/notes",
              title: "Notes",
              description: "Project notes.",
              install: "npx -y notes-mcp",
            },
          ].filter((server) => `${server.name} ${server.title} ${server.description}`.toLowerCase().includes(query));
          return { servers };
        }
        case "mcp-server/adopt": {
          if (root != null) {
            const given = typeof args.name === "string" ? args.name.trim() : "";
            const input = typeof args.input === "string" ? args.input : "";
            const http = input.startsWith("https://") || input.startsWith("http://");
            const driverName = http ? "mcp-http" : "mcp-stdio";
            const driver = root.drivers[driverName] ?? new DriverSpec({ name: driverName, abilityClaim: ["mcp"] });
            root.drivers[driverName] = driver;
            const connection = new ConnectionSpec({ driver, name: given === "" ? "Added MCP" : given });
            connection.configuration = http ? { url: input } : { command: input };
            const id = given === "" ? "mcp-added" : `mcp-copy-${Object.keys(root.connections).length}`;
            root.connections[id] = connection;
          }
          return { id: "mcp-added" };
        }
        case "bot/write":
          writeStoryBot(this, args);
          return { ok: true as const };
        case "bot/remove":
          removeStoryBot(this, args);
          return { ok: true as const };
        case "connect/login":
        case "connect/logout":
          return { ok: true as const };
        default:
          throw new Error(`no story handler for ${method}`);
      }
    });
  }

  /** The connect flow the stories script. A session's port also points the session at what it connected. */
  async #connect(opened: SessionPlexus | null, method: string, params: unknown): Promise<unknown> {
    const args = (params ?? {}) as Record<string, unknown>;
    if (method === "connect/adopt") {
      const driver = String(args.driver);
      const script = this.#scripts[`${driver}:${String(args.name)}`] ?? this.#scripts[driver];
      if (script == null) throw new Error(`no script for ${driver}`);
      return this.#reply(opened, `p${this.#parks.size + 1}-${this.calls.length}`, { script, at: 0 });
    }
    const pending = String(args.pending);
    const park = this.#parks.get(pending);
    if (park == null) throw new Error(`unknown pending ${pending}`);
    if (args.kind === "cancel") {
      park.release?.();
      this.#parks.delete(pending);
      return { ok: false };
    }
    park.at += 1;
    return this.#reply(opened, pending, park);
  }

  async #reply(
    opened: SessionPlexus | null,
    pending: string,
    park: { script: readonly ConnectReply[]; at: number; release?: () => void },
  ): Promise<unknown> {
    let reply = park.script.at(park.at);
    while (typeof reply === "object" && "after" in reply) {
      const wait: number = reply.after;
      await new Promise((resolve) => setTimeout(resolve, wait));
      reply = reply.next;
    }
    if (reply == null || (typeof reply === "object" && "refused" in reply)) {
      this.#parks.delete(pending);
      return { ok: false };
    }
    if (typeof reply === "string") {
      this.#parks.set(pending, park);
      return { form: "ui", pending, body: reply };
    }
    if ("fail" in reply) throw new Error(reply.fail);
    if ("hang" in reply) {
      this.#parks.set(pending, park);
      return new Promise((resolve) => {
        park.release = () => resolve({ ok: false });
      });
    }
    this.#parks.delete(pending);
    const { done, wire } = reply;
    runInAction(() => {
      if (wire != null && this.kernel != null) {
        addWire(this.kernel.root, wire);
        stampWire(this.kernel, wire);
      }
      opened?.root.applyKvs([{ form: "kv-set", key: "connection", value: done }]);
    });
    return { id: done };
  }

  /** The type the frame asks for; the story dial serves its whole read surface. */
  get asDial(): Dial {
    return this as unknown as Dial;
  }
}

function applyStoryConfig(root: KernelRoot, args: Record<string, unknown>): void {
  if (typeof args.compact === "string") root.compactStrategy = args.compact;
  if (typeof args.compactKeepTurns === "number") root.compactKeepTurns = args.compactKeepTurns;
  if (typeof args.contextGlowRemaining === "string") root.contextGlowRemaining = args.contextGlowRemaining;
  if (typeof args.autoModeClassifier === "string") root.autoModeClassifier = args.autoModeClassifier;
  if (
    args.defaultPermissionMode === "manual" ||
    args.defaultPermissionMode === "auto" ||
    args.defaultPermissionMode === "yolo"
  ) {
    root.defaultPermissionMode = args.defaultPermissionMode;
  }
  if (typeof args.approvalAskThrottleMs === "number") root.approvalAskThrottleMs = args.approvalAskThrottleMs;
  if (typeof args.shellTailBytes === "number") root.shellTailBytes = args.shellTailBytes;
  if (args.superKey === "ctrl" || args.superKey === "cmd") root.superKey = args.superKey;
  if (typeof args.hideFloorTools === "boolean") root.hideFloorTools = args.hideFloorTools;
  if (typeof args.statusline === "string") root.statusline = args.statusline;
  if (typeof args.statuslineRefresh === "string") root.statuslineRefresh = args.statuslineRefresh;
  if (typeof args.speculativePolicyProcessingTools === "number") {
    root.speculativePolicyProcessingTools = args.speculativePolicyProcessingTools;
  }
  if (typeof args.textOnlyContinue === "boolean") root.reActLoopIntentDetectedTrigger.enabled = args.textOnlyContinue;
  if (args.compactTriggers != null && typeof args.compactTriggers === "object") {
    const triggers = args.compactTriggers as { readonly hard?: unknown; readonly soft?: unknown };
    if (typeof triggers.hard === "string") root.compactTriggers.hard = triggers.hard;
    if (typeof triggers.soft === "string") root.compactTriggers.soft = triggers.soft;
  }
}

function writeStoryBot(dial: StoryDial, args: Record<string, unknown>): void {
  const name = typeof args.name === "string" ? args.name : "";
  if (name === "") return;
  const bot = new BotSpec({
    name,
    description: typeof args.description === "string" ? args.description : "",
    instructions: prompt.system`${typeof args.instructions === "string" ? args.instructions : ""}`,
    recipeScope: args.recipeScope === "project" || args.recipeScope === "global" ? args.recipeScope : "session",
    tools: stringList(args.tools),
    skills: stringList(args.skills),
    keepAlive: args.keepAlive === true,
    mcpJson: mcpJsonOf(args.mcp),
  });
  const record = storyBots(dial, args);
  if (record != null) record[name] = bot;
}

function removeStoryBot(dial: StoryDial, args: Record<string, unknown>): void {
  const name = typeof args.name === "string" ? args.name : "";
  const record = storyBots(dial, args);
  if (record != null && name !== "") delete record[name];
}

function storyBots(dial: StoryDial, args: Record<string, unknown>): Record<string, BotSpec> | null {
  if (args.scope === "project") {
    const path = typeof args.project === "string" ? args.project : "";
    return dial.projects.get(path)?.root.bots ?? dial.project?.root.bots ?? null;
  }
  return dial.kernel?.root.bots ?? null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mcpJsonOf(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  return JSON.stringify(value);
}
