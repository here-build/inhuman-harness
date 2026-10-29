import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";

import { fail, step } from "@inhuman.tools/harness-diagnostics";
import { projectBotSpecs, ProjectPlexus, type SessionPlexus } from "@inhuman.tools/harness-model";
import { projectSessionsDir } from "@inhuman.tools/harness-sdk/paths";
import { namedWorkerIds } from "@inhuman.tools/turn/agent-calls";
import { observable, runInAction } from "mobx";
import invariant from "tiny-invariant";

import { isConversationSession, PrivatePluginMcpHost } from "@/runtime";
import { ToolCallHandler } from "@/tool-runtime";
import { attachLens, type PlaneSocket } from "@/yjs";

import { RequestHost } from "../../contract.js";
import { writeConnectionSecrets } from "../../secrets.js";
import {
  bindProjectPrivateMcpHost,
  bindProjectRecipes,
  unbindProjectPrivateMcpHost,
  unbindProjectRecipes,
} from "../../toolkit/tool-table.js";
import { botChangeNotice, BotsWatcher, overlayBotDir, projectBotsDir, queueBotNotice } from "../bots/index.js";
import type { KernelDaemon } from "../kernel/KernelDaemon.js";
import { SessionDaemon } from "../session/SessionDaemon.js";

export class ProjectDaemon extends RequestHost implements Disposable {
  readonly path: string;
  plexus!: ProjectPlexus;
  readonly toolCalls: ToolCallHandler;
  readonly ready: Promise<void>;
  @observable.shallow accessor sessions: Record<string, SessionDaemon> = {};
  readonly #privateMcpHost: PrivatePluginMcpHost;
  readonly #reattaching = new Set<string>();
  readonly #attaching = new Map<string, Promise<SessionDaemon>>();
  #botsWatcher: BotsWatcher | null = null;
  #botsSnapshot = new Map<string, string>();

  constructor(
    readonly kernel: KernelDaemon,
    workspacePath: string,
    readonly globalHost = false,
  ) {
    super();
    const path = realpathSync(workspacePath);
    invariant(statSync(path).isDirectory(), `ProjectDaemon: not a directory: ${workspacePath}`);
    this.path = path;
    kernel.registerProject(this);
    this.toolCalls = new ToolCallHandler(kernel);
    const pluginRoots = new Map<string, string>();
    for (const [key, spec] of Object.entries(kernel.plexus.root.plugins)) {
      const name = spec.pluginName.trim() === "" ? key : spec.pluginName;
      pluginRoots.set(name, spec.rootPath);
    }
    this.#privateMcpHost = new PrivatePluginMcpHost({
      catalog: kernel.catalog,
      workspacePath: path,
      pluginRoots,
      connections: kernel.plexus.root.connections,
      drivers: kernel.plexus.root.drivers,
      writeSecrets: (id, secrets) => writeConnectionSecrets(kernel.root, id, { ...secrets }),
    });
    bindProjectPrivateMcpHost(this.kernel.catalog, path, this.#privateMcpHost);
    mkdirSync(projectSessionsDir(path), { recursive: true });
    this.ready = (async () => {
      const loaded = await kernel.loadProjectDoc(path);
      if (kernel.disposed) return;
      this.plexus = loaded.existing ? ProjectPlexus.connect(loaded.doc) : ProjectPlexus.create(path, loaded.doc);
      this.#syncProjectBots(false);
      this.#botsWatcher = new BotsWatcher(projectBotsDir(path), () => this.#syncProjectBots(true));
      if (kernel.disposed) return;
      await this.bootstrapMidMotionNamed();
    })().catch((error: unknown) => {
      // Leave the path free so the next lookup loads it again.
      this[Symbol.dispose]();
      throw error;
    });
  }

  get root() {
    return this.plexus.root;
  }

  async session(id: string = randomUUID()): Promise<SessionDaemon> {
    await this.ready;
    return this.#attach(id, true);
  }

  /** Occupancy/eligibility wrap: honor only if the session is graph-eligible. */
  async attachEligible(id: string): Promise<SessionDaemon> {
    await this.ready;
    return this.#attach(id, false);
  }

  /**
   * Kernel/project reload: wrap interned mid-motion SessionRoots only.
   * Idle roster names stay on the document, not bootstrapped.
   */
  async bootstrapMidMotionNamed(): Promise<void> {
    const ids = new Set(Object.values(this.globalHost ? this.kernel.plexus.root.botsRoster : this.root.botsRoster));
    for (const id of ids) {
      if (this.sessions[id] != null) continue;
      const plexus = await this.#peer(id);
      if (!plexus?.root.isMidMotion()) continue;
      if (!this.kernel.graphEligibleSessionIds().has(id)) continue;
      await this.#attach(id, false);
    }
  }

  async #attach(id: string, forceHonor = false): Promise<SessionDaemon> {
    const pending = this.#attaching.get(id);
    if (pending != null) return pending;
    const run = this.#attachNow(id, forceHonor);
    this.#attaching.set(id, run);
    try {
      return await run;
    } finally {
      if (this.#attaching.get(id) === run) this.#attaching.delete(id);
    }
  }

  async #attachNow(id: string, forceHonor: boolean): Promise<SessionDaemon> {
    if (this.kernel.disposed) {
      const held = this.sessions[id];
      if (held !== undefined && held.interpreting) return held;
      const live = this.kernel.liveSession(id);
      if (live != null) return live;
      throw new Error("kernel disposed");
    }
    const existing = this.sessions[id];
    if (existing !== undefined && existing.interpreting) {
      this.kernel.internSession(id, existing.plexus, existing);
      step(`session attach ${id}`);
      await this.#reattachNamed(existing);
      return existing;
    }
    if (existing !== undefined) {
      await existing.park();
      runInAction(() => {
        delete this.sessions[id];
      });
    }
    const live = this.kernel.liveSession(id);
    if (live != null) {
      this.kernel.internSession(id, live.plexus, live);
      step(`session intern ${id}`);
      return live;
    }
    const interned = this.kernel.sessionPlexus(id) ?? (await this.kernel.acquireSession(id));
    if (interned?.root.agent.spec.recipeScope === "global" && !this.globalHost) return this.kernel.globalSession(id);
    if (interned != null && interned.root.path !== this.path) {
      const host = this.kernel.project(interned.root.path);
      return forceHonor ? host.session(id) : host.attachEligible(id);
    }
    const created =
      interned == null
        ? new SessionDaemon(this, id, await this.kernel.mintSessionDocument(id, this.path), false)
        : new SessionDaemon(this, id, interned, true);
    this.kernel.internSession(id, created.plexus);
    step(interned == null ? `session mint ${id}` : `session rebootstrap ${id}`);
    try {
      await created.recover();
      if (forceHonor && interned != null && isConversationSession(created.root)) {
        this.kernel.reserveAttachment(id);
      }
      await this.#reattachNamed(created);
      if (forceHonor || this.kernel.graphEligibleSessionIds().has(id)) {
        created.activate();
        runInAction(() => {
          this.sessions[id] = created;
        });
        this.kernel.internSession(id, created.plexus, created);
      } else {
        created.releaseReady();
      }
      await created.ready;
      return created;
    } catch (error) {
      runInAction(() => {
        delete this.sessions[id];
      });
      void created.park().catch((parkError: unknown) => fail(`session ${id} park`, parkError));
      throw error;
    }
  }

  async #reattachNamed(session: SessionDaemon): Promise<void> {
    if (this.#reattaching.has(session.sessionId)) return;
    this.#reattaching.add(session.sessionId);
    try {
      for (const id of namedWorkerIds(session.root)) {
        if (id === session.sessionId) continue;
        if (this.#attaching.has(id)) continue;
        const plexus = await this.#peer(id);
        if (this.sessions[id] == null && plexus == null) continue;
        if (this.kernel.graphEligibleSessionIds().has(id)) await this.#attach(id, false);
      }
      for (const callerId of new Set(Object.values(session.root.agentCallbacks))) {
        if (callerId === "" || callerId === session.sessionId) continue;
        if (this.#attaching.has(callerId)) continue;
        const caller = await this.#peer(callerId);
        if (caller?.root.path !== this.path) continue;
        if (this.kernel.graphEligibleSessionIds().has(callerId)) await this.#attach(callerId, false);
      }
    } finally {
      this.#reattaching.delete(session.sessionId);
    }
  }

  /** A peer that cannot open is logged; it does not fail this project's attach. */
  async #peer(id: string): Promise<SessionPlexus | undefined> {
    try {
      return this.kernel.sessionPlexus(id) ?? (await this.kernel.acquireSession(id));
    } catch (error) {
      fail(`session ${id}`, error);
      return undefined;
    }
  }

  protected override get parent() {
    return this.kernel;
  }

  protected override attach(socket: PlaneSocket): void {
    attachLens(this.plexus.doc, socket);
  }

  #syncProjectBots(notice: boolean): void {
    const { recipes, faces, snap } = overlayBotDir(projectBotsDir(this.path), this.kernel.catalog.allRecipes());
    projectBotSpecs(this.root, faces);
    bindProjectRecipes(this.kernel.catalog, this.path, recipes);
    if (notice) {
      const text = botChangeNotice(this.#botsSnapshot, snap);
      if (text !== "") {
        for (const session of Object.values(this.sessions)) {
          if (session.interpreting) queueBotNotice(session.root, text);
        }
      }
    }
    this.#botsSnapshot = new Map(snap);
  }

  [Symbol.dispose](): void {
    this.kernel.dropProject(this);
    unbindProjectRecipes(this.kernel.catalog, this.path);
    unbindProjectPrivateMcpHost(this.kernel.catalog, this.path);
    this.#botsWatcher?.[Symbol.dispose]();
    this.#botsWatcher = null;
    this.#privateMcpHost[Symbol.dispose]();
    for (const session of Object.values(this.sessions)) {
      void session.park().catch((error: unknown) => fail(`session ${session.sessionId} park`, error));
    }
    runInAction(() => {
      this.sessions = {};
    });
    if (this.kernel.disposed) this.plexus?.awareness.destroy();
  }
}
