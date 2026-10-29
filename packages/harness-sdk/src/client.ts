import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import { DefaultedMap } from "@here.build/collections";
import { PlexusAwareness } from "@here.build/plexus";
import { trace } from "@inhuman.tools/harness-diagnostics";
import {
  KERNEL_DOC_GUID,
  KernelPlexus,
  ProjectPlexus,
  publishKernelSeat,
  type KernelRoot,
  type ProjectRoot,
} from "@inhuman.tools/harness-model/kernel";
import {
  CallJob,
  delegatesPermissionMode,
  deskPermissionSnap,
  permissionDeskSessionId,
  ProgrammaticJob,
  projectWorkerPermissions,
  SessionPlexus,
  type SessionRoot,
  type SessionTurn,
} from "@inhuman.tools/harness-model/session";
import {
  awarenessBytes,
  bindJsonRpc,
  bindProviderAwareness,
  destroyProvider,
  encodeQueryAwareness,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  peekMessageType,
  type JsonRpcPort,
} from "@inhuman.tools/harness-peer";
import {
  revalidationDemandRefFromSpec,
  type RevalidationDemandSource,
  type RevalidationDemandSubject,
  collectRevalidationDemandRefs,
  publishRevalidationDemand,
  publishRevalidationDemandFocus,
} from "@inhuman.tools/plexus-expectations";
import { comparer, computed, type IComputedValue, type IReactionDisposer, reaction } from "mobx";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { ClientAgent, type AgentRosterRow, type AgentRosterScope } from "./client-agents.js";
import { daemonSocketPath } from "./paths.js";
import { openUnixRoom, RoomNotFound, type OpenUnixRoomOptions } from "./transport/unix.js";

function step(message: string): void {
  trace("harness:client", message);
}

/** Kernel-plane JSON-RPC. No session, no project. */
export type KernelRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** Kernel room with the live image. RPC is the same port. */
export type KernelHandle = KernelRpc & {
  readonly plexus: KernelPlexus;
};

type SessionViewSlot = "peek" | "ask";

type SessionView = {
  readonly sessionId: string;
  readonly plexus: SessionPlexus;
  readonly stop: (() => void) | null;
};

/** sessionId-only upgrade 404. Daemon-down is not this. */
export class RestoreNotFound extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = "RestoreNotFound";
  }
}

export class Client implements AsyncDisposable {
  static start(kernelPath: string, projectPath: string, phase?: (label: string) => void): Promise<Client> {
    return Client.#attach({ kernelPath, projectPath, phase });
  }

  static connect(
    kernelPath: string,
    projectPath: string,
    sessionId: string,
    phase?: (label: string) => void,
  ): Promise<Client> {
    return Client.#attach({ kernelPath, projectPath, sessionId, phase });
  }

  static restore(kernelPath: string, sessionId: string, phase?: (label: string) => void): Promise<Client> {
    return Client.#attach({ kernelPath, sessionId, restore: true, phase });
  }

  /** Kernel room only. Caller must `ensure()` the daemon first — except completion, which must not spawn. */
  static async kernel(
    kernelPath: string,
    opts?: {
      readonly reconnect?: boolean;
      readonly syncTimeoutMs?: number;
      readonly awarenessWaitMs?: number;
    },
  ): Promise<KernelHandle> {
    step(`client kernel ${kernelPath}`);
    const kernel = await realpath(kernelPath);
    const socketPath = daemonSocketPath(kernel);
    const providers: WebsocketProvider[] = [];
    const awarenessStops: Array<() => void> = [];
    try {
      const plexus = await Client.#open(
        socketPath,
        "kernel",
        {},
        new Y.Doc({ guid: KERNEL_DOC_GUID }),
        (doc) => KernelPlexus.connect(doc),
        providers,
        awarenessStops,
        opts == null
          ? undefined
          : {
              reconnect: opts.reconnect,
              syncTimeoutMs: opts.syncTimeoutMs,
            },
        opts?.awarenessWaitMs,
      );
      const provider = providers.at(-1);
      if (provider == null) throw new Error("client kernel: no provider");
      const rpc = bindJsonRpc(provider);
      return {
        plexus,
        request: (method, params) => rpc.request(method, params),
        async [Symbol.asyncDispose](): Promise<void> {
          rpc.rejectAll(new Error("kernel rpc disposed"));
          for (const stop of awarenessStops.splice(0)) stop();
          for (const item of providers.splice(0)) destroyProvider(item);
          plexus.destroy();
        },
      };
    } catch (error) {
      for (const stop of awarenessStops) stop();
      for (const provider of providers) destroyProvider(provider);
      throw error;
    }
  }

  /** sessionId-only upgrade. False on 404; other failures throw. */
  static async sessionExists(kernelPath: string, sessionId: string): Promise<boolean> {
    const kernel = await realpath(kernelPath);
    const socketPath = daemonSocketPath(kernel);
    const doc = new Y.Doc({ guid: `harness:session:${sessionId}` });
    try {
      const provider = await openUnixRoom(socketPath, "session", { sessionId }, doc, {
        reconnect: false,
      });
      destroyProvider(provider);
      doc.destroy();
      return true;
    } catch (error) {
      doc.destroy();
      if (error instanceof RoomNotFound) return false;
      throw error;
    }
  }

  static async #attach(opts: {
    readonly kernelPath: string;
    readonly projectPath?: string;
    readonly sessionId?: string;
    readonly restore?: boolean;
    readonly phase?: (label: string) => void;
  }): Promise<Client> {
    const restore = opts.restore === true;
    step(`client ${restore ? "restore" : opts.sessionId === undefined ? "start" : "connect"} ${opts.kernelPath}`);
    const kernel = await realpath(opts.kernelPath);
    const socketPath = daemonSocketPath(kernel);
    step(`client sock ${socketPath}`);
    const providers: WebsocketProvider[] = [];
    const awarenessStops: Array<() => void> = [];

    try {
      let project: string;
      let session: string;
      let sessionParams: Record<string, string>;
      let unixOpts: OpenUnixRoomOptions | undefined;
      if (restore) {
        session = opts.sessionId ?? "";
        if (session === "") throw new Error("client restore: missing sessionId");
        sessionParams = { sessionId: session };
        unixOpts = { reconnect: false };
        project = "";
      } else {
        if (opts.projectPath == null) throw new Error("client attach: missing projectPath");
        project = await realpath(opts.projectPath);
        session = opts.sessionId ?? randomUUID();
        sessionParams = { path: project, sessionId: session };
      }
      opts.phase?.("syncing the session...");
      const sessionPlexus = await Client.#open(
        socketPath,
        "session",
        sessionParams,
        new Y.Doc({ guid: `harness:session:${session}` }),
        (doc) => SessionPlexus.connect(doc),
        providers,
        awarenessStops,
        unixOpts,
      );
      if (restore) {
        const path = sessionPlexus.root.path;
        if (path === "") throw new Error("client restore: session has no path");
        project = await realpath(path);
      }
      const sessionProvider = providers.at(-1) ?? null;
      opts.phase?.("syncing the kernel...");
      const kernelPlexus = await Client.#open(
        socketPath,
        "kernel",
        {},
        new Y.Doc({ guid: KERNEL_DOC_GUID }),
        (doc) => KernelPlexus.connect(doc),
        providers,
        awarenessStops,
        undefined,
        undefined,
        () => opts.phase?.("reading kernel occupancy..."),
      );
      const kernelProvider = providers.at(-1) ?? null;
      opts.phase?.("syncing the project...");
      const projectPlexus = await Client.#open(
        socketPath,
        "project",
        { path: project },
        new Y.Doc(),
        (doc) => ProjectPlexus.connect(doc),
        providers,
        awarenessStops,
      );
      const client = new Client(
        kernel,
        project,
        sessionPlexus.root.sessionId,
        kernelPlexus,
        projectPlexus,
        sessionPlexus,
        sessionProvider,
        kernelProvider,
      );
      client.#providers.push(...providers);
      client.#awarenessStops.push(...awarenessStops);
      return client;
    } catch (error) {
      for (const stop of awarenessStops) stop();
      for (const provider of providers) destroyProvider(provider);
      if (restore && error instanceof RoomNotFound) {
        throw new RestoreNotFound(opts.sessionId ?? "");
      }
      throw error;
    }
  }

  // HTTPServer upgrades only after the host is ready. y-websocket starts the handshake.
  static async #open<T>(
    socketPath: string,
    room: string,
    params: Record<string, string>,
    doc: Y.Doc,
    attach: (doc: Y.Doc) => T,
    providers: WebsocketProvider[],
    awarenessStops: Array<() => void>,
    unixOptions?: OpenUnixRoomOptions,
    awarenessWaitMs?: number,
    onAwareness?: () => void,
  ): Promise<T> {
    step(`client sync ${room}`);
    const provider = await openUnixRoom(socketPath, room, params, doc, unixOptions);
    providers.push(provider);
    step(`client synced ${room}`);
    const instance = attach(doc);
    const hub = (instance as { awareness?: PlexusAwareness }).awareness;
    if (hub !== undefined) {
      awarenessStops.push(bindProviderAwareness(hub, provider));
      if (room === "kernel") {
        onAwareness?.();
        await awaitAwarenessDump(provider, awarenessWaitMs ?? 2000);
      }
    }
    return instance;
  }

  readonly #providers: WebsocketProvider[] = [];
  readonly #awarenessStops: Array<() => void> = [];
  readonly #rpc: JsonRpcPort | null;
  readonly #kernelRpc: JsonRpcPort | null;
  #attentionStop: IReactionDisposer | null = null;
  #revalidationDemandFocusStop: IReactionDisposer | null = null;
  /** Intern table for `ClientAgent` rows. Not observable. */
  readonly #agents = new DefaultedMap((id: string) => new ClientAgent(this, id));
  /** Viewer intern for sneak-peek. Does not publish a kernel seat. */
  #peek: SessionView | null = null;
  /** Approval intern for one-shot / session-scope workers. Does not seat. */
  #ask: SessionView | null = null;
  readonly #viewGen = { peek: 0, ask: 0 };
  #askDeskStop: IReactionDisposer | null = null;

  constructor(
    readonly kernelPath: string,
    readonly projectPath: string,
    readonly sessionId: string,
    readonly kernelPlexus: KernelPlexus,
    readonly projectPlexus: ProjectPlexus,
    readonly sessionPlexus: SessionPlexus,
    readonly sessionProvider: WebsocketProvider | null = null,
    kernelProvider: WebsocketProvider | null = null,
  ) {
    this.#rpc = sessionProvider === null ? null : bindJsonRpc(sessionProvider);
    this.#kernelRpc = kernelProvider === null ? null : bindJsonRpc(kernelProvider);
    publishKernelSeat(this.kernelPlexus.awareness, sessionId);
  }

  get kernelRoot(): KernelRoot {
    return this.kernelPlexus.root;
  }

  get projectRoot(): ProjectRoot {
    return this.projectPlexus.root;
  }

  get sessionRoot(): SessionRoot {
    return this.sessionPlexus.root;
  }

  /** Peeked worker tape. Null when no sneak-peek is interned. */
  get peekPlexus(): SessionPlexus | null {
    return this.#peek?.plexus ?? null;
  }

  /** Asking worker tape for the host cover. Null when none is interned. */
  get askPlexus(): SessionPlexus | null {
    return this.#ask?.plexus ?? null;
  }

  /** Local intern. Tests / already-open plexus. Does not own destroy. */
  adoptPeek(plexus: SessionPlexus): void {
    this.#adoptView("peek", plexus);
  }

  /** Local intern for the host cover. Tests / already-open plexus. */
  adoptAsk(plexus: SessionPlexus): void {
    this.#adoptView("ask", plexus);
  }

  /**
   * Open the worker session room without seating. No-op on a local test
   * Client (`sessionProvider == null`) — those use {@link adoptPeek}.
   */
  watchPeek(sessionId: string): Promise<void> {
    return this.#watchView("peek", sessionId);
  }

  /**
   * Open the asking worker without seating. Local tests use {@link adoptAsk}.
   */
  watchAsk(sessionId: string): Promise<void> {
    return this.#watchView("ask", sessionId);
  }

  releasePeek(): void {
    this.#releaseView("peek");
  }

  releaseAsk(): void {
    this.#releaseView("ask");
  }

  #adoptView(slot: SessionViewSlot, plexus: SessionPlexus): void {
    this.#releaseView(slot);
    this.#setView(slot, { sessionId: plexus.root.sessionId, plexus, stop: null });
  }

  #releaseView(slot: SessionViewSlot): void {
    this.#viewGen[slot] += 1;
    const view = slot === "peek" ? this.#peek : this.#ask;
    this.#setView(slot, null);
    view?.stop?.();
  }

  #setView(slot: SessionViewSlot, view: SessionView | null): void {
    if (slot === "peek") this.#peek = view;
    else {
      this.#ask = view;
      this.#bindAskDesk();
    }
  }

  /** Host cover intern: project remainder inputs when this session is the desk. */
  #bindAskDesk(): void {
    this.#askDeskStop?.();
    this.#askDeskStop = null;
    const worker = this.#ask?.plexus.root;
    if (worker == null) return;
    this.#askDeskStop = reaction(
      () => {
        if (!delegatesPermissionMode(worker)) return null;
        const deskId = permissionDeskSessionId(worker, this.kernelRoot);
        if (deskId !== "" && deskId !== this.sessionId) return null;
        return deskPermissionSnap(this.sessionRoot);
      },
      (snap) => {
        if (snap == null) return;
        projectWorkerPermissions(worker, this.sessionRoot);
      },
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  async #watchView(slot: SessionViewSlot, sessionId: string): Promise<void> {
    const id = sessionId.trim();
    const current = slot === "peek" ? this.#peek : this.#ask;
    if (id === "" || current?.sessionId === id) return;
    this.#releaseView(slot);
    if (this.sessionProvider == null) return;
    const gen = this.#viewGen[slot];
    const kernel = await realpath(this.kernelPath);
    const providers: WebsocketProvider[] = [];
    const awarenessStops: Array<() => void> = [];
    const drop = (): void => {
      for (const stop of awarenessStops.splice(0)) stop();
      for (const provider of providers.splice(0)) destroyProvider(provider);
    };
    try {
      const plexus = await Client.#open(
        daemonSocketPath(kernel),
        "session",
        { sessionId: id },
        new Y.Doc({ guid: `harness:session:${id}` }),
        (doc) => SessionPlexus.connect(doc),
        providers,
        awarenessStops,
        { reconnect: false },
      );
      if (gen !== this.#viewGen[slot]) {
        drop();
        plexus.destroy();
        return;
      }
      this.#setView(slot, {
        sessionId: id,
        plexus,
        stop: () => {
          drop();
          plexus.destroy();
        },
      });
    } catch (error) {
      drop();
      throw error;
    }
  }

  @computed.struct
  get botsRoster(): readonly AgentRosterRow[] {
    return [
      ...rosterRows("session", this.sessionRoot.botsRoster),
      ...rosterRows("project", this.projectRoot.botsRoster),
      ...rosterRows("global", this.kernelRoot.botsRoster),
    ];
  }

  @computed
  get agentCalls(): readonly CallJob[] {
    const out: CallJob[] = [];
    const seen = new Set<CallJob>();
    const take = (job: CallJob): void => {
      if (seen.has(job) || job.workerSessionId.trim() === "") return;
      seen.add(job);
      out.push(job);
    };
    for (const turn of this.sessionRoot.liveTurns) {
      for (const job of turnCallJobs(turn)) take(job);
    }
    return out;
  }

  @computed
  get programs(): readonly ProgrammaticJob[] {
    const out: ProgrammaticJob[] = [];
    const seen = new Set<ProgrammaticJob>();
    for (const turn of this.sessionRoot.liveTurns) {
      for (const node of turn.openBackgroundWork) {
        if (!(node instanceof ProgrammaticJob) || seen.has(node)) continue;
        seen.add(node);
        out.push(node);
      }
    }
    return out;
  }

  @computed.struct
  get #workerIds(): readonly string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const add = (id: string): void => {
      if (id === "" || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const row of this.botsRoster) add(row.sessionId);
    for (const call of this.agentCalls) {
      if (!call.completed) add(call.workerSessionId.trim());
    }
    return ids;
  }

  @computed
  get agents(): readonly ClientAgent[] {
    return this.#workerIds.map((id) => this.#agents.get(id));
  }

  @computed
  get sessionAgents(): readonly ClientAgent[] {
    return this.agents.filter((agent) => agent.scope === "session");
  }

  @computed
  get projectAgents(): readonly ClientAgent[] {
    return this.agents.filter((agent) => agent.scope === "project");
  }

  @computed
  get globalAgents(): readonly ClientAgent[] {
    return this.agents.filter((agent) => agent.scope === "global");
  }

  @computed
  get oneShotAgents(): readonly ClientAgent[] {
    return this.agents.filter((agent) => agent.oneShot);
  }

  /**
   * Ambient looking: specs currently in a list. Tracked as a MobX computed —
   * occupancy retracts when the getter stops returning them. Kernel-plane:
   * interned connections outlive a session wrap.
   */
  setComputedAttention(fn: () => RevalidationDemandSource): void {
    this.#attentionStop?.();
    this.#attentionStop = reaction(
      () => collectRevalidationDemandRefs(fn()),
      (refs) => publishRevalidationDemand(this.kernelPlexus.awareness, refs),
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  /**
   * Focused looking: the one-of-a-kind spec in the UI. Tracked as a MobX
   * computed — occupancy retracts when the getter returns null. Kernel-plane:
   * interned connections outlive a session wrap.
   */
  setComputedAttentionFocus(fn: () => RevalidationDemandSubject | null | undefined): void {
    this.#revalidationDemandFocusStop?.();
    this.#revalidationDemandFocusStop = reaction(
      () => {
        const spec = fn();
        return spec == null ? null : revalidationDemandRefFromSpec(spec);
      },
      (ref) => publishRevalidationDemandFocus(this.kernelPlexus.awareness, ref),
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  get lost(): boolean {
    return this.#rpc === null || this.#rpc.lost;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#rpc === null) {
      return Promise.reject(new Error("client: session socket is not open"));
    }
    return this.#rpc.request(method, params);
  }

  /** Kernel-plane JSON-RPC. Kernel/project docs are lenses; writes go through this. */
  kernelRequest(method: string, params: unknown = {}): Promise<unknown> {
    if (this.#kernelRpc === null) {
      return Promise.reject(new Error("client: kernel socket is not open"));
    }
    return this.#kernelRpc.request(method, params);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.releasePeek();
    this.releaseAsk();
    this.#askDeskStop?.();
    this.#askDeskStop = null;
    this.#attentionStop?.();
    this.#attentionStop = null;
    this.#revalidationDemandFocusStop?.();
    this.#revalidationDemandFocusStop = null;
    publishKernelSeat(this.kernelPlexus.awareness, null);
    publishRevalidationDemand(this.kernelPlexus.awareness, []);
    publishRevalidationDemandFocus(this.kernelPlexus.awareness, null);
    for (const stop of this.#awarenessStops.splice(0)) stop();
    this.#rpc?.rejectAll(new Error("client disposed"));
    this.#kernelRpc?.rejectAll(new Error("client disposed"));
    for (const provider of this.#providers.splice(0)) {
      destroyProvider(provider);
    }
    this.#agents.clear();
    this.kernelPlexus.destroy();
    this.projectPlexus.destroy();
    this.sessionPlexus.destroy();
  }
}

const turnCallJobsCache = new WeakMap<SessionTurn, IComputedValue<readonly CallJob[]>>();

function turnCallJobs(turn: SessionTurn): readonly CallJob[] {
  let box = turnCallJobsCache.get(turn);
  if (box === undefined) {
    box = computed(
      () => {
        const out: CallJob[] = [];
        const seen = new Set<CallJob>();
        const take = (job: CallJob): void => {
          if (seen.has(job) || job.workerSessionId.trim() === "") return;
          seen.add(job);
          out.push(job);
        };
        for (const chunk of turn.doneWork) {
          if (chunk instanceof CallJob) take(chunk);
        }
        for (const chunk of turn.queue) {
          if (chunk instanceof CallJob) take(chunk);
        }
        for (const node of turn.subtreeWork) {
          if (node instanceof CallJob) take(node);
        }
        return out;
      },
      { equals: comparer.shallow },
    );
    turnCallJobsCache.set(turn, box);
  }
  return box.get();
}

function rosterRows(scope: AgentRosterScope, record: Record<string, string>): AgentRosterRow[] {
  const out: AgentRosterRow[] = [];
  for (const [name, sessionId] of Object.entries(record)) {
    const id = sessionId.trim();
    if (name.trim() === "" || id === "") continue;
    out.push({ scope, name, sessionId: id });
  }
  return out;
}

/** Join snapshot can arrive before bind; QUERY fetches occupancy for `--continue`. */
async function awaitAwarenessDump(provider: WebsocketProvider, ms = 2000): Promise<void> {
  const socket = provider.ws;
  if (socket == null || socket.readyState !== socket.OPEN) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onMessage = (event: { data: unknown }): void => {
      const bytes = awarenessBytes(event.data);
      if (bytes == null) return;
      const type = peekMessageType(bytes);
      if (type === MESSAGE_AWARENESS || type === MESSAGE_QUERY_AWARENESS) finish();
    };
    socket.addEventListener("message", onMessage);
    socket.send(encodeQueryAwareness());
  });
}
