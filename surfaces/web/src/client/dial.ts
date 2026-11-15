import type { RegionGraph } from "@here.build/arrival-provenance";
import { ChunkedWebSocket } from "@inhuman.tools/chunked-websocket/client";
import type { KernelRow, PendingAskRow, SessionSummaryRow, ShapeDeltaFrame } from "@inhuman.tools/harness-contract";
import type { WorkflowFrame } from "@inhuman.tools/harness-model/session";
import {
  bindJsonRpc,
  bindRoomAwareness,
  createDoc,
  destroyRoomConnection,
  detachLocalPresence,
  KERNEL_DOC_GUID,
  KernelDocument,
  ProjectDocument,
  publishKernelSeat,
  publishRevalidationDemand,
  RoomConnection,
  SessionDocument,
  waitForSync,
  type Doc,
  type JsonRpcPort,
} from "@inhuman.tools/harness-peer";
import { type Feed, foldFrame } from "@inhuman.tools/harness-transcript/workflow/feed";
import { LiveShape } from "@inhuman.tools/scope-plane";
import { comparer, observable, reaction, runInAction } from "mobx";

import { appLocation, type AppLocation } from "./location.js";
import { bindRelayFrames, isRefusal, linkForClose, startPing } from "./remote.js";
import type { RouteTarget } from "../shell/path.js";

type Held = {
  readonly connection: RoomConnection;
  readonly doc: Doc;
  stop: () => void;
  /** The kernel room's JSON-RPC port; the only way a tab without a session writes to the daemon. */
  rpc?: JsonRpcPort;
  /** Remote keepalive; stops with the room. */
  stopPing?: () => void;
};

/**
 * What the dial can say about its line to the daemon; `null` is attached and live.
 * Each kind is one thing the reader can know or do, not one exception.
 */
export type Link =
  /** No socket answered: the daemon is not running, or not at this origin. */
  | { readonly kind: "unreachable" }
  /** A socket answered but the room never synced in time. */
  | { readonly kind: "unanswered" }
  | { readonly kind: "cancelled" }
  /** The daemon refused a session the kernel does not list. */
  | { readonly kind: "missing"; readonly sessionId: string }
  /** The session lives in another project; it opens there. */
  | { readonly kind: "elsewhere"; readonly sessionId: string; readonly path: string }
  /** Attached, then a room dropped; the socket is redialing on its own. */
  | { readonly kind: "reconnecting" }
  /** The relay has no connection to the machine. Redialing says whether anything is still trying. */
  | { readonly kind: "offline"; readonly redialing: boolean }
  /** The machine refused the room. Redialing will not help. */
  | { readonly kind: "unavailable"; readonly reason: string };

class LinkError extends Error {
  constructor(readonly link: Link) {
    super(link.kind);
  }
}

/** `waitForSync` names a timeout in its own words; anything else failed before a socket answered. */
function attachLink(error: unknown): Link {
  if (error instanceof LinkError) return error.link;
  return error instanceof Error && error.message.includes("sync timeout")
    ? { kind: "unanswered" }
    : { kind: "unreachable" };
}

type Session = { doc: SessionDocument; rpc: JsonRpcPort };
type Staged = {
  rooms: Map<string, Held>;
  projects: Map<string, ProjectDocument>;
  sessions: Map<string, Session>;
};

export class Dial {
  @observable.ref accessor kernel: KernelDocument | null = null;
  /** Every known project, attached for the sidebar. Not dropped on route changes. */
  @observable.shallow accessor projects = new Map<string, ProjectDocument>();
  @observable.ref accessor project: ProjectDocument | null = null;
  @observable.ref accessor session: SessionDocument | null = null;
  @observable.ref accessor sessionRpc: JsonRpcPort | null = null;
  /** Kernel-plane JSON-RPC, open once the kernel room synced. Kernel documents are read-only here. */
  @observable.ref accessor kernelRpc: JsonRpcPort | null = null;
  @observable.ref accessor target: RouteTarget = { kind: "kernel" };
  @observable.ref accessor requestedTarget: RouteTarget = { kind: "kernel" };
  @observable.ref accessor link: Link | null = null;
  @observable.ref accessor attaching = true;

  readonly kernelMeta = new LiveShape<string, KernelRow>((row) => row.id);
  readonly activeSessions = new LiveShape<string, SessionSummaryRow>((row) => row.sessionId);
  readonly recentSessions = new LiveShape<string, SessionSummaryRow>((row) => row.sessionId);
  readonly pendingAsks = new LiveShape<string, PendingAskRow>((row) => row.id ?? row.jobId);
  readonly childSessions = new Map<string, LiveShape<string, SessionSummaryRow>>();

  #generation = 0;
  /** Sidebar attachments. A newer kernel wins; a route change does not cancel them. */
  #catalogGeneration = 0;
  /** Set when a staged first message is sent. Consumed only after a matching successful attachment. */
  #mintId: string | null = null;
  #mintGeneration = 0;
  readonly #rooms = new Map<string, Held>();
  readonly #projects = new Map<string, ProjectDocument>();
  readonly #sessions = new Map<string, Session>();
  /** The last relay close code each room's socket saw, cleared when it connects. */
  readonly #closeCodes = new WeakMap<RoomConnection, number>();
  readonly where: AppLocation;

  /**
   * `where` says whether rooms are reached through the relay; the default is a local daemon at `origin`.
   */
  constructor(
    readonly origin: string,
    options: { readonly where?: AppLocation } = {},
  ) {
    this.where = options.where ?? {
      remote: false,
      roomOrigin: origin,
      httpBase: origin.replace(/^ws/, "http"),
      basepath: undefined,
      fileUrl: (path) => `/file?path=${encodeURIComponent(path)}`,
    };
  }

  /**
   * What this tab is looking at, in one demand: connections the daemon keeps
   * live and polling their accounts, drivers it probes for offers (local
   * servers) only while someone looks. An empty look clears both.
   */
  look(connections: readonly string[], drivers: readonly string[] = []): void {
    if (this.kernel == null) return;
    publishRevalidationDemand(this.kernel.awareness, [
      ...connections.map((id) => ({ kind: "connection", id }) as const),
      ...drivers.map((name) => ({ kind: "driver", name }) as const),
    ]);
  }

  /**
   * Another session's room to read: synced and live, never seated, no port to
   * write through. Route changes do not drop it; the caller releases it.
   */
  async peek(sessionId: string, signal?: AbortSignal): Promise<{ doc: SessionDocument; release: () => void }> {
    const roomDoc = createDoc({ guid: `harness:session:${sessionId}` });
    const room = await this.#connect("session", { sessionId }, roomDoc, () => signal?.aborted === true, signal);
    if (room == null) throw new Error("Peek cancelled.");
    const doc = SessionDocument.connect(room.doc, { readOnly: true });
    room.stop = bindRoomAwareness(doc.awareness, room.connection);
    return { doc, release: () => this.#destroyRoom(room) };
  }

  /**
   * A program's dataflow graph, live: every graph the feed reaches, until a `done` one or `signal`.
   * A feed that ends without ever giving a graph says `(null, true)`.
   */
  workflow(
    sessionId: string,
    jobId: string,
    onGraph: (graph: RegionGraph | null, done: boolean) => void,
    signal: AbortSignal,
  ): void {
    const url = `${this.where.httpBase}/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(jobId)}`;
    let feed: Feed | null = null;
    let source: EventSource | null = null;
    const close = (): void => source?.close();
    const open = (): void => {
      const mine = (source = new EventSource(url));
      mine.addEventListener("message", (event) => {
        let frame: WorkflowFrame;
        try {
          frame = JSON.parse(String(event.data)) as WorkflowFrame;
        } catch {
          return;
        }
        const next = foldFrame(feed, frame);
        if (next === "resync") {
          // The server opens every connection with a snapshot.
          mine.close();
          feed = null;
          open();
          return;
        }
        feed = next;
        onGraph(next.graph, next.done);
        if (next.done) mine.close();
      });
      // The browser redials a dropped stream on its own; a refused one (unknown job) it gives up on.
      mine.addEventListener("error", () => {
        if (mine.readyState === EventSource.CLOSED) onGraph(feed?.graph ?? null, true);
      });
    };
    signal.addEventListener("abort", close, { once: true });
    if (!signal.aborted) open();
  }

  prepareMint(sessionId: string): void {
    this.#mintId = sessionId;
    this.#mintGeneration += 1;
  }

  async follow(target: RouteTarget, signal?: AbortSignal): Promise<void> {
    const generation = (this.#generation += 1);
    let cancelled = false;
    const stale = (): boolean => cancelled || generation !== this.#generation;
    // Only rooms owned by this attempt live here; stale attempts cannot drop committed rooms.
    const staged: Staged = { rooms: new Map(), projects: new Map(), sessions: new Map() };
    const mint = (target.kind === "session" || target.kind === "project-session") && this.#mintId === target.sessionId;
    const mintGeneration = this.#mintGeneration;
    const cancel = (): void => {
      cancelled = true;
      for (const room of staged.rooms.values()) this.#destroyRoom(room);
      staged.rooms.clear();
      if (generation !== this.#generation) return;
      runInAction(() => {
        this.link = { kind: "cancelled" };
        this.attaching = false;
      });
    };
    runInAction(() => {
      this.requestedTarget = target;
      this.attaching = true;
      this.link = null;
      this.sessionRpc = null;
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      if (stale()) return;
      const kernel = await this.#kernel(staged, stale, signal);
      if (stale() || kernel == null) return;
      // Publish the kernel before the session room. A cold load used to hold it
      // until the session synced, so a refused session wiped the rail and was
      // reported missing before the kernel's own list could be consulted.
      this.#publishKernel(staged, kernel);
      let project: ProjectDocument | null = null;
      let projectPath = "";
      let session: Session | null = null;
      const keep = new Set<string>();
      if (target.kind === "project") {
        project = await this.#project(target.path, staged, stale, signal);
        projectPath = target.path;
        keep.add(`project:${target.path}`);
      } else if (target.kind !== "kernel") {
        const opened = await this.#openSession(
          target.kind === "project-session" ? target.path : null,
          target.sessionId,
          mint,
          staged,
          stale,
          signal,
        );
        if (opened == null) return;
        project = opened.project;
        projectPath = opened.projectPath;
        session = opened.session;
        keep.add(`session:${target.sessionId}`);
        if (opened.projectPath !== "") keep.add(`project:${opened.projectPath}`);
      }
      if (stale()) return;
      runInAction(() => {
        if (mint && this.#mintGeneration === mintGeneration) this.#mintId = null;
        this.#dropExcept(keep);
        for (const [key, room] of staged.rooms) this.#rooms.set(key, room);
        for (const [path, projectDoc] of staged.projects) {
          this.#projects.set(path, projectDoc);
          this.projects.set(path, projectDoc);
        }
        for (const [id, held] of staged.sessions) this.#sessions.set(id, held);
        staged.rooms.clear();
        this.kernel = kernel;
        this.kernelRpc = this.#rooms.get("kernel")?.rpc ?? null;
        this.#fillCatalog(kernel);
        if (project != null && projectPath !== "") this.#holdProject(projectPath, project);
        this.target = target;
        this.project = project;
        this.session = session?.doc ?? null;
        this.sessionRpc = session?.rpc ?? null;
        publishKernelSeat(
          kernel.awareness,
          target.kind === "session" || target.kind === "project-session" ? target.sessionId : null,
        );
        this.link = null;
        this.attaching = false;
      });
    } catch (error) {
      if (stale()) return;
      runInAction(() => {
        this.link = attachLink(error);
        this.attaching = false;
      });
      // The kernel is already live. Fill the rail even though this session did not open.
      if (this.kernel != null) this.#fillCatalog(this.kernel);
    } finally {
      signal?.removeEventListener("abort", cancel);
      for (const room of staged.rooms.values()) this.#destroyRoom(room);
    }
  }

  async #kernel(staged: Staged, stale: () => boolean, signal?: AbortSignal): Promise<KernelDocument | null> {
    if (this.kernel != null && this.#rooms.has("kernel")) return this.kernel;
    const roomDoc = createDoc({ guid: KERNEL_DOC_GUID });
    const room = await this.#connect("kernel", {}, roomDoc, stale, signal);
    if (room == null) return null;
    staged.rooms.set("kernel", room);
    const doc = KernelDocument.connect(room.doc, { readOnly: true });
    const stopAwareness = bindRoomAwareness(doc.awareness, room.connection);
    const stopProjects = reaction(
      () => Object.keys(doc.root.projects),
      () => {
        if (this.kernel === doc) this.#fillCatalog(doc);
      },
      { equals: comparer.structural },
    );

    const stopLanes = [
      room.connection.subscribeLane({ subscriptionId: "dial:kernel_meta", lane: "kernel_meta", params: {} }, (delta) =>
        this.kernelMeta.applyDelta(delta),
      ),
      room.connection.subscribeLane(
        { subscriptionId: "dial:active_sessions", lane: "active_sessions", params: {} },
        (delta) => this.activeSessions.applyDelta(delta),
      ),
      room.connection.subscribeLane(
        { subscriptionId: "dial:recent_sessions", lane: "recent_sessions", params: { limit: 100 } },
        (delta) => this.recentSessions.applyDelta(delta),
      ),
      room.connection.subscribeLane(
        { subscriptionId: "dial:pending_asks", lane: "pending_asks", params: {} },
        (delta) => this.pendingAsks.applyDelta(delta),
      ),
    ];

    const handleChildShape = (frame: ShapeDeltaFrame): void => {
      const prefix = "dial:child_sessions:";
      if (!frame.subscriptionId.startsWith(prefix)) return;
      const parentId = frame.subscriptionId.slice(prefix.length);
      if (!parentId) return;
      runInAction(() => {
        let childShape = this.childSessions.get(parentId);
        if (!childShape) {
          childShape = new LiveShape<string, SessionSummaryRow>((row) => row.sessionId);
          this.childSessions.set(parentId, childShape);
        }
        childShape.applyDelta(frame);
      });
    };
    room.connection.on("shape", handleChildShape);

    room.stop = () => {
      room.connection.off("shape", handleChildShape);
      for (const stopLane of stopLanes) stopLane();
      stopProjects();
      stopAwareness();
    };
    room.rpc = bindJsonRpc(room.connection);

    return doc;
  }

  async #project(
    path: string,
    staged: Staged,
    stale: () => boolean,
    signal?: AbortSignal,
  ): Promise<ProjectDocument | null> {
    const cached = this.#projects.get(path);
    if (cached != null) return cached;
    const roomDoc = createDoc();
    const room = await this.#connect("project", { path }, roomDoc, stale, signal);
    if (room == null) return null;
    staged.rooms.set(`project:${path}`, room);
    const doc = ProjectDocument.connect(room.doc, { readOnly: true });
    staged.projects.set(path, doc);
    return doc;
  }

  async #openSession(
    path: string | null,
    sessionId: string,
    mint: boolean,
    staged: Staged,
    stale: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ project: ProjectDocument | null; projectPath: string; session: Session } | null> {
    let held = this.#sessions.get(sessionId);
    if (held == null) {
      const roomDoc = createDoc({ guid: `harness:session:${sessionId}` });
      const params: Record<string, string> = { sessionId };
      if (mint && path != null) params.path = path;
      const listed = Boolean(this.kernel?.root.sessions[sessionId]);
      // A listed session may still be replaying a long image before the socket opens.
      const room = await this.#connect(
        "session",
        params,
        roomDoc,
        stale,
        signal,
        listed && !mint ? 60_000 : 8_000,
      ).catch((error: unknown) => {
        if (stale() || mint) throw error;
        const link = attachLink(error);
        if (link.kind !== "unreachable") throw error;
        // The kernel has answered. Missing means its list does not have this id.
        if (!listed) throw new LinkError({ kind: "missing", sessionId });
        throw new LinkError({ kind: "unanswered" });
      });
      if (room == null) return null;
      staged.rooms.set(`session:${sessionId}`, room);
      const doc = SessionDocument.connect(room.doc, { readOnly: true });
      const rpc = bindJsonRpc(room.connection);
      room.stop = bindRoomAwareness(doc.awareness, room.connection);
      held = { doc, rpc };
      staged.sessions.set(sessionId, held);
    }
    if (stale()) return null;
    const projectPath =
      held.doc.root.agent.spec.recipeScope === "global" ? "" : mint ? (path ?? "") : held.doc.root.path;
    if (path != null && (projectPath === "" || path !== projectPath)) {
      throw new LinkError({ kind: "elsewhere", sessionId, path: projectPath });
    }
    const project = projectPath === "" ? null : await this.#project(projectPath, staged, stale, signal);
    if (stale()) return null;
    return { project, projectPath, session: held };
  }

  /**
   * Connects one room.
   * `stale()` says another route change made this attempt obsolete; the room is destroyed immediately.
   */
  async #connect(
    roomName: string,
    params: Readonly<Record<string, string>>,
    doc: Doc,
    stale: () => boolean,
    signal?: AbortSignal,
    timeoutMs = 8_000,
  ): Promise<Held | null> {
    if (stale()) {
      doc.destroy();
      return null;
    }
    const remote = this.where.remote;
    const connection = new RoomConnection(this.origin, roomName, doc, {
      params: { ...params },
      ...(remote ? { WebSocketPolyfill: ChunkedWebSocket as unknown as typeof WebSocket, shouldReconnect } : {}),
    });
    detachLocalPresence(connection);
    let stopPing: (() => void) | undefined;
    const seen: { closed: { code: number; reason: string } | null } = { closed: null };
    if (remote) {
      bindRelayFrames(connection);
      stopPing = startPing(connection);
      connection.on("connection-close", (event: CloseEvent | null) => {
        if (event == null) return;
        seen.closed = { code: event.code, reason: event.reason };
        this.#closeCodes.set(connection, event.code);
        this.#relink();
      });
      connection.on("status", (event: { status: string }) => {
        if (event.status === "connected") seen.closed = null;
      });
    }
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      stopPing?.();
      destroyRoomConnection(connection);
      doc.destroy();
    };
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = (): void => {
      destroy();
      rejectAbort(new Error("Connection cancelled."));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      await Promise.race([waitForSync(connection, roomName, timeoutMs), aborted]);
    } catch (error) {
      destroy();
      // The relay said why the socket never synced.
      const said = seen.closed;
      const link = said == null ? null : linkForClose(said.code, said.reason, false);
      throw link == null ? error : new LinkError(link);
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    if (stale()) {
      destroy();
      return null;
    }
    connection.on("status", () => this.#relink());
    // A permanent close ends the redial; the room is gone until a retry attaches again.
    connection.on("closed", (event: { code?: number; reason?: string } | undefined) => {
      if ([...this.#rooms.values()].some((room) => room.connection === connection)) {
        const link =
          remote && typeof event?.code === "number" ? linkForClose(event.code, event.reason ?? "", false) : null;
        runInAction(() => {
          this.link = link ?? { kind: "unreachable" };
        });
      }
    });
    return { connection, doc, stop: () => undefined, stopPing };
  }

  /** Any held room that wants its socket and lacks it: the line is down and redialing. */
  #relink(): void {
    const down = [...this.#rooms.values()].filter(
      (room) => room.connection.shouldConnect && !room.connection.wsconnected,
    );
    const offline = down.some((room) => this.#closeCodes.get(room.connection) === 4503);
    const here = this.link?.kind;
    runInAction(() => {
      if (down.length > 0 && (here == null || here === "reconnecting" || here === "offline")) {
        this.link = offline ? { kind: "offline", redialing: true } : { kind: "reconnecting" };
      } else if (down.length === 0 && (here === "reconnecting" || here === "offline")) this.link = null;
    });
  }

  #destroyRoom(room: Held): void {
    room.rpc?.rejectAll(new Error("room closed"));
    room.stopPing?.();
    room.stop();
    destroyRoomConnection(room.connection);
    room.doc.destroy();
  }

  /** Move a staged kernel into the live dial so a later session failure cannot drop it. */
  #publishKernel(staged: Staged, kernel: KernelDocument): void {
    const room = staged.rooms.get("kernel");
    if (room != null && !this.#rooms.has("kernel")) {
      staged.rooms.delete("kernel");
      this.#rooms.set("kernel", room);
    }
    if (this.kernel != null) return;
    runInAction(() => {
      this.kernel = kernel;
      this.kernelRpc = this.#rooms.get("kernel")?.rpc ?? null;
    });
  }

  #holdProject(path: string, projectDoc: ProjectDocument): void {
    if (this.projects.has(path)) return;
    this.#projects.set(path, projectDoc);
    this.projects.set(path, projectDoc);
  }

  #fillCatalog(kernel: KernelDocument): void {
    const generation = (this.#catalogGeneration += 1);
    const stale = (): boolean => generation !== this.#catalogGeneration;
    const paths = Object.keys(kernel.root.projects);
    void (async () => {
      for (const path of paths) {
        if (stale()) return;
        if (this.#projects.has(path)) continue;
        const staged: Staged = { rooms: new Map(), projects: new Map(), sessions: new Map() };
        try {
          const projectDoc = await this.#project(path, staged, stale);
          if (!stale() && projectDoc != null) {
            runInAction(() => {
              if (stale()) return;
              for (const [key, room] of staged.rooms) this.#rooms.set(key, room);
              this.#projects.set(path, projectDoc);
              this.projects.set(path, projectDoc);
              staged.rooms.clear();
            });
          }
        } catch {
          // A catalog miss leaves that project collapsed. The route can still attach it.
        } finally {
          for (const room of staged.rooms.values()) this.#destroyRoom(room);
        }
      }
    })();
  }

  #dropExcept(keys: ReadonlySet<string>): void {
    for (const [key, room] of this.#rooms) {
      if (key === "kernel" || key.startsWith("project:") || keys.has(key)) continue;
      this.#destroyRoom(room);
      this.#rooms.delete(key);
      if (key.startsWith("project:")) this.#projects.delete(key.slice("project:".length));
      if (key.startsWith("session:")) this.#sessions.delete(key.slice("session:".length));
    }
  }
}

/** Remote mode redials unless the machine refused the room (the default would also stop on 4401 to 4499). */
function shouldReconnect(event: CloseEvent): boolean {
  return !isRefusal(event.code);
}

export function dialOrigin(location: Location): string {
  return appLocation(location).roomOrigin;
}
