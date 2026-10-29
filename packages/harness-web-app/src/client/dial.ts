import type { RegionGraph } from "@here.build/arrival-provenance";
import type { WorkflowFrame } from "@inhuman.tools/harness-model/session";
import {
  bindJsonRpc,
  bindProviderAwareness,
  destroyProvider,
  detachProtocolAwareness,
  KERNEL_DOC_GUID,
  KernelPlexus,
  ProjectPlexus,
  publishRevalidationDemand,
  SessionPlexus,
  waitForSync,
  type JsonRpcPort,
} from "@inhuman.tools/harness-peer";
import { makeObservable, observable, runInAction } from "mobx";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import { cacheKey, CACHE_ORIGIN, guardProvider, writeBehind, type DocCache, type Writer } from "./doc-cache.js";
import type { RouteTarget } from "../shell/path.js";
import { type Feed, foldFrame } from "../workflow/feed.js";

type Held = {
  readonly provider: WebsocketProvider;
  readonly doc: Y.Doc;
  stop: () => void;
  /** The kernel room's JSON-RPC port; the only way a tab without a session writes to the daemon. */
  rpc?: JsonRpcPort;
  /** The cache's write side; released with the room. */
  cache?: Writer;
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
  | { readonly kind: "reconnecting" };

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

type Session = { plexus: SessionPlexus; rpc: JsonRpcPort };
type Staged = {
  rooms: Map<string, Held>;
  projects: Map<string, ProjectPlexus>;
  sessions: Map<string, Session>;
};

export class Dial {
  kernel: KernelPlexus | null = null;
  /** Every known project, attached for the sidebar. Not dropped on route changes. */
  projects = new Map<string, ProjectPlexus>();
  project: ProjectPlexus | null = null;
  session: SessionPlexus | null = null;
  sessionRpc: JsonRpcPort | null = null;
  /** Kernel-plane JSON-RPC, open once the kernel room synced. Kernel documents are read-only here. */
  kernelRpc: JsonRpcPort | null = null;
  target: RouteTarget = { kind: "kernel" };
  requestedTarget: RouteTarget = { kind: "kernel" };
  link: Link | null = null;
  attaching = true;
  #generation = 0;
  /** Sidebar attachments. A newer kernel wins; a route change does not cancel them. */
  #catalogGeneration = 0;
  /** Set when a staged first message is sent. Consumed only after a matching successful attachment. */
  #mintId: string | null = null;
  #mintGeneration = 0;
  readonly #cache: DocCache | null;
  readonly #rooms = new Map<string, Held>();
  readonly #projects = new Map<string, ProjectPlexus>();
  readonly #sessions = new Map<string, Session>();

  /** `cache` keeps each room's document on the device so a redial fetches only the delta. */
  constructor(
    readonly origin: string,
    options: { readonly cache?: DocCache } = {},
  ) {
    this.#cache = options.cache ?? null;
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
   * A session's port for one write, without seating it. The open session is reused.
   * Anything else is a room that closes when the write finishes.
   */
  async borrowSession<T>(
    sessionId: string,
    path: string,
    run: (rpc: JsonRpcPort, plexus: SessionPlexus) => Promise<T>,
  ): Promise<T> {
    const seated = this.#sessions.get(sessionId);
    if (seated != null) return run(seated.rpc, seated.plexus);
    const doc = new Y.Doc({ guid: `harness:session:${sessionId}` });
    const params: Record<string, string> = { sessionId };
    if (path !== "") params.path = path;
    const room = await this.#connect("session", params, doc, () => false, undefined, 60_000);
    if (room == null) throw new Error("Could not open the session.");
    const plexus = SessionPlexus.connect(room.doc);
    const rpc = bindJsonRpc(room.provider);
    room.rpc = rpc;
    room.stop = bindProviderAwareness(plexus.awareness, room.provider);
    try {
      return await run(rpc, plexus);
    } finally {
      this.#destroyRoom(room);
    }
  }

  /**
   * Another session's room to read: synced and live, never seated, no port to
   * write through. Route changes do not drop it; the caller releases it.
   */
  async peek(sessionId: string, signal?: AbortSignal): Promise<{ plexus: SessionPlexus; release: () => void }> {
    const doc = new Y.Doc({ guid: `harness:session:${sessionId}` });
    const room = await this.#connect("session", { sessionId }, doc, () => signal?.aborted === true, signal);
    if (room == null) throw new Error("Peek cancelled.");
    const plexus = SessionPlexus.connect(room.doc);
    room.stop = bindProviderAwareness(plexus.awareness, room.provider);
    return { plexus, release: () => this.#destroyRoom(room) };
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
    const url = `${this.origin.replace(/^ws/, "http")}/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(jobId)}`;
    let feed: Feed | null = null;
    let source: EventSource | null = null;
    const close = (): void => source?.close();
    const open = (): void => {
      const mine = (source = new EventSource(url));
      mine.addEventListener("message", (event) => {
        let frame: WorkflowFrame;
        try {
          frame = JSON.parse(event.data as string) as WorkflowFrame;
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
      let project: ProjectPlexus | null = null;
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
        for (const [path, plexus] of staged.projects) {
          this.#projects.set(path, plexus);
          this.projects.set(path, plexus);
        }
        for (const [id, held] of staged.sessions) this.#sessions.set(id, held);
        staged.rooms.clear();
        this.kernel = kernel;
        this.kernelRpc = this.#rooms.get("kernel")?.rpc ?? null;
        this.#fillCatalog(kernel);
        if (project != null && projectPath !== "") this.#holdProject(projectPath, project);
        this.target = target;
        this.project = project;
        this.session = session?.plexus ?? null;
        this.sessionRpc = session?.rpc ?? null;
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

  async #kernel(staged: Staged, stale: () => boolean, signal?: AbortSignal): Promise<KernelPlexus | null> {
    if (this.kernel != null && this.#rooms.has("kernel")) return this.kernel;
    const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
    const room = await this.#connect("kernel", {}, doc, stale, signal);
    if (room == null) return null;
    staged.rooms.set("kernel", room);
    const plexus = KernelPlexus.connect(room.doc);
    room.stop = bindProviderAwareness(plexus.awareness, room.provider);
    room.rpc = bindJsonRpc(room.provider);
    return plexus;
  }

  async #project(
    path: string,
    staged: Staged,
    stale: () => boolean,
    signal?: AbortSignal,
  ): Promise<ProjectPlexus | null> {
    const cached = this.#projects.get(path);
    if (cached != null) return cached;
    const doc = new Y.Doc();
    const room = await this.#connect("project", { path }, doc, stale, signal);
    if (room == null) return null;
    staged.rooms.set(`project:${path}`, room);
    const plexus = ProjectPlexus.connect(room.doc);
    staged.projects.set(path, plexus);
    return plexus;
  }

  async #openSession(
    path: string | null,
    sessionId: string,
    mint: boolean,
    staged: Staged,
    stale: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ project: ProjectPlexus | null; projectPath: string; session: Session } | null> {
    let held = this.#sessions.get(sessionId);
    if (held == null) {
      const doc = new Y.Doc({ guid: `harness:session:${sessionId}` });
      const params: Record<string, string> = { sessionId };
      if (mint) params.path = path ?? "";
      const listed = this.kernel?.root.sessions[sessionId] != null;
      // A listed session may still be replaying a long image before the socket opens.
      const room = await this.#connect("session", params, doc, stale, signal, listed && !mint ? 60_000 : 8_000).catch(
        (error: unknown) => {
          if (stale() || mint) throw error;
          const link = attachLink(error);
          if (link.kind !== "unreachable") throw error;
          // The kernel has answered. Missing means its list does not have this id.
          if (!listed) throw new LinkError({ kind: "missing", sessionId });
          throw new LinkError({ kind: "unanswered" });
        },
      );
      if (room == null) return null;
      staged.rooms.set(`session:${sessionId}`, room);
      const plexus = SessionPlexus.connect(room.doc);
      const rpc = bindJsonRpc(room.provider);
      room.stop = bindProviderAwareness(plexus.awareness, room.provider);
      held = { plexus, rpc };
      staged.sessions.set(sessionId, held);
    }
    if (stale()) return null;
    const projectPath =
      held.plexus.root.agent.spec.recipeScope === "global" ? "" : mint ? (path ?? "") : held.plexus.root.path;
    if (path != null && (projectPath === "" || path !== projectPath)) {
      throw new LinkError({ kind: "elsewhere", sessionId, path: projectPath });
    }
    const project = projectPath === "" ? null : await this.#project(projectPath, staged, stale, signal);
    if (stale()) return null;
    return { project, projectPath, session: held };
  }

  /**
   * Seat a room. With a cache the doc starts from what the device kept, and the daemon is only
   * asked for the difference. A cache the daemon does not contain is dropped and the room
   * starts over empty, so the doc handed back may not be the one passed in: use `room.doc`.
   */
  async #connect(
    roomName: string,
    params: Record<string, string>,
    doc: Y.Doc,
    stale: () => boolean,
    signal?: AbortSignal,
    timeoutMs = 8_000,
  ): Promise<Held | null> {
    if (stale()) {
      doc.destroy();
      return null;
    }
    const cache = this.#cache;
    const key = cache == null ? "" : cacheKey(this.origin, roomName, params);
    let useCache = cache != null;
    for (;;) {
      const room = await this.#attempt(roomName, params, doc, useCache ? cache : null, key, stale, signal, timeoutMs);
      if (room !== "restart") return room;
      // The cache held something the daemon does not: forget it and sync everything.
      cache?.drop(key);
      useCache = false;
      doc = new Y.Doc({ guid: doc.guid });
      if (stale()) {
        doc.destroy();
        return null;
      }
    }
  }

  async #attempt(
    roomName: string,
    params: Record<string, string>,
    doc: Y.Doc,
    reading: DocCache | null,
    key: string,
    stale: () => boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Held | null | "restart"> {
    const cache = this.#cache;
    let loaded: readonly Uint8Array[] = [];
    if (reading != null) {
      try {
        loaded = (await reading.load(key)) ?? [];
        // A superseded attach should not pay to apply tens of megabytes.
        if (stale()) {
          doc.destroy();
          return null;
        }
        for (const update of loaded) Y.applyUpdate(doc, update, CACHE_ORIGIN);
      } catch {
        // An unreadable cache is no cache.
        cache?.drop(key);
        loaded = [];
        doc.destroy();
        doc = new Y.Doc({ guid: doc.guid });
      }
      if (stale()) {
        doc.destroy();
        return null;
      }
    }
    // The default redial: before sync a failure destroys the provider; after it, a drop reconnects.
    const provider = new WebsocketProvider(this.origin, roomName, doc, { params, disableBc: true });
    provider.disconnectBc = () => undefined;
    detachProtocolAwareness(provider);
    const writer = cache == null ? undefined : writeBehind(cache, key, doc, loaded, provider);
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      writer?.abandon();
      destroyProvider(provider);
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
    let restart = false;
    if (cache != null) {
      guardProvider(
        provider,
        doc,
        loaded.length > 0,
        () => provider.synced,
        (afterSync) => {
          if (afterSync) {
            // A redial found the daemon behind the doc. The doc stays; the next launch starts clean.
            writer?.abandon();
            cache.drop(key);
            return;
          }
          restart = true;
          destroy();
          rejectAbort(new Error("Cache is stale."));
        },
      );
    }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      await Promise.race([waitForSync(provider, roomName, timeoutMs), aborted]);
    } catch (error) {
      destroy();
      if (restart) return "restart";
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    if (stale()) {
      destroy();
      return null;
    }
    writer?.synced();
    provider.on("status", () => this.#relink());
    // A permanent close ends the redial; the room is gone until a retry attaches again.
    provider.on("closed", () => {
      if ([...this.#rooms.values()].some((room) => room.provider === provider)) {
        runInAction(() => {
          this.link = { kind: "unreachable" };
        });
      }
    });
    return { provider, doc, stop: () => undefined, cache: writer };
  }

  /** Any held room that wants its socket and lacks it: the line is down and redialing. */
  #relink(): void {
    const down = [...this.#rooms.values()].some((room) => room.provider.shouldConnect && !room.provider.wsconnected);
    runInAction(() => {
      if (down && this.link == null) this.link = { kind: "reconnecting" };
      else if (!down && this.link?.kind === "reconnecting") this.link = null;
    });
  }

  #destroyRoom(room: Held): void {
    room.rpc?.rejectAll(new Error("room closed"));
    room.stop();
    room.cache?.release(true);
    destroyProvider(room.provider);
    room.doc.destroy();
  }

  /** Move a staged kernel into the live dial so a later session failure cannot drop it. */
  #publishKernel(staged: Staged, kernel: KernelPlexus): void {
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

  #holdProject(path: string, plexus: ProjectPlexus): void {
    if (this.projects.has(path)) return;
    this.#projects.set(path, plexus);
    this.projects.set(path, plexus);
  }

  #fillCatalog(kernel: KernelPlexus): void {
    const generation = (this.#catalogGeneration += 1);
    const stale = (): boolean => generation !== this.#catalogGeneration;
    const paths = Object.keys(kernel.root.projects);
    void (async () => {
      for (const path of paths) {
        if (stale()) return;
        if (this.#projects.has(path)) continue;
        const staged: Staged = { rooms: new Map(), projects: new Map(), sessions: new Map() };
        try {
          const plexus = await this.#project(path, staged, stale);
          if (!stale() && plexus != null) {
            runInAction(() => {
              if (stale()) return;
              for (const [key, room] of staged.rooms) this.#rooms.set(key, room);
              this.#projects.set(path, plexus);
              this.projects.set(path, plexus);
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

export function dialOrigin(location: Location): string {
  const dial = new URLSearchParams(location.search).get("dial");
  if (dial != null && dial !== "") return dial;
  return `ws://${location.host}`;
}
