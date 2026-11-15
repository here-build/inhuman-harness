import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";

import type { ProjectKind } from "@inhuman.tools/harness-contract/schema";
import { fail, step } from "@inhuman.tools/harness-diagnostics";
import {
  BotSpec,
  projectBotSpecs,
  ProjectDocument,
  SessionTurn,
  type SessionDocument,
} from "@inhuman.tools/harness-model";
import type { KvProposal, PermissionMode } from "@inhuman.tools/harness-model/shared";
import { projectSessionsDir } from "@inhuman.tools/harness-sdk/paths";
import {
  InhumanTool,
  type ActivatedProjectPlugin,
  type BotDefinition,
  type ToolDefinition,
  type WorkspaceEnvPort,
} from "@inhuman.tools/plugin-sdk";
import { namedWorkerIds } from "@inhuman.tools/turn/agent-calls";
import { observable, reaction, runInAction, type IReactionDisposer } from "mobx";
import invariant from "tiny-invariant";

import { isConversationSession, PrivatePluginMcpHost } from "@/runtime";
import { catalogRecipe, type CatalogEntry, type CatalogRecipe } from "@/tool-catalog";
import {
  bindWorkspaceEnv,
  createLocalFsWorkspaceEnv,
  createVirtualWorkspaceEnv,
  ToolCallHandler,
} from "@/tool-runtime";

import { RequestHost } from "../../contract.js";
import {
  HOST_PLUGINS,
  LOCAL_ENV_PLUGIN_NAME,
  SYSTEM_PLUGIN_NAMES,
  expandPluginNames,
  systemEntriesFor,
} from "../../system-plugins/index.js";
import { catalogEntryFromTool, parametersFromZod } from "../../toolkit/tool-entry.js";
import {
  KernelToolCatalog,
  bindProjectPrivateMcpHost,
  bindProjectRecipes,
  unbindProjectPrivateMcpHost,
  unbindProjectRecipes,
} from "../../toolkit/tool-table.js";
import { attachPlane, PresenceRoom, type PlaneSocket } from "../../transport/plane.js";
import { botChangeNotice, BotsWatcher, overlayBotDir, projectBotsDir, queueBotNotice } from "../bots/index.js";
import type { KernelDaemon } from "../kernel/KernelDaemon.js";
import { SessionDaemon } from "../session/SessionDaemon.js";

export class ProjectDaemon extends RequestHost implements Disposable, AsyncDisposable {
  readonly path: string;
  projectId: string;
  kind: ProjectKind;
  title: string;
  doc!: ProjectDocument;
  readonly toolCalls: ToolCallHandler;
  readonly effectiveCatalog: KernelToolCatalog;
  workspaceEnv: WorkspaceEnvPort;
  effectiveEnabledPlugins: ReadonlySet<string> = new Set();
  @observable accessor projectPluginStamp = 0;
  readonly ready: Promise<void>;
  @observable.shallow accessor sessions: Record<string, SessionDaemon> = {};
  readonly #privateMcpHost: PrivatePluginMcpHost;
  readonly #reattaching = new Set<string>();
  readonly #attaching = new Map<string, Promise<SessionDaemon>>();
  /** Recovered (`phase === "ready"`) daemons waiting for seat/grant/command activation. */
  readonly #readySessions = new Map<string, SessionDaemon>();
  #activatedPlugins: ActivatedProjectPlugin[] = [];
  #activatedEntries: CatalogEntry[] = [];
  #pluginBotRecipes: CatalogRecipe[] = [];
  #pluginBotFaces: BotSpec[] = [];
  #reconcileChain: Promise<void> = Promise.resolve();
  #disposeCatalogSync: IReactionDisposer | null = null;
  #presence: PresenceRoom | null = null;
  #botsWatcher: BotsWatcher | null = null;
  #botsSnapshot = new Map<string, string>();
  #disposed = false;
  #disposingPromise: Promise<void> | null = null;

  constructor(
    readonly kernel: KernelDaemon,
    workspacePath: string,
    readonly globalHost = false,
  ) {
    super();
    const storedRow = globalHost
      ? undefined
      : kernel.db
          .listProjects(kernel.kernelId)
          .find((row) => row.workspacePath === workspacePath || row.projectId === workspacePath);
    const pendingKind = kernel.pendingKindFor(workspacePath);
    const initialKind: ProjectKind =
      storedRow?.kind ??
      pendingKind ??
      (kernel.contour === "server" && (globalHost || !existsSync(workspacePath)) ? "virtual" : "local");
    const isServerVirtual =
      initialKind !== "local" || (kernel.contour === "server" && (globalHost || !existsSync(workspacePath)));
    const path = isServerVirtual ? workspacePath : realpathSync(workspacePath);
    if (!isServerVirtual) {
      invariant(statSync(path).isDirectory(), `ProjectDaemon: not a directory: ${workspacePath}`);
    }
    this.path = path;
    const initialProjectId = storedRow?.projectId ?? (globalHost ? "" : `project:${path}`);
    const initialTitle = storedRow?.title ?? "";
    this.kind = initialKind;
    this.projectId = initialProjectId;
    this.title = initialTitle;
    this.workspaceEnv =
      initialKind === "local" && (kernel.contour === "local" || existsSync(path))
        ? createLocalFsWorkspaceEnv(path)
        : createVirtualWorkspaceEnv(path);
    this.effectiveCatalog = new KernelToolCatalog();
    this.effectiveCatalog.workerHost = kernel.catalog.workerHost;
    this.effectiveCatalog.connectionHost = {
      get connectionEntries() {
        return kernel.catalog.connectionEntries;
      },
    };
    kernel.registerProject(this);
    this.toolCalls = new ToolCallHandler({
      catalog: this.effectiveCatalog,
    });
    const pluginRoots = new Map<string, string>();
    for (const [key, spec] of Object.entries(kernel.doc.root.plugins)) {
      const name = spec.pluginName.trim() === "" ? key : spec.pluginName;
      pluginRoots.set(name, spec.rootPath);
    }
    this.#privateMcpHost = new PrivatePluginMcpHost({
      catalog: kernel.catalog,
      workspacePath: path,
      pluginRoots,
      connections: kernel.doc.root.connections,
      drivers: kernel.doc.root.drivers,
      writeSecrets: (id, secrets) => kernel.secrets.writeConnectionSecrets(id, { ...secrets }),
    });
    bindProjectPrivateMcpHost(this.kernel.catalog, path, this.#privateMcpHost);
    bindProjectPrivateMcpHost(this.effectiveCatalog, path, this.#privateMcpHost);
    this.#disposeCatalogSync = reaction(
      () =>
        [
          kernel.catalog.packEntries,
          kernel.catalog.pluginInstall,
          kernel.catalog.recipes,
          kernel.catalog.compiledRecipes,
          kernel.catalog.surfaceRecipes,
          kernel.catalog.botRevisions,
          kernel.catalog.TOOLS_SYSTEM_ADDENDUM,
          kernel.catalog.enabledHostPlugins,
        ] as const,
      () => {
        if (this.#disposed) return;
        runInAction(() => {
          this.effectiveCatalog.pluginInstall = kernel.catalog.pluginInstall;
          this.effectiveCatalog.compiledRecipes = [...kernel.catalog.compiledRecipes];
          this.effectiveCatalog.recipes = [...kernel.catalog.recipes];
          this.effectiveCatalog.surfaceRecipes = [...kernel.catalog.surfaceRecipes];
          this.effectiveCatalog.botRevisions = kernel.catalog.botRevisions;
          if (!kernel.catalog.hasManagedAddendum()) {
            this.effectiveCatalog.TOOLS_SYSTEM_ADDENDUM = kernel.catalog.TOOLS_SYSTEM_ADDENDUM;
          }
          this.#syncEffectiveCatalogEntries();
        });
      },
      { fireImmediately: true },
    );
    if (!isServerVirtual) {
      mkdirSync(projectSessionsDir(path), { recursive: true });
    }
    this.ready = (async () => {
      const loaded = await kernel.loadProjectDoc(path);
      if (kernel.disposed || this.#disposed) return;
      this.doc = loaded.existing ? ProjectDocument.connect(loaded.doc) : ProjectDocument.create(path, loaded.doc);
      if (this.doc.root.path !== path) {
        runInAction(() => {
          this.doc.root.path = path;
        });
      }
      const persistedRow = globalHost
        ? undefined
        : kernel.db.listProjects(kernel.kernelId).find((row) => row.workspacePath === path || row.projectId === path);
      if (!loaded.existing && persistedRow !== undefined) {
        const persistedEnabled = parseStringArrayJson(persistedRow.enabledPluginsJson);
        this.doc.root.configureOverlay({
          projectId: persistedRow.projectId,
          kind: persistedRow.kind,
          title: persistedRow.title,
          ...(persistedEnabled.length > 0 || persistedRow.kind === "virtual"
            ? { enabledPlugins: persistedEnabled }
            : {}),
          pluginConfigs: parsePluginConfigJsonStrings(persistedRow.pluginConfigsJson),
        });
      } else if (!loaded.existing) {
        this.doc.root.configureOverlay({
          projectId: initialProjectId,
          kind: initialKind,
          title: initialTitle,
        });
      }
      if (this.doc.root.projectId !== "") this.projectId = this.doc.root.projectId;
      this.kind = this.doc.root.kind;
      this.title = this.doc.root.title;
      await this.reconcileProjectPlugins();
      if (kernel.disposed || this.#disposed) return;
      this.#presence = new PresenceRoom(this.doc.awareness);
      this.#syncProjectBots(false);
      if (!this.globalHost && this.kind === "local" && existsSync(path)) {
        this.#botsWatcher = new BotsWatcher(projectBotsDir(path), () => this.#syncProjectBots(true));
      }
      if (kernel.disposed || this.#disposed) return;
      await this.bootstrapMidMotionNamed();
    })().catch((error: unknown) => {
      // Leave the path free so the next lookup loads it again.
      this[Symbol.dispose]();
      throw error;
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get root() {
    return this.doc.root;
  }

  writeKvs(proposals: readonly KvProposal[]): void {
    this.root.applyKvs(proposals);
  }

  rememberModelChoice(connection: string, model: string): void {
    this.root.stampLastUsedConnectionModel(connection, model);
  }

  writeDefaultPermissionMode(policy: PermissionMode): void {
    runInAction(() => {
      this.root.defaultPermissionMode = policy;
    });
  }

  writeAuthorizationOverlay(json: string): void {
    runInAction(() => {
      if (this.root.authorizationJson !== json) this.root.authorizationJson = json;
    });
  }

  async applyConfiguration(next: {
    readonly projectId: string;
    readonly kind: ProjectKind;
    readonly title: string;
    readonly pluginsConfigured: boolean;
    readonly enabledPlugins: readonly string[];
    readonly pluginConfigs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }): Promise<void> {
    this.projectId = next.projectId;
    this.kind = next.kind;
    this.title = next.title;
    const serializedConfigs: Record<string, string> = {};
    for (const [k, v] of Object.entries(next.pluginConfigs)) {
      serializedConfigs[k] = JSON.stringify(v);
    }
    this.root.configureOverlay({
      projectId: next.projectId,
      kind: next.kind,
      title: next.title,
      ...(next.pluginsConfigured ? { enabledPlugins: next.enabledPlugins } : {}),
      pluginConfigs: serializedConfigs,
    });
    if (!next.pluginsConfigured && this.root.pluginsConfigured) {
      runInAction(() => {
        this.root.pluginsConfigured = false;
      });
    }
    this.kernel.flushProjectDoc(this.path, { force: true });
    this.kernel.db.upsertProject({
      projectId: next.projectId,
      kernelId: this.kernel.kernelId,
      title: next.title,
      kind: next.kind,
      workspacePath: this.path,
      defaultPermissionMode: this.root.defaultPermissionMode,
      authorizationJson: this.root.authorizationJson,
      kvsJson: JSON.stringify(this.root.kvs),
      lastUsedModelJson: JSON.stringify(this.root.lastUsedConnectionModel),
      enabledPluginsJson: JSON.stringify(next.enabledPlugins),
      pluginConfigsJson: JSON.stringify(next.pluginConfigs),
      botsRosterJson: JSON.stringify(this.root.botsRoster),
      updatedAtMs: Date.now(),
    });
    await this.reconcileProjectPlugins();
    runInAction(() => {
      for (const session of this.#readySessions.values()) {
        if (!session.closed && session.root.head instanceof SessionTurn) {
          session.root.head.reloadTools = true;
        }
      }
      for (const session of Object.values(this.sessions)) {
        if (!session.closed && session.root.head instanceof SessionTurn) {
          session.root.head.reloadTools = true;
        }
      }
    });
    this.#syncProjectBots(false);
  }

  reconcileProjectPlugins(): Promise<void> {
    const run = this.#reconcileChain.then(
      () => this.#reconcileProjectPluginsNow(),
      () => this.#reconcileProjectPluginsNow(),
    );
    this.#reconcileChain = run.catch(() => {});
    return run;
  }

  async #reconcileProjectPluginsNow(): Promise<void> {
    if (this.#disposed || this.kernel.disposed || this.doc == null || this.doc.isDestroyed) return;
    const prior = this.#activatedPlugins;
    this.#activatedPlugins = [];
    await disposeActivatedPlugins(prior);
    if (this.#disposed || this.kernel.disposed) return;

    const effectiveEnabled = this.doc.root.pluginsConfigured
      ? expandPluginNames(this.doc.root.enabledPlugins)
      : this.kernel.effectiveEnabledPluginNames();
    this.effectiveEnabledPlugins = effectiveEnabled;

    const nextActivated: ActivatedProjectPlugin[] = [];
    const activatedEntries: CatalogEntry[] = [];
    const activatedBotRecipes: CatalogRecipe[] = [];
    const activatedBotFaces: BotSpec[] = [];
    let nextWorkspaceEnv: WorkspaceEnvPort | undefined;

    const candidates = this.globalHost
      ? {}
      : {
          ...HOST_PLUGINS,
          ...this.kernel.runtimePlugins,
        };

    for (const [pluginName, plugin] of Object.entries(candidates)) {
      if (plugin.activateProject === undefined) continue;
      if (!effectiveEnabled.has(pluginName)) continue;

      const rawConfigText =
        this.doc.root.pluginConfigs[pluginName] ??
        (pluginName === "toolkit" || pluginName === "shell"
          ? this.doc.root.pluginConfigs[LOCAL_ENV_PLUGIN_NAME]
          : undefined);
      const rawConfig = parseSinglePluginConfig(rawConfigText);
      let config = rawConfig;
      if (plugin.projectConfigSchema !== undefined) {
        if (rawConfigText === undefined) {
          const parsed = plugin.projectConfigSchema.safeParse(rawConfig);
          if (!parsed.success) continue;
          config = parsed.data as Record<string, unknown>;
        } else {
          config = plugin.projectConfigSchema.parse(rawConfig) as Record<string, unknown>;
        }
      }
      const activated = await plugin.activateProject(
        {
          kernelId: this.kernel.kernelId,
          projectId: this.projectId,
          kind: this.kind,
          workspacePath: this.path,
        },
        config,
      );
      if (activated == null) continue;
      nextActivated.push(activated);
      if (activated.workspaceEnv !== undefined) {
        nextWorkspaceEnv = activated.workspaceEnv;
      }
      if (activated.tools !== undefined) {
        const list = Array.isArray(activated.tools) ? activated.tools : Object.values(activated.tools);
        for (const item of list) {
          activatedEntries.push(catalogEntryFromActivatedTool(item, pluginName));
        }
      }
      if (activated.bots !== undefined) {
        const list = Array.isArray(activated.bots) ? activated.bots : Object.values(activated.bots);
        for (const bot of list) {
          const converted = catalogRecipeFromActivatedBot(bot);
          activatedBotRecipes.push(converted.recipe);
          activatedBotFaces.push(converted.face);
        }
      }
    }

    if (this.#disposed || this.kernel.disposed) {
      await disposeActivatedPlugins(nextActivated);
      return;
    }

    this.#activatedPlugins = nextActivated;
    this.#activatedEntries = activatedEntries;
    this.#pluginBotRecipes = activatedBotRecipes;
    this.#pluginBotFaces = activatedBotFaces;
    this.workspaceEnv =
      nextWorkspaceEnv ??
      (this.kind === "local" && (this.kernel.contour === "local" || existsSync(this.path))
        ? createLocalFsWorkspaceEnv(this.path)
        : createVirtualWorkspaceEnv(this.path));

    for (const session of this.#readySessions.values()) {
      if (!session.closed) bindWorkspaceEnv(session.root, this.workspaceEnv);
    }
    for (const session of Object.values(this.sessions)) {
      if (!session.closed) bindWorkspaceEnv(session.root, this.workspaceEnv);
    }

    runInAction(() => {
      this.effectiveCatalog.pluginInstall = this.kernel.catalog.pluginInstall;
      this.effectiveCatalog.compiledRecipes = [...this.kernel.catalog.compiledRecipes];
      this.#syncEffectiveCatalogEntries();
      this.projectPluginStamp += 1;
    });
  }

  #syncEffectiveCatalogEntries(): void {
    runInAction(() => {
      const managed = this.effectiveCatalog.hasManagedAddendum();
      if (!this.doc?.root.pluginsConfigured) {
        this.effectiveCatalog.enabledHostPlugins = this.kernel.catalog.enabledHostPlugins;
        this.effectiveCatalog.packEntries = [...this.kernel.catalog.packEntries];
      } else {
        const systemEntries = systemEntriesFor(this.effectiveEnabledPlugins);
        const runtimeNames = new Set(Object.keys(this.kernel.runtimePlugins));
        const runtimeEntries = Object.entries(this.kernel.runtimePlugins).flatMap(([name, plugin]) =>
          this.effectiveEnabledPlugins.has(name)
            ? plugin.tools.map((tool) => catalogEntryFromTool(tool, { kind: "pack", pluginName: name }))
            : [],
        );
        const kernelPlugins = this.kernel.doc?.root.plugins ?? {};
        const otherPackEntries = this.kernel.catalog.packEntries.filter((entry) => {
          if (entry.source.kind !== "pack") return true;
          const p = entry.source.pluginName;
          if (SYSTEM_PLUGIN_NAMES.has(p) || runtimeNames.has(p)) return false;
          if (Object.hasOwn(kernelPlugins, p)) return this.effectiveEnabledPlugins.has(p);
          return true;
        });
        this.effectiveCatalog.enabledHostPlugins = this.effectiveEnabledPlugins;
        this.effectiveCatalog.packEntries = [...systemEntries, ...otherPackEntries, ...runtimeEntries];
      }
      this.effectiveCatalog.projectPackEntries = [...this.#activatedEntries];
      if (managed && this.kernel.catalog.hasManagedAddendum()) {
        this.effectiveCatalog.refreshManagedAddendum();
      }
    });
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
    const ids = new Set(Object.values(this.globalHost ? this.kernel.doc.root.botsRoster : this.root.botsRoster));
    for (const id of ids) {
      if (this.sessions[id] != null) continue;
      const sessionDoc = await this.#peer(id);
      if (!sessionDoc?.root.isMidMotion()) continue;
      if (!this.kernel.graphEligibleSessionIds().has(id)) continue;
      await this.#attach(id, false);
    }
  }

  dropReadySession(id: string, daemon: SessionDaemon): void {
    if (this.#readySessions.get(id) === daemon) {
      this.#readySessions.delete(id);
    }
  }

  async #attach(id: string, forceHonor = false): Promise<SessionDaemon> {
    const pending = this.#attaching.get(id);
    if (pending != null) {
      const attached = await pending;
      if (!forceHonor || attached.interpreting) return attached;
    }
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
      this.kernel.internSession(id, existing.doc, existing);
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
      this.kernel.internSession(id, live.doc, live);
      step(`session intern ${id}`);
      return live;
    }
    const ready = this.#readySessions.get(id);
    if (ready !== undefined) {
      if (ready.closed) {
        this.#readySessions.delete(id);
      } else if (!forceHonor && !this.kernel.graphEligibleSessionIds().has(id)) {
        await this.#reattachNamed(ready);
        return ready;
      } else {
        this.#readySessions.delete(id);
        try {
          if (forceHonor && isConversationSession(ready.root)) {
            this.kernel.reserveAttachment(id);
          }
          await this.#reattachNamed(ready);
          ready.activate();
          runInAction(() => {
            this.sessions[id] = ready;
          });
          this.kernel.internSession(id, ready.doc, ready);
          await ready.ready;
          return ready;
        } catch (error) {
          runInAction(() => {
            delete this.sessions[id];
          });
          void ready.park().catch((parkError: unknown) => fail(`session ${id} park`, parkError));
          throw error;
        }
      }
    }
    const interned = this.kernel.sessionDoc(id) ?? (await this.kernel.acquireSession(id));
    if (interned?.root.agent.spec.recipeScope === "global" && !this.globalHost) return this.kernel.globalSession(id);
    if (interned != null && interned.root.path !== this.path) {
      const host = this.kernel.project(interned.root.path);
      return forceHonor ? host.session(id) : host.attachEligible(id);
    }
    const created =
      interned == null
        ? new SessionDaemon(this, id, await this.kernel.mintSessionDocument(id, this.path), false)
        : new SessionDaemon(this, id, interned, true);
    this.kernel.internSession(id, created.doc);
    step(interned == null ? `session mint ${id}` : `session rebootstrap ${id}`);
    try {
      await created.recover();
      if (forceHonor && isConversationSession(created.root)) {
        this.kernel.reserveAttachment(id);
      }
      await this.#reattachNamed(created);
      if (forceHonor || this.kernel.graphEligibleSessionIds().has(id)) {
        created.activate();
        runInAction(() => {
          this.sessions[id] = created;
        });
        this.kernel.internSession(id, created.doc, created);
      } else {
        this.#readySessions.set(id, created);
        created.releaseReady();
      }
      await created.ready;
      return created;
    } catch (error) {
      this.#readySessions.delete(id);
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
        const sessionDoc = await this.#peer(id);
        if (this.sessions[id] == null && sessionDoc == null) continue;
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
  async #peer(id: string): Promise<SessionDocument | undefined> {
    try {
      return this.kernel.sessionDoc(id) ?? (await this.kernel.acquireSession(id));
    } catch (error) {
      fail(`session ${id}`, error);
      return undefined;
    }
  }

  protected override get parent() {
    return this.kernel;
  }

  protected override attach(socket: PlaneSocket, connectionId: string): ((text: string) => boolean) | void {
    return attachPlane({
      socket,
      connectionId,
      laneHub: this.kernel.laneHub,
      room: this.#presence ?? undefined,
      authorizeSubscribe: this.kernel.authorizePlaneSubscribe,
    });
  }

  #syncProjectBots(notice: boolean): void {
    const isLocalDisk = !this.globalHost && this.kind === "local" && existsSync(this.path);
    const { recipes, faces, snap } = isLocalDisk
      ? overlayBotDir(projectBotsDir(this.path), this.effectiveCatalog.allRecipes())
      : { recipes: [] as CatalogRecipe[], faces: [] as BotSpec[], snap: new Map<string, string>() };
    projectBotSpecs(this.root, [...faces, ...this.#pluginBotFaces]);
    const combinedRecipes = [...recipes, ...this.#pluginBotRecipes];
    bindProjectRecipes(this.kernel.catalog, this.path, combinedRecipes);
    bindProjectRecipes(this.effectiveCatalog, this.path, combinedRecipes);
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

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposed) return;
    this.#disposingPromise ??= (async () => {
      const seen = new Set<SessionDaemon>([...this.#readySessions.values(), ...Object.values(this.sessions)]);
      await Promise.allSettled([...seen].map((session) => session[Symbol.asyncDispose]()));
      await this.#reconcileChain.catch(() => {});
      const activated = this.#activatedPlugins;
      this.#activatedPlugins = [];
      await disposeActivatedPlugins(activated);
      this[Symbol.dispose]();
    })();
    return this.#disposingPromise;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeCatalogSync?.();
    this.#disposeCatalogSync = null;
    this.kernel.dropProject(this);
    unbindProjectRecipes(this.kernel.catalog, this.path);
    unbindProjectRecipes(this.effectiveCatalog, this.path);
    unbindProjectPrivateMcpHost(this.kernel.catalog, this.path);
    unbindProjectPrivateMcpHost(this.effectiveCatalog, this.path);
    this.#botsWatcher?.[Symbol.dispose]();
    this.#botsWatcher = null;
    this.#privateMcpHost[Symbol.dispose]();
    const dangling = this.#activatedPlugins;
    this.#activatedPlugins = [];
    for (let i = dangling.length - 1; i >= 0; i--) {
      try {
        dangling[i]?.[Symbol.dispose]?.();
      } catch (error) {
        fail("project plugin dispose", error);
      }
    }
    for (const ready of this.#readySessions.values()) {
      void ready.park().catch((error: unknown) => fail(`session ${ready.sessionId} park`, error));
    }
    this.#readySessions.clear();
    for (const session of Object.values(this.sessions)) {
      void session.park().catch((error: unknown) => fail(`session ${session.sessionId} park`, error));
    }
    runInAction(() => {
      this.sessions = {};
    });
    this.#presence?.close(1001, "project disposed");
    this.#presence = null;
    if (this.kernel.disposed) this.doc?.awareness.destroy();
  }
}

async function disposeActivatedPlugins(plugins: readonly ActivatedProjectPlugin[]): Promise<void> {
  for (let i = plugins.length - 1; i >= 0; i--) {
    const plugin = plugins[i];
    if (plugin == null) continue;
    try {
      const disposeAsync = plugin[Symbol.asyncDispose];
      if (typeof disposeAsync === "function") {
        await disposeAsync.call(plugin);
      } else {
        plugin[Symbol.dispose]?.();
      }
    } catch (error) {
      fail("project plugin dispose", error);
    }
  }
}

function catalogEntryFromActivatedTool(
  tool: ToolDefinition | { readonly toToolDefinition: () => ToolDefinition },
  pluginName: string,
): CatalogEntry {
  if (tool instanceof InhumanTool) {
    return catalogEntryFromTool(tool, { kind: "pack", pluginName });
  }
  const def = "toToolDefinition" in tool ? tool.toToolDefinition() : tool;
  if (def.type === "function") {
    return {
      wireName: def.name,
      description: def.description ?? def.name,
      parameters: parametersFromZod(def.input),
      class: def.class ?? "effect",
      representation: def.representation,
      source: { kind: "pack", pluginName },
      execute: async (raw, ctx) => {
        const parsed = def.input.parse(raw);
        const result = await def.run(parsed, ctx);
        return def.output.parse(result);
      },
      continuation: def.continuation,
      triggersReactLoop: def.triggersReactLoop,
      isSideChannel: def.isSideChannel,
      tapeHidden: def.tapeHidden,
      exam: def.exam,
    };
  }
  throw new Error(`Activated project tool ${def.name} from ${pluginName} has unsupported type ${def.type}`);
}

function catalogRecipeFromActivatedBot(bot: BotDefinition): { readonly recipe: CatalogRecipe; readonly face: BotSpec } {
  const recipeScope =
    bot.recipeScope === "global"
      ? ("global" as const)
      : bot.recipeScope === "workspace"
        ? ("project" as const)
        : bot.recipeScope === "session"
          ? ("session" as const)
          : undefined;
  const recipe = catalogRecipe({
    name: bot.name,
    category: "plugin",
    ...(recipeScope !== undefined ? { recipeScope } : {}),
    description: bot.description ?? "",
    instructions: bot.instructions,
    tools: [...(bot.tools ?? [])],
    invokes: [...(bot.invokes ?? [])],
    ...(bot.reasoningEffort !== undefined ? { reasoningEffort: bot.reasoningEffort } : {}),
    modelPreferences: [...(bot.modelPreferences ?? [])],
    skills: [...(bot.skills ?? [])],
    keepAlive: bot.keepAlive === true,
  });
  return { recipe, face: recipe.spec };
}

function parseStringArrayJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseSinglePluginConfig(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
}

function parsePluginConfigJsonStrings(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") {
        out[k] = v;
      } else if (v != null && typeof v === "object" && !Array.isArray(v)) {
        out[k] = JSON.stringify(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}
