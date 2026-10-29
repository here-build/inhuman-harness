import {
  existsSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

import { DefaultedMap } from "@here.build/collections";
import { asUserPrompt } from "@inhuman.tools/harness-commons";
import { contract } from "@inhuman.tools/harness-contract";
import { fail, step } from "@inhuman.tools/harness-diagnostics";
import {
  AskAgentSpec,
  type AgentNature,
  type SessionUnfinished,
  DEFAULT_COMPACT_STRATEGY,
  DEFAULT_COMPACT_TRIGGERS,
  DEFAULT_COMPACT_KEEP_TURNS,
  latestUserPrompt,
  outgoingAgentRelations,
  bindSessionProjections,
  PluginProjectionRegistry,
  KernelPlexus,
  ProjectPlexus,
  SessionPlexus,
  sessionIsOccupied,
  projectBotSpecs,
  fencedSubtree,
  grantLabel,
  rowKind,
  type GrantRow,
  parseAuthorizationConfig,
  parseGrantRows,
  type SessionRoot,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { disposeKernelConnections, dropConnection } from "@inhuman.tools/plexus-expectations/executor";
import fs from "fs-extra";
import { autorun, comparer, observable, reaction, runInAction, type IReactionDisposer } from "mobx";
import * as Y from "yjs";

import { NAMED_AGENT_BOTS } from "@/builtin-tools";
import { allocateConnectionId, openDriverRegistry, type DriverRegistry } from "@/connections";
import { KernelStateStore, BehaviorKernel, PackPluginCatalogHost, type PackPluginRow } from "@/extensions";
import { installPlugin, installedNpmName, packageNameOf, type InstallStreams } from "@/extensions/install";
import { scopes } from "@/policy-processor/scope";
import { documentKey, KERNEL_DOCUMENT_KEY, type DocumentKey } from "@/protocol/document";
import {
  adoptMcp,
  logoutMcpHttp,
  addConnectionAlwaysAllow,
  addConnectionToolExclude,
  searchOfficialRegistry,
} from "@/providers/mcp";
import { graphEligibleSessionIds, ProductionRuntime } from "@/runtime";
import { DocumentService, AwarenessRoom, attachLens, type PlaneSocket } from "@/yjs";

import { internLookedAt, probeCompletionCatalog } from "./completion-catalog.js";
import { loginConnection, requireConnection, settingsBag, toListRow } from "./connection-rpc.js";
import { healKernelDependencies, KERNEL_SEED_PACKAGES } from "./kernel-package.js";
import { applyConfigSet, applyPluginSet } from "./settings-config.js";
import {
  listSkillFiles,
  readBotAuthoring,
  removeBotFile,
  removeSkillFile,
  skillBody,
  skillsHome,
  writeBotFile,
  writeSkillFile,
} from "./settings-files.js";
import { adjustJson } from "../../adjust-json.js";
import { bindBlobStore } from "../../blobs/store.js";
import { DaemonRpcMethod, isAbortError, isUiCancelled, RequestHost, RpcInvalidParams } from "../../contract.js";
import { KernelReflector } from "./fs-reflection/KernelReflector.js";
import { reflectKernel } from "./fs-reflection/reflectKernel.js";
import { glanceAskLine } from "./glance-ask-line.js";
import { PRODUCT_PROVIDERS } from "../../composition.js";
import { defaultCompactSource } from "../../defaults/index.js";
import { parseConfigJson, parseKvBag, connectionSliceSchema, type ConfigJson } from "../../schemas/well-known.js";
import { deleteConnectionSecrets, readConnectionSecrets, writeConnectionSecrets } from "../../secrets.js";
import { HOST_PLUGINS, projectHostPluginSpecs, SYSTEM_PLUGIN_NAMES } from "../../system-plugins/index.js";
import { KernelToolCatalog } from "../../toolkit/tool-table.js";
import {
  botChangeNotice,
  BotsWatcher,
  defaultBotsHome,
  overlayBotDir,
  projectBotsDir,
  queueBotNotice,
} from "../bots/index.js";
import { formatBotMarkdown } from "../bots/parse-bot-markdown.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";
import { pluginAbiCatalog } from "../session/plugin-abi.js";
import { botRevisions, pluginBotRecipes, reportProblem, type PluginProblems } from "../session/plugin-bots.js";
import type { SessionDaemon } from "../session/SessionDaemon.js";
import { bindVisualStore } from "../session/visual-store.js";

const KERNEL_PACKAGE = {
  name: "harness-kernel",
  private: true,
  dependencies: {} as Record<string, string>,
};

/** Shutdown waits this long for parks and pending writes before tearing down anyway. */
const SHUTDOWN_DEADLINE_MS = 5_000;

/** Seeded pack rows. `named-agents` is pack-shaped but not a `HOST_PLUGINS` key. */
const HOST_PACK_PLUGINS = new Set<string>([...Object.keys(HOST_PLUGINS), ...SYSTEM_PLUGIN_NAMES]);

async function createOnly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
}

function sessionDocumentKey(sessionId: string): DocumentKey {
  return documentKey("sessions", sessionId);
}

function documentSlot(key: DocumentKey): string {
  return `${key.kind}\0${key.id}`;
}

export class KernelDaemon extends RequestHost implements Disposable, AsyncDisposable {
  plexus!: KernelPlexus;
  #room!: AwarenessRoom;
  readonly #flushStops = new Map<string, () => void>();
  /** In-flight document writers; shutdown waits for them before releasing. */
  readonly #drains = new Set<Promise<void>>();
  readonly #sessionRooms = new Map<string, AwarenessRoom>();
  readonly #glanceWatch = new Map<string, () => void>();
  readonly #occupancyWatch = new Map<string, () => void>();
  readonly #attaching = new Set<string>();
  readonly #reservations = observable.set<string>();
  readonly #eligibilityEpoch = observable.box(0);
  #eligibilityWatch: IReactionDisposer | null = null;
  #globalHost: ProjectDaemon | undefined;
  readonly #projects = new DefaultedMap((path: string) => new ProjectDaemon(this, path));
  #homeWatcher: BotsWatcher | null = null;
  #homeSnapshot = new Map<string, string>();
  readonly catalog = new KernelToolCatalog();
  readonly projections = new PluginProjectionRegistry();
  readonly runtime: ProductionRuntime<SessionPlexus>;
  /** Plugin behavior: the state directory and note log every agent's pin attaches to. */
  readonly behavior = new BehaviorKernel({
    packages: () =>
      Object.values(this.plexus.root.plugins)
        .filter((plugin) => plugin.enabled && plugin.rootPath !== "")
        .map((plugin) => ({
          name: plugin.pluginName,
          root: plugin.rootPath,
          foreground: this.#config().plugins[plugin.pluginName]?.foreground !== false,
        })),
    approved: (plugin) => new Set(this.#config().plugins[plugin]?.guards),
    store: new KernelStateStore(
      () => this.root,
      (sessionId) => this.runtime.replica(sessionId)?.root,
    ),
  });
  readonly ready: Promise<void>;
  readonly #daemons = new Map<string, SessionDaemon>();
  readonly #acquiring = new Map<string, Promise<SessionPlexus | undefined>>();
  #activated = false;
  #reflector: KernelReflector | null = null;
  #packPluginHost: PackPluginCatalogHost | null = null;
  #disposePackPluginWatch: IReactionDisposer | null = null;
  #disposePluginBots: IReactionDisposer | null = null;
  #disposeBotRevisions: IReactionDisposer | null = null;
  #disposeLookedAt: IReactionDisposer | null = null;
  #botRevisionEpoch = 0;
  #pluginBotErrors = "";
  /** Bot-load text and ABI-load text stay apart. `plugin.problem` is the merge. */
  readonly #pluginBotProblem = new Map<string, string>();
  readonly #pluginAbiProblem = new Map<string, string>();
  #closed = false;
  /**
   * Serializes mutating `execute`. A second write door races.
   * PARK_RELEASE: `ui()` drops this chain while the browser is open —
   * otherwise `term-continue/set` on the next TUI boot waits forever.
   */
  #writeChain: Promise<void> = Promise.resolve();
  override rpcMethods = [
    DaemonRpcMethod.fromContract(contract.kernel.termContinue.set, (args) => {
      this.plexus.root.termContinue[args.key] = args.sessionId;
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.termContinue.clear, (args) => {
      delete this.plexus.root.termContinue[args.key];
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.drop, async (args) => {
      if (args.confirm !== true) {
        try {
          const title = `"${`Remove ${args.id}?`.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
          await this.ui(`(harness/confirm :title ${title})`);
        } catch (error) {
          if (isUiCancelled(error)) return { ok: false };
          throw error;
        }
      }
      this.adjustConfig((config) => {
        RpcInvalidParams.invariant(args.id in config.connections, `connect/drop: unknown connection ${args.id}`);
        delete config.connections[args.id];
      });
      deleteConnectionSecrets(this.root, args.id);
      step(`memo-clear: connection=${args.id}`);
      await dropConnection(this.plexus.root, args.id);
      return { ok: true };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.adopt, async ({ driver, name, settings, secrets }) => {
      step(`connect/adopt ${driver}`);
      const spec = this.plexus.root.drivers[driver];
      RpcInvalidParams.invariant(
        spec !== undefined && spec.importPath.trim() !== "",
        `connect/adopt: unknown driver ${driver}`,
      );
      const signal = this.requestSignal();
      let bags;
      try {
        bags = await this.runtime.adopt(
          driver,
          this.plexus.root.drivers,
          { name, settings, signal, secrets },
          (kind, body) => {
            RpcInvalidParams.invariant(kind === "UI", `unknown callback ${kind}`);
            return this.ui(body);
          },
        );
      } catch (error) {
        if (isUiCancelled(error) || isAbortError(error)) return { ok: false as const };
        if (error instanceof RpcInvalidParams) throw error;
        fail(`${driver} adopt`, error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : `${driver} adopt failed`);
      }
      if (signal.aborted) return { ok: false as const };
      let id = "";
      this.adjustConfig((config) => {
        const slice = connectionSliceSchema.parse({
          driver,
          name: (bags.name ?? name ?? driver).trim() || driver,
          settings: bags.settings ?? {},
        });
        id = allocateConnectionId(new Set(Object.keys(config.connections)), slice.name);
        config.connections[id] = slice;
      });
      const secretBag = { ...bags.secrets, ...(secrets ?? {}) };
      if (Object.keys(secretBag).length > 0) writeConnectionSecrets(this.root, id, secretBag);
      return { id };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.mcpServer.adopt, async ({ name, input, settings, secrets }) => {
      step("mcp-server/adopt");
      const signal = this.requestSignal();
      let bags;
      try {
        bags = await adoptMcp({ name, settings, input, signal }, (kind, body) => {
          RpcInvalidParams.invariant(kind === "UI", `unknown callback ${kind}`);
          return this.ui(body);
        });
      } catch (error) {
        if (isUiCancelled(error) || isAbortError(error)) return { ok: false as const };
        fail("mcp-server adopt", error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "mcp-server adopt failed");
      }
      if (signal.aborted) return { ok: false as const };
      RpcInvalidParams.invariant(
        this.plexus.root.drivers[bags.driver] !== undefined,
        `mcp-server/adopt: unknown driver ${bags.driver}`,
      );
      let id = "";
      this.adjustConfig((config) => {
        const slice = connectionSliceSchema.parse({
          driver: bags.driver,
          name: (bags.name ?? name ?? bags.driver).trim() || bags.driver,
          settings: bags.settings ?? {},
        });
        id = allocateConnectionId(new Set(Object.keys(config.connections)), slice.name);
        config.connections[id] = slice;
      });
      const secretBag = { ...bags.secrets, ...(secrets ?? {}) };
      if (Object.keys(secretBag).length > 0) writeConnectionSecrets(this.root, id, secretBag);
      return { id };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.mcpServer.search, async ({ query, limit }) => {
      step("mcp-server/search");
      try {
        return { servers: await searchOfficialRegistry(query, { limit, signal: this.requestSignal() }) };
      } catch (error) {
        if (isAbortError(error)) return { servers: [] };
        fail("mcp-server/search", error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "The registry didn’t answer.");
      }
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.list, (args) => {
      const rows = [];
      for (const [id, spec] of Object.entries(this.connections)) {
        if (args.abilityClaim && !spec.driver.abilityClaim.includes(args.abilityClaim)) continue;
        rows.push(toListRow(id, spec));
      }
      return { connections: rows };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.models, async (args) => {
      step(`connect/models ${args.id ?? "*"}`);
      return {
        connections: await probeCompletionCatalog(this, this, args.id),
      };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.get, (args) => {
      const spec = requireConnection(this.connections, args.id, "connect/get");
      return { ...toListRow(args.id, spec), settings: settingsBag(spec) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.setEnabled, (args) => {
      this.adjustConfig((config) => {
        const row = config.connections[args.id];
        RpcInvalidParams.invariant(row !== undefined, `connect/set-enabled: unknown connection ${args.id}`);
        row.settings.enabled = args.enabled;
      });
      return { ok: true };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.alwaysAllow, (args) => {
      this.adjustConfig((config) => {
        RpcInvalidParams.invariant(
          args.id in config.connections,
          `connect/always-allow: unknown connection ${args.id}`,
        );
        addConnectionAlwaysAllow(config, args.id, args.tool);
      });
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.grant.list, (args) => {
      return { rows: this.#grantRows({ ...args, kind: args.kind ?? "grant" }) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.grant.add, (args) => {
      return this.#addGrant({ ...args, kind: args.kind ?? "grant" });
    }),
    DaemonRpcMethod.fromContract(contract.kernel.grant.revoke, (args) => {
      return { ok: this.revokeGrant(args.id, args.sessionId) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.ack.list, (args) => {
      return { rows: this.#grantRows({ ...args, kind: "ack" }) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.ack.add, (args) => {
      return this.#addGrant({ ...args, kind: "ack" });
    }),
    DaemonRpcMethod.fromContract(contract.kernel.ack.revoke, (args) => {
      return { ok: this.revokeGrant(args.id, args.sessionId) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.excludeTool, (args) => {
      this.adjustConfig((config) => {
        RpcInvalidParams.invariant(
          args.id in config.connections,
          `connect/exclude-tool: unknown connection ${args.id}`,
        );
        addConnectionToolExclude(config, args.id, args.tool);
      });
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.login, async (args) => {
      step(`connect/login ${args.id}`);
      const signal = this.requestSignal();
      try {
        const result = await loginConnection(args.id, this.connections, {
          signal,
          ui: (body) => this.ui(body),
          writeSecrets: (id, secrets) => writeConnectionSecrets(this.root, id, { ...secrets }),
          readSecrets: (id) => readConnectionSecrets(this.root, id),
        });
        step(`memo-clear: connection=${args.id}`);
        await dropConnection(this.plexus.root, args.id);
        return result;
      } catch (error) {
        if (isAbortError(error)) return { ok: false as const };
        if (error instanceof RpcInvalidParams) throw error;
        fail("connect/login", error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "connect/login failed");
      }
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.logout, (args) => {
      step(`connect/logout ${args.id}`);
      requireConnection(this.connections, args.id, "connect/logout");
      logoutMcpHttp(args.id, {
        writeSecrets: (connectionId, secrets) => writeConnectionSecrets(this.root, connectionId, { ...secrets }),
      });
      step(`memo-clear: connection=${args.id}`);
      void dropConnection(this.plexus.root, args.id).catch((error: unknown) => fail("connect/logout", error));
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.set, (args) => {
      RpcInvalidParams.invariant(
        this.plexus.root.plugins[args.name] != null,
        `plugin/set: unknown plugin ${args.name}`,
      );
      this.adjustConfig((config) => applyPluginSet(config, args));
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.install, async (args) => {
      const npmName = installedNpmName(args.spec) ?? packageNameOf(args.spec);
      const captured = captureInstallStreams();
      const code = await installPlugin(captured.streams, this.root, args.spec);
      if (code !== 0) {
        const detail = captured.stderr().trim();
        RpcInvalidParams.invariant(false, detail === "" ? `plugin/install: ${args.spec} failed` : detail);
      }
      // install writes package.json and config on its own. Reflect before the
      // caller reads the document, instead of waiting for the file watcher.
      this.adjustConfig(() => {});
      const plugin = Object.values(this.plexus.root.plugins).find((row) => row.sourceNpm === npmName);
      RpcInvalidParams.invariant(plugin != null, `plugin/install: ${args.spec} did not appear`);
      return { name: plugin.pluginName, npmName };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.remove, (args) => {
      const plugin = this.plexus.root.plugins[args.name];
      RpcInvalidParams.invariant(plugin != null, `plugin/remove: unknown plugin ${args.name}`);
      const npmName = plugin.sourceNpm;
      adjustJson(join(this.root, "package.json"), (raw) => withoutDependency(raw, npmName));
      if (npmName !== "") {
        rmSync(join(this.root, "node_modules", ...npmName.split("/")), { recursive: true, force: true });
      }
      this.adjustConfig((config) => {
        delete config.plugins[args.name];
      });
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.update, (args) => {
      this.adjustConfig((config) => {
        const row = config.connections[args.id];
        RpcInvalidParams.invariant(row !== undefined, `connect/update: unknown connection ${args.id}`);
        if (args.name !== undefined) row.name = args.name;
        if (args.settings !== undefined) row.settings = { ...row.settings, ...args.settings };
      });
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.config.set, (args) => {
      if (args.authorization != null) {
        const parsed = parseAuthorizationConfig(args.authorization);
        if (!parsed.ok) throw new RpcInvalidParams(`config/set: authorization: ${parsed.errors.join("; ")}`);
      }
      this.adjustConfig((config) => applyConfigSet(config, args));
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.skill.list, (args) => {
      const project = this.#knownProject(args.project);
      return { skills: listSkillFiles(project, skillsHome()) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.skill.write, (args) => {
      const root = args.scope === "home" ? this.#skillsHome() : this.#knownProject(args.project);
      RpcInvalidParams.invariant(root != null, "skill/write: no directory for that scope");
      const location = writeSkillFile(root, args.name, args.description, args.body);
      const listed = listSkillFiles(
        args.scope === "project" ? root : null,
        args.scope === "home" ? root : skillsHome(),
      );
      const row = listed.find((skill) => skill.location === location || skill.name === args.name);
      return row ?? { name: args.name, description: args.description, location, invoke: args.name, scope: args.scope };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.skill.remove, (args) => {
      const root = args.scope === "home" ? this.#skillsHome() : this.#knownProject(args.project);
      RpcInvalidParams.invariant(root != null, "skill/remove: no directory for that scope");
      removeSkillFile(root, args.name);
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.skill.read, (args) => {
      const root = args.scope === "home" ? this.#skillsHome() : this.#knownProject(args.project);
      RpcInvalidParams.invariant(root != null, "skill/read: no directory for that scope");
      const listed = listSkillFiles(
        args.scope === "project" ? root : null,
        args.scope === "home" ? root : skillsHome(),
      );
      const row = listed.find((skill) => skill.name === args.name && skill.scope === args.scope);
      RpcInvalidParams.invariant(row != null, `skill/read: unknown skill ${args.name}`);
      return { ...row, body: skillBody(row.location) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.bot.write, (args) => {
      const dir = this.#botDir(args.scope, args.project);
      const prior = readBotAuthoring(dir, args.name);
      writeBotFile(dir, {
        name: args.name,
        description: args.description,
        instructions: args.instructions,
        recipeScope: args.recipeScope,
        tools: args.tools,
        skills: args.skills,
        keepAlive: args.keepAlive,
        invokes: args.invokes ?? prior?.invokes ?? [],
        reasoningEffort: args.reasoningEffort === undefined ? (prior?.reasoningEffort ?? null) : args.reasoningEffort,
        modelPreferences: args.modelPreferences ?? prior?.modelPreferences ?? [],
        behavior: prior?.behavior ?? null,
        mcp: args.mcp ?? prior?.mcp ?? [],
      });
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.bot.remove, (args) => {
      removeBotFile(this.#botDir(args.scope, args.project), args.name);
      return { ok: true as const };
    }),
  ];

  constructor(
    readonly root: string,
    // Fixture drivers (park-mcp) join the product roster here; no mutable global table.
    registry: DriverRegistry = openDriverRegistry(PRODUCT_PROVIDERS),
  ) {
    super();
    bindVisualStore(this.root);
    bindBlobStore(this.root);
    this.runtime = new ProductionRuntime({
      registry,
      catalog: this.catalog,
      documents: new DocumentService({ root }),
    });
    // A failed boot must not keep the watchers and autoruns it already built.
    this.ready = this.#boot().catch((error: unknown) => {
      this[Symbol.dispose]();
      throw error;
    });
  }

  /** Dispose can land at any await; each one bails rather than build on a closed kernel. */
  async #boot(): Promise<void> {
    this.plexus = await this.#hydrateKernel();
    if (this.#closed) return;
    const plexus = this.plexus;
    this.runtime.bind(plexus.root, { moduleRoot: this.root });
    this.#room = new AwarenessRoom(plexus.awareness);
    await mkdir(this.root, { recursive: true });
    if (this.#closed) return;
    this.#bootHomeBots();
    await createOnly(() =>
      fs.writeJson(join(this.root, "package.json"), KERNEL_PACKAGE, {
        spaces: 2,
        flag: "wx",
      }),
    );
    const pkgPath = join(this.root, "package.json");
    const pkg = fs.readJsonSync(pkgPath) as { dependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies };
    if (healKernelDependencies(deps)) {
      fs.writeJsonSync(pkgPath, { ...pkg, dependencies: deps }, { spaces: 2 });
    }
    await createOnly(() =>
      fs.writeJson(
        join(this.root, "config.json"),
        {
          connections: {},
          compact: DEFAULT_COMPACT_STRATEGY,
          compactTriggers: { ...DEFAULT_COMPACT_TRIGGERS },
        },
        { spaces: 2, flag: "wx" },
      ),
    );
    // Existing files (and the fresh seed above) get the keep floor healed:
    // 0 or absent puts the whole eat in the prefix and orphans the in-flight exchange.
    this.adjustConfig((config) => {
      if (!Number.isInteger(config.compactKeepTurns) || (config.compactKeepTurns as number) < 1) {
        config.compactKeepTurns = DEFAULT_COMPACT_KEEP_TURNS;
      }
    });
    await createOnly(() =>
      fs.writeFile(join(this.root, "compact.scm"), defaultCompactSource(), {
        flag: "wx",
      }),
    );
    if (this.#closed) return;
    for (const npm of KERNEL_SEED_PACKAGES) {
      let packageRoot: string | null = null;
      try {
        packageRoot = dirname(createRequire(import.meta.url).resolve(`${npm}/package.json`));
      } catch {}
      if (packageRoot === null) continue;
      const dest = join(this.root, "node_modules", npm);
      mkdirSync(dirname(dest), { recursive: true });
      // existsSync follows links. A dangling symlink looks absent, and symlinkSync then throws EEXIST.
      try {
        if (readlinkSync(dest) === packageRoot) continue;
        unlinkSync(dest);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "EINVAL") continue;
        if (code !== "ENOENT") throw error;
      }
      symlinkSync(packageRoot, dest);
    }
    projectHostPluginSpecs(plexus.root);
    this.projections.install(HOST_PLUGINS);
    this.#packPluginHost = new PackPluginCatalogHost({
      catalog: this.catalog,
      kernelRoot: this.root,
      kernel: plexus.root,
      onError: (pluginName, error) => fail(`pack plugin ${pluginName}`, error),
    });
    this.#disposePackPluginWatch = autorun(() => {
      const rows: PackPluginRow[] = [];
      for (const [key, spec] of Object.entries(this.plexus.root.plugins)) {
        rows.push({
          pluginName: spec.pluginName.trim() === "" ? key : spec.pluginName,
          enabled: spec.enabled,
          rootPath: spec.rootPath,
          modules: [...spec.modules],
        });
      }
      void this.#packPluginHost?.sync(rows);
    });
    this.#disposeLookedAt = internLookedAt(this, this);
    this.#disposePluginBots = autorun(() => {
      this.#syncPluginBots();
      void this.#syncPluginAbi();
    });
    this.#disposeBotRevisions = reaction(
      () => this.behavior.packages().map((plugin) => `${plugin.name}\0${plugin.root}`),
      (keys) => {
        const enabled = new Set(keys);
        const packages = this.behavior.packages().filter((plugin) => enabled.has(`${plugin.name}\0${plugin.root}`));
        const epoch = ++this.#botRevisionEpoch;
        void botRevisions(packages)
          .then((revisions) => {
            if (this.#closed || epoch !== this.#botRevisionEpoch) return;
            runInAction(() => {
              this.catalog.botRevisions = revisions;
            });
            return undefined;
          })
          .catch((error: unknown) => fail("plugin bot revisions", error));
      },
      { fireImmediately: true },
    );
    this.#reflector = new KernelReflector(this.root, plexus.root, this.runtime.registry);
    await this.#reflector.ready;
    if (this.#closed) return;
    this.#homeWatcher = new BotsWatcher(defaultBotsHome(this.root), () => this.#syncHomeBots(true));
    this.#globalHost = new ProjectDaemon(this, this.root, true);
    await this.#globalHost.ready;
    if (this.#closed) return;
    let cursor: string | null = null;
    do {
      const page = await this.#requireDocuments().list({
        kind: "projects",
        cursor,
      });
      for (const entry of page.entries) {
        if (this.#closed) return;
        const workspace = entry.key.id;
        if (workspace === this.#globalHost.path || !existsSync(workspace)) continue;
        // One unloadable project is that project's failure, not the kernel's.
        await this.project(workspace).ready.catch((error: unknown) => fail(`project ${workspace}`, error));
      }
      cursor = page.cursor;
    } while (cursor != null);
    for (const [id, glance] of Object.entries(plexus.root.sessions)) {
      if (glance?.resident !== true) continue;
      if (this.#closed) break;
      await this.attachSession(id).catch((error: unknown) => fail(`resident ${id}`, error));
    }
    // An attach in flight when dispose ran may have registered a daemon after it.
    if (this.#closed) {
      this[Symbol.dispose]();
    } else {
      this.#activate();
    }
  }

  /** Occupancy attach starts after needed replicas are interned. */
  #activate(): void {
    if (this.#activated) return;
    this.#activated = true;
    this.runtime.activate();
    for (const [id, plexus] of this.runtime.replicaEntries()) {
      this.#watchSessionOccupancy(id, plexus);
    }
    this.#watchEligibility();
  }

  get connections() {
    return this.plexus.root.connections;
  }

  /** Write missing stdlib stems only. Existing files are the operator's. */
  #bootHomeBots(): void {
    const home = defaultBotsHome(this.root);
    mkdirSync(home, { recursive: true });
    for (const bot of NAMED_AGENT_BOTS) {
      try {
        writeFileSync(join(home, `${bot.name}.md`), formatBotMarkdown(bot), {
          flag: "wx",
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
    }
    this.#syncHomeBots(false);
  }

  #syncHomeBots(notice: boolean): void {
    const { recipes, faces, snap } = overlayBotDir(defaultBotsHome(this.root), this.catalog.compiledRecipes);
    projectBotSpecs(this.plexus.root, faces);
    try {
      this.catalog.replaceRecipes(recipes);
    } catch (error) {
      fail("home bots", error);
      return;
    }
    if (notice) {
      const text = botChangeNotice(this.#homeSnapshot, snap);
      if (text !== "") {
        for (const session of this.liveSessionRoots()) queueBotNotice(session, text);
      }
    }
    this.#homeSnapshot = new Map(snap);
  }

  /** Resolves when the home bots watcher is listening (or the ready cap elapses). */
  get homeBotsReady(): Promise<void> {
    return this.#homeWatcher?.ready ?? Promise.resolve();
  }

  liveSessionRoots(): SessionRoot[] {
    const out: SessionRoot[] = [];
    for (const daemon of this.#daemons.values()) {
      if (daemon.interpreting) out.push(daemon.root);
    }
    return out;
  }

  #abiEpoch = 0;

  /** Never rejects: a failed load is a plugin problem, not a daemon crash. */
  async #syncPluginAbi(): Promise<void> {
    try {
      await this.#loadPluginAbi();
    } catch (error) {
      fail("plugin abi", error);
    }
  }

  /**
   * Replace catalog rows that came from a plugin ABI.
   * Host rows stay. An enabled plugin that failed to load keeps its previous
   * rows and tool faces. A plugin that is not enabled drops its non-host rows
   * and tool faces.
   */
  async #loadPluginAbi(): Promise<void> {
    const epoch = ++this.#abiEpoch;
    const problems: PluginProblems = new Map();
    const loaded = await pluginAbiCatalog(this.behavior.packages(), this.behavior, problems);
    if (this.#closed || epoch !== this.#abiEpoch) return;
    const fresh = new Map(loaded.map((row) => [row.plugin, row.entries]));
    const plugins = new Set(this.behavior.packages().map((plugin) => plugin.name));
    runInAction(() => {
      const kept: typeof this.catalog.packEntries = [];
      const dropped = new Set<string>();
      for (const entry of this.catalog.packEntries) {
        if (entry.source.kind !== "pack") {
          kept.push(entry);
          continue;
        }
        const name = entry.source.pluginName;
        if (HOST_PACK_PLUGINS.has(name) || (plugins.has(name) && !fresh.has(name))) {
          kept.push(entry);
          continue;
        }
        if (!plugins.has(name)) dropped.add(name);
      }
      const next = [...kept];
      for (const row of loaded) {
        for (const entry of row.entries) {
          const at = next.findIndex((prior) => prior.wireName === entry.wireName);
          if (at === -1) next.push(entry);
          else next[at] = entry;
        }
        this.plexus.root.replacePluginTools(
          row.plugin,
          row.entries.map((entry) => ({
            name: entry.wireName,
            question: entry.question ?? null,
            effect: entry.effect ?? null,
            caption: entry.caption ?? null,
          })),
        );
      }
      for (const name of dropped) this.plexus.root.replacePluginTools(name, []);
      this.catalog.packEntries = next;
      this.#applyPluginProblems(this.#pluginAbiProblem, problems);
    });
    const text = [...problems].map(([plugin, list]) => `${plugin}: ${list.join("; ")}`).join("; ");
    if (text !== "") fail("plugin abi", text);
  }

  #syncPluginBots(): void {
    const problems: PluginProblems = new Map();
    const bots = pluginBotRecipes(this.behavior.packages(), problems);
    for (const name of this.catalog.replaceSurfaceRecipes(bots.map((row) => row.recipe))) {
      const owner = bots.find((row) => row.recipe.spec.name === name)?.plugin ?? "";
      reportProblem(problems, owner, `bot ${name} is shadowed by a recipe of the same name`);
    }
    runInAction(() => {
      this.#applyPluginProblems(this.#pluginBotProblem, problems);
    });
    const text = [...problems].map(([plugin, list]) => `${plugin}: ${list.join("; ")}`).join("; ");
    if (text === this.#pluginBotErrors) return;
    this.#pluginBotErrors = text;
    if (text !== "") fail("plugin bots", text);
  }

  /** One channel writes its sentence, including null, then both are merged onto the plugin. */
  #applyPluginProblems(channel: Map<string, string>, problems: PluginProblems): void {
    for (const plugin of Object.values(this.plexus.root.plugins)) {
      const joined = (problems.get(plugin.pluginName) ?? []).join("; ");
      if (joined === "") channel.delete(plugin.pluginName);
      else channel.set(plugin.pluginName, joined);
      const text = this.#mergedPluginProblem(plugin.pluginName);
      if (plugin.problem !== text) plugin.problem = text;
    }
  }

  #mergedPluginProblem(pluginName: string): string | null {
    const bot = this.#pluginBotProblem.get(pluginName);
    const abi = this.#pluginAbiProblem.get(pluginName);
    if (bot != null && abi != null) return `${bot}; ${abi}`;
    return bot ?? abi ?? null;
  }

  /** Empty means "not asking for a project". An unknown path is refused. */
  #knownProject(project: string | undefined): string | null {
    if (project == null || project.trim() === "") return null;
    const path = project.trim();
    RpcInvalidParams.invariant(Object.hasOwn(this.plexus.root.projects, path), `unknown project ${path}`);
    return path;
  }

  #skillsHome(): string | null {
    return skillsHome();
  }

  #botDir(scope: "home" | "project", project: string | undefined): string {
    if (scope === "home") return defaultBotsHome(this.root);
    const path = this.#knownProject(project);
    RpcInvalidParams.invariant(path != null, "project is required");
    return projectBotsDir(path);
  }

  #config(): ConfigJson {
    try {
      return parseConfigJson(fs.readJsonSync(join(this.root, "config.json")));
    } catch {
      return parseConfigJson({});
    }
  }

  adjustConfig(update: (config: ConfigJson) => ConfigJson | void): ConfigJson {
    const next = adjustJson<ConfigJson>(join(this.root, "config.json"), (raw) => {
      const config = parseConfigJson(raw);
      return parseConfigJson(update(config) ?? config);
    });
    reflectKernel(this.root, this.plexus.root, this.runtime.registry);
    return next;
  }

  /** Stored grants of project, bot and global scope (`grants.json`). Session grants live on their session. */
  persistentGrants(): GrantRow[] {
    return parseGrantRows(this.plexus.root.grantsJson);
  }

  /** Write one more stored grant (a human's "remember", or a settings grant). */
  addPersistentGrant(row: GrantRow): void {
    adjustJson<GrantRow[]>(join(this.root, "grants.json"), (raw) => {
      const rows = parseGrantRows(JSON.stringify(Array.isArray(raw) ? raw : []));
      return [...rows, row];
    });
    reflectKernel(this.root, this.plexus.root, this.runtime.registry);
    this.#reconcileGrants();
  }

  /** Revoke a stored grant by id, in the kernel file or on a session. Re-floors the unlicensed asks it covered. */
  revokeGrant(id: string, sessionId?: string): boolean {
    let removed = false;
    const rows = this.persistentGrants();
    if (rows.some((row) => row.id === id)) {
      adjustJson<GrantRow[]>(join(this.root, "grants.json"), () => rows.filter((row) => row.id !== id));
      reflectKernel(this.root, this.plexus.root, this.runtime.registry);
      removed = true;
    }
    for (const session of this.liveSessionRoots()) {
      if (sessionId !== undefined && session.sessionId !== sessionId) continue;
      const own = parseGrantRows(session.grantsJson);
      if (!own.some((row) => row.id === id)) continue;
      runInAction(() => session.replaceGrantsJson(JSON.stringify(own.filter((row) => row.id !== id))));
      removed = true;
    }
    if (removed) this.#reconcileGrants();
    return removed;
  }

  /** Drop expired rows from the file so the permissions view stays honest. Returns how many went. */
  sweepGrants(now: number = Date.now()): number {
    const rows = this.persistentGrants();
    const live = rows.filter((row) => row.expiresAtMs === null || row.expiresAtMs > now);
    if (live.length === rows.length) return 0;
    adjustJson<GrantRow[]>(join(this.root, "grants.json"), () => live);
    reflectKernel(this.root, this.plexus.root, this.runtime.registry);
    this.#reconcileGrants();
    return rows.length - live.length;
  }

  /** Every live session re-checks which grant covers each ask that is still waiting. */
  #reconcileGrants(): void {
    for (const session of this.liveSessionRoots()) scopes.get(session).reconcileGrants();
  }

  #grantRows(args: {
    readonly kind: "grant" | "ack";
    readonly scope?: GrantRow["scope"];
    readonly sessionId?: string;
    readonly projectPath?: string;
    readonly bot?: string;
    readonly includeExpired?: boolean;
  }): GrantRow[] {
    const now = Date.now();
    const rows = [...this.persistentGrants()];
    for (const session of this.liveSessionRoots()) {
      if (args.sessionId !== undefined && session.sessionId !== args.sessionId) continue;
      rows.push(...parseGrantRows(session.grantsJson));
    }
    return rows.filter((row) => {
      if (rowKind(row) !== args.kind) return false;
      if (args.scope !== undefined && row.scope !== args.scope) return false;
      if (args.projectPath !== undefined && row.scope === "project" && row.scopeKey !== args.projectPath) return false;
      if (args.bot !== undefined && row.scope === "bot" && row.scopeKey !== args.bot) return false;
      return args.includeExpired === true || row.expiresAtMs === null || row.expiresAtMs > now;
    });
  }

  #addGrant(args: {
    readonly kind: "grant" | "ack";
    readonly scope: GrantRow["scope"];
    readonly scopeKey?: string;
    readonly subject: GrantRow["subject"];
    readonly ttlMs?: number;
  }):
    | { readonly ok: true; readonly row: GrantRow }
    | {
        readonly ok: false;
        readonly reason: "fenced-path" | "invalid-scope" | "unknown-session" | "subject-not-allowed";
      } {
    const key = args.scopeKey ?? "";
    // "Any call of this class" is an acknowledgement subject; a grant is never that broad.
    if (args.subject.kind === "class" && args.kind !== "ack") return { ok: false, reason: "subject-not-allowed" };
    if (args.scope !== "global" && key === "") return { ok: false, reason: "invalid-scope" };
    if (
      args.subject.kind === "path" &&
      args.subject.depth === "subtree" &&
      fencedSubtree(args.subject.cluster, args.subject.path)
    ) {
      return { ok: false, reason: "fenced-path" };
    }
    const now = Date.now();
    const row: GrantRow = {
      id: `g-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ...(args.kind === "ack" ? { kind: "ack" as const } : {}),
      scope: args.scope,
      scopeKey: args.scope === "global" ? "" : key,
      subject: args.subject,
      createdAtMs: now,
      // Grants written in the settings file do not expire unless the caller asks for a TTL.
      expiresAtMs: args.ttlMs === undefined ? null : now + args.ttlMs,
      source: "settings",
      label: grantLabel(args.subject),
    };
    if (args.scope === "session") {
      const session = this.liveSessionRoots().find((root) => root.sessionId === key);
      if (session === undefined) return { ok: false, reason: "unknown-session" };
      runInAction(() => session.replaceGrantsJson(JSON.stringify([...parseGrantRows(session.grantsJson), row])));
      this.#reconcileGrants();
    } else {
      this.addPersistentGrant(row);
    }
    return { ok: true, row };
  }

  adjustKv(update: (bag: Record<string, string>) => Record<string, string> | void): Record<string, string> {
    return adjustJson(join(this.root, "kv.json"), (raw) => {
      const bag = parseKvBag(raw);
      return update(bag) ?? bag;
    });
  }

  override ui(body: string) {
    this.#writeChain = Promise.resolve();
    return super.ui(body);
  }

  protected override queuesExecute(method: string): boolean {
    return method !== "term-continue/set" && method !== "term-continue/clear";
  }

  protected override execute(run: () => unknown | Promise<unknown>) {
    const bound = this.bindPerform(run);
    const next = this.#writeChain.then(bound, bound);
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected override attach(socket: PlaneSocket): void {
    attachLens(this.plexus.doc, socket, this.#room, this.plexus.awareness);
  }

  internSession(sessionId: string, plexus: SessionPlexus, daemon?: SessionDaemon): void {
    bindSessionProjections(plexus.root, this.projections);
    this.runtime.intern(sessionId, plexus);
    this.sessionRoom(sessionId, plexus.awareness);
    this.#bindDocumentFlush(sessionDocumentKey(sessionId));
    if (daemon != null && daemon.interpreting) this.#daemons.set(sessionId, daemon);
    this.#rememberConversation(sessionId, plexus);
    this.#watchSessionGlance(sessionId, plexus);
    runInAction(() => this.#eligibilityEpoch.set(this.#eligibilityEpoch.get() + 1));
    if (this.#activated) this.#watchSessionOccupancy(sessionId, plexus);
  }

  /** Mint-until-first-seat. Dropped on occupancy or park; workers are not conversation roots. */
  reserveAttachment(sessionId: string): void {
    runInAction(() => this.#reservations.add(sessionId));
  }

  dropReservation(sessionId: string): void {
    runInAction(() => this.#reservations.delete(sessionId));
  }

  get disposed(): boolean {
    return this.#closed;
  }

  graphEligibleSessionIds(): ReadonlySet<string> {
    return graphEligibleSessionIds(this.#eligibilitySnapshot());
  }

  #eligibilitySnapshot() {
    this.#eligibilityEpoch.get();
    const occupied = new Set<string>();
    for (const id of this.runtime.acquired) {
      if (sessionIsOccupied(this.plexus.awareness, id)) occupied.add(id);
    }
    return this.runtime.eligibilitySnapshot({
      occupied,
      reserved: new Set(this.#reservations),
    });
  }

  /** Interpreting daemon for this id, if any. Parked daemons are not live. */
  liveSession(sessionId: string): SessionDaemon | undefined {
    const daemon = this.#daemons.get(sessionId);
    return daemon != null && daemon.interpreting ? daemon : undefined;
  }

  dropDaemon(sessionId: string): void {
    this.#daemons.delete(sessionId);
  }

  /** Synchronous session lookup. Never disk or network I/O. */
  sessionPlexus(sessionId: string): SessionPlexus | undefined {
    return this.runtime.replica(sessionId);
  }

  sessionRoom(sessionId: string, awareness: SessionPlexus["awareness"]): AwarenessRoom {
    const held = this.#sessionRooms.get(sessionId);
    if (held != null) return held;
    const room = new AwarenessRoom(awareness);
    this.#sessionRooms.set(sessionId, room);
    return room;
  }

  #bindDocumentFlush(key: DocumentKey): void {
    const id = documentSlot(key);
    if (this.#flushStops.has(id)) return;
    const documents = this.runtime.documents;
    if (documents == null) return;
    const doc = documents.getLoaded(key)?.doc;
    if (doc == null) return;
    let writer: Promise<void> | null = null;
    let again = false;
    const save = (): void => {
      if (writer != null) {
        again = true;
        return;
      }
      const drain = async (): Promise<void> => {
        do {
          again = false;
          try {
            await this.#flushDocument(key);
          } catch (error) {
            fail("document flush", error);
          }
        } while (again);
      };
      const running = drain().finally(() => {
        writer = null;
        this.#drains.delete(running);
      });
      writer = running;
      this.#drains.add(running);
    };
    doc.on("update", save);
    this.#flushStops.set(id, () => {
      doc.off("update", save);
    });
  }

  /**
   * Persist the session's document now. `force` replaces the stored image with one snapshot of the live
   * document instead of appending to it, so the log's dead prefix goes (the vacuum of a stored session).
   */
  async flushSession(plexus: SessionPlexus, options?: { readonly force?: boolean }): Promise<void> {
    await this.#flushDocument(sessionDocumentKey(plexus.root.sessionId), options);
  }

  async mintSessionDocument(sessionId: string, path: string): Promise<SessionPlexus> {
    const key = sessionDocumentKey(sessionId);
    const documents = this.#requireDocuments();
    const loaded = documents.getLoaded(key);
    if (loaded != null) {
      this.#bindDocumentFlush(key);
      return SessionPlexus.connect(loaded.doc, { undo: "stub" });
    }
    const opened = await documents.openExisting(key);
    if (opened.ok) {
      this.#bindDocumentFlush(key);
      return SessionPlexus.connect(opened.ref.doc, { undo: "stub" });
    }
    const boot = SessionPlexus.create(sessionId, path);
    const created = await documents.create(key, Y.encodeStateAsUpdate(boot.doc));
    boot.doc.destroy();
    if (!created.ok) throw new Error(`session document create failed: ${created.reason}`);
    this.#bindDocumentFlush(key);
    return SessionPlexus.connect(created.ref.doc, { undo: "stub" });
  }

  async loadProjectDoc(path: string): Promise<{ readonly doc: Y.Doc; readonly existing: boolean }> {
    const key = documentKey("projects", path);
    const documents = this.#requireDocuments();
    const opened = await documents.openExisting(key);
    if (opened.ok) {
      this.#bindDocumentFlush(key);
      return { doc: opened.ref.doc, existing: true };
    }
    const created = await documents.create(key);
    if (!created.ok) throw new Error(`project document create failed: ${created.reason}`);
    this.#bindDocumentFlush(key);
    return { doc: created.ref.doc, existing: false };
  }

  /**
   * Hydrate a session replica and pin it. Does not start an interpreter.
   * Undefined only when no such session exists; overload or corruption throws.
   */
  async acquireSession(sessionId: string): Promise<SessionPlexus | undefined> {
    const live = this.runtime.replica(sessionId);
    if (live != null) return live;
    const pending = this.#acquiring.get(sessionId);
    if (pending != null) return pending;
    const run = this.#acquireSessionNow(sessionId);
    this.#acquiring.set(sessionId, run);
    try {
      return await run;
    } finally {
      if (this.#acquiring.get(sessionId) === run) this.#acquiring.delete(sessionId);
    }
  }

  async #acquireSessionNow(sessionId: string): Promise<SessionPlexus | undefined> {
    const live = this.runtime.replica(sessionId);
    if (live != null) return live;
    const opened = await this.#requireDocuments().openExisting(sessionDocumentKey(sessionId));
    if (!opened.ok && opened.reason === "not-found") return undefined;
    if (!opened.ok) throw new Error(`session ${sessionId}: ${opened.reason}`);
    const interned = this.runtime.replica(sessionId);
    if (interned != null) return interned;
    const restored = SessionPlexus.connect(opened.ref.doc, { undo: "stub" });
    this.internSession(sessionId, restored);
    return restored;
  }

  registerProject(project: ProjectDaemon): void {
    if (project.globalHost) return;
    this.#projects.set(project.path, project);
    this.plexus.root.projects[project.path] = "";
  }

  /** Title tracks `SessionRoot.title`; recency is turn/steer. Liveness is not recency. */
  #watchSessionGlance(sessionId: string, plexus: SessionPlexus): void {
    if (this.#glanceWatch.has(sessionId)) return;
    const stopLens = reaction(
      () => glanceSnapOf(plexus.root),
      (snap) => {
        this.#upsertSessionGlance(sessionId, snap);
        this.#rememberConversationFromSnap(sessionId, snap);
      },
      { equals: comparer.structural, fireImmediately: true },
    );
    const stopHead = reaction(
      () => plexus.root.head?.uuid ?? "",
      (uuid) => {
        if (uuid === "") return;
        this.#touchSessionGlance(sessionId);
      },
    );
    const stopSteer = reaction(
      () => plexus.root.steerQueue.length,
      (n, prev) => {
        if (n > (typeof prev === "number" ? prev : 0)) this.#touchSessionGlance(sessionId);
      },
    );
    this.#glanceWatch.set(sessionId, () => {
      stopLens();
      stopHead();
      stopSteer();
    });
  }

  /**
   * Seat awareness × `spec.resident`. Park only on a falling edge so HTTP
   * mint (interned before the first seat) does not drop the connecting client.
   */
  #watchSessionOccupancy(sessionId: string, plexus?: SessionPlexus): void {
    if (this.#occupancyWatch.has(sessionId)) return;
    const stop = reaction(
      () => {
        const occupied = sessionIsOccupied(this.plexus.awareness, sessionId);
        const resident = (plexus ?? this.runtime.replica(sessionId))?.root.agent.spec.resident === true;
        return { occupied, honor: occupied || resident };
      },
      (state, prev) => {
        if (this.#closed) return;
        if (state.occupied) this.dropReservation(sessionId);
        if (state.honor) {
          if (this.liveSession(sessionId) == null && !this.#attaching.has(sessionId)) {
            this.#attaching.add(sessionId);
            void this.attachSession(sessionId)
              .catch((error) => fail("occupancy attach", error))
              .finally(() => this.#attaching.delete(sessionId));
          }
          return;
        }
        if (prev?.honor === true && !this.graphEligibleSessionIds().has(sessionId)) {
          void this.liveSession(sessionId)
            ?.park()
            .catch((error: unknown) => fail("occupancy park", error));
        }
      },
      { fireImmediately: true, equals: comparer.structural },
    );
    this.#occupancyWatch.set(sessionId, stop);
  }

  /** Delegated grants: attach newly eligible workers; park those that lost every root. */
  #watchEligibility(): void {
    if (this.#eligibilityWatch != null) return;
    this.#eligibilityWatch = reaction(
      () => {
        const snap = this.#eligibilitySnapshot();
        return [...graphEligibleSessionIds(snap)].sort();
      },
      (now, prev) => {
        if (this.#closed) return;
        const graph = new Set(now);
        const wasGraph = new Set(prev);
        for (const id of graph) {
          if (this.#closed || this.liveSession(id) != null || this.#attaching.has(id)) continue;
          this.#attaching.add(id);
          void this.attachSession(id)
            .catch((error) => {
              if (!this.#closed) fail("eligibility attach", error);
            })
            .finally(() => this.#attaching.delete(id));
        }
        for (const id of wasGraph) {
          if (this.#closed || graph.has(id)) continue;
          this.#parkIfGrantOnly(id);
        }
      },
      { fireImmediately: true, equals: comparer.structural },
    );
  }

  #parkIfGrantOnly(sessionId: string): void {
    const spec = this.runtime.replica(sessionId)?.root.agent.spec;
    if (spec == null) return;
    if (spec.recipeScope !== "session" && !(spec instanceof AskAgentSpec)) return;
    void this.liveSession(sessionId)
      ?.park()
      .catch((error: unknown) => fail("grant park", error));
  }

  #upsertSessionGlance(sessionId: string, snap: SessionGlanceSnap): void {
    this.plexus.root.projectSessionGlance(sessionId, snap, Date.now());
  }

  #touchSessionGlance(sessionId: string): void {
    const glance = this.plexus.root.sessions[sessionId];
    if (glance == null) return;
    glance.lastMessageAt = Date.now();
  }

  /** Conversation catalog is empty-scope only. Stamp/re-intern retracts a named worker. */
  #rememberConversation(sessionId: string, plexus: SessionPlexus): void {
    this.#rememberConversationFromSnap(sessionId, glanceSnapOf(plexus.root));
  }

  #rememberConversationFromSnap(sessionId: string, snap: SessionGlanceSnap): void {
    if (snap.path === "") return;
    if (!this.#projects.has(snap.path)) return;
    const project = this.#projects.get(snap.path);
    if (project.globalHost) return;
    if (snap.recipeScope === "" && !snap.oneShot) {
      project.root.sessions[sessionId] = "";
    } else {
      delete project.root.sessions[sessionId];
    }
  }

  dropProject(project: ProjectDaemon): void {
    if (this.#projects.has(project.path) && this.#projects.get(project.path) === project) {
      this.#projects.delete(project.path);
    }
  }

  project(path: string): ProjectDaemon {
    if (this.#globalHost != null) {
      try {
        if (realpathSync(path) === this.#globalHost.path) return this.#globalHost;
      } catch {
        // Constructor still validates; this is only the hidden-host hit.
      }
    }
    return this.#projects.get(path);
  }

  async attachSession(id: string): Promise<SessionDaemon | undefined> {
    if (this.disposed) throw new Error("attachSession: disposed");
    const held = this.#daemons.get(id);
    if (held != null && held.interpreting) return held;
    if (held != null) await held.park();
    const root = (this.sessionPlexus(id) ?? (await this.acquireSession(id)))?.root;
    if (root == null) return undefined;
    if (root.agent.spec.recipeScope === "global") return this.globalSession(id);
    return this.project(root.path).attachEligible(id);
  }

  /** Write an inbound prompt onto a worker session and register the open Call. */
  async broadcastAgentRequest(
    sessionId: string,
    requestId: string,
    callerSessionId: string,
    prompt: string,
  ): Promise<void> {
    const plexus = this.sessionPlexus(sessionId) ?? (await this.acquireSession(sessionId));
    if (plexus == null) throw new Error(`worker session ${sessionId} missing`);
    plexus.root.enqueueAgentRequest(requestId, callerSessionId, asUserPrompt(prompt));
    if (this.liveSession(sessionId) == null) {
      if (plexus.root.agent.spec.recipeScope === "global") await this.globalSession(sessionId);
      else await this.project(plexus.root.path).session(sessionId);
    }
  }

  async globalSession(sessionId: string): Promise<SessionDaemon> {
    if (this.#globalHost == null) await this.ready;
    const host = this.#globalHost;
    if (host == null) throw new Error("global host missing");
    return host.session(sessionId);
  }

  /**
   * Park live sessions and let every pending write land, then tear down.
   * A hung honor (an eval blocked on I/O) never parks; the deadline bounds the wait.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#closed = true;
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, SHUTDOWN_DEADLINE_MS);
    });
    await Promise.race([Promise.allSettled([...this.#daemons.values()].map((daemon) => daemon.park())), deadline]);
    while (this.#drains.size > 0 && !expired) await Promise.race([Promise.allSettled(this.#drains), deadline]);
    clearTimeout(timer);
    this[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    this.#closed = true;
    this.#eligibilityWatch?.();
    this.#eligibilityWatch = null;
    this.#room?.close(1001, "kernel disposed");
    for (const room of this.#sessionRooms.values()) room.close(1001, "kernel disposed");
    this.#sessionRooms.clear();
    for (const stop of this.#glanceWatch.values()) stop();
    this.#glanceWatch.clear();
    for (const stop of this.#occupancyWatch.values()) stop();
    this.#occupancyWatch.clear();
    for (const daemon of this.#daemons.values()) void daemon.park().catch((error: unknown) => fail("park", error));
    this.#globalHost?.[Symbol.dispose]();
    for (const project of this.#projects.values()) project[Symbol.dispose]();
    this.#projects.clear();
    for (const stop of this.#flushStops.values()) stop();
    this.#flushStops.clear();
    this.plexus?.awareness.destroy();
    for (const session of this.runtime.replicaValues()) {
      session.awareness.destroy();
    }
    const documents = this.runtime.documents;
    if (documents != null) {
      for (const ref of documents.loaded()) {
        if (ref.key.kind === "projects") {
          try {
            ProjectPlexus.connect(ref.doc).awareness.destroy();
          } catch {
            // Interned image with no domain wrapper.
          }
        }
        void documents.release(ref.key);
      }
    }
    this.runtime[Symbol.dispose]();
    this.#daemons.clear();
    this.#acquiring.clear();
    this.#reservations.clear();
    this.#activated = false;
    this.#disposePackPluginWatch?.();
    this.#disposePackPluginWatch = null;
    this.#disposePluginBots?.();
    this.#disposePluginBots = null;
    this.#disposeBotRevisions?.();
    this.#disposeBotRevisions = null;
    this.#disposeLookedAt?.();
    this.#disposeLookedAt = null;
    this.#packPluginHost?.[Symbol.dispose]();
    this.#packPluginHost = null;
    this.#homeWatcher?.[Symbol.dispose]();
    this.#homeWatcher = null;
    this.#reflector?.[Symbol.dispose]();
    this.#reflector = null;
    if (this.plexus != null) disposeKernelConnections(this.plexus.root);
    this.catalog[Symbol.dispose]();
  }

  #requireDocuments(): DocumentService {
    const documents = this.runtime.documents;
    if (documents instanceof DocumentService) return documents;
    throw new Error("kernel: document service missing");
  }

  async #hydrateKernel(): Promise<KernelPlexus> {
    const documents = this.#requireDocuments();
    const opened = await documents.openExisting(KERNEL_DOCUMENT_KEY);
    if (opened.ok) {
      this.#bindDocumentFlush(KERNEL_DOCUMENT_KEY);
      return KernelPlexus.connect(opened.ref.doc);
    }
    const boot = KernelPlexus.bootstrap();
    const created = await documents.create(KERNEL_DOCUMENT_KEY, Y.encodeStateAsUpdate(boot.doc));
    boot.doc.destroy();
    if (!created.ok) throw new Error(`kernel document create failed: ${created.reason}`);
    this.#bindDocumentFlush(KERNEL_DOCUMENT_KEY);
    return KernelPlexus.connect(created.ref.doc);
  }

  async #flushDocument(key: DocumentKey, options?: { readonly force?: boolean }): Promise<void> {
    const documents = this.#requireDocuments();
    const checkpoint = documents.checkpoint(key);
    if (checkpoint == null) throw new Error("flushDocument: document is not loaded");
    const result = await documents.flush(key, checkpoint, options);
    if (!result.ok) throw new Error(`flushDocument: ${result.reason}`);
  }
}

type SessionGlanceSnap = {
  readonly title: string;
  readonly recipeScope: AgentNature;
  readonly specName: string;
  readonly resident: boolean;
  readonly keepAlive: boolean;
  readonly oneShot: boolean;
  readonly model: string;
  readonly status: string;
  readonly midMotion: boolean;
  readonly openTurn: boolean;
  readonly openToolCount: number;
  readonly periodArmed: boolean;
  readonly openCallbackCount: number;
  readonly asking: boolean;
  readonly unfinished: SessionUnfinished;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly questionLine: string;
  readonly path: string;
  readonly calls: ReturnType<typeof outgoingAgentRelations>;
};

function glanceSnapOf(root: SessionRoot): SessionGlanceSnap {
  const spec = root.agent.spec;
  const unfinished = root.unfinished;
  return {
    title: root.title,
    recipeScope: spec.recipeScope,
    specName: spec.name,
    resident: spec.resident,
    keepAlive: spec.keepAlive,
    oneShot: spec instanceof AskAgentSpec,
    model: (root.kvs.model ?? "").trim(),
    status: root.turnDescription,
    midMotion: root.midMotion,
    openTurn: root.openTurn,
    openToolCount: root.openToolCount,
    periodArmed: root.periodArmed,
    openCallbackCount: root.openCallbackCount,
    asking: root.asking,
    unfinished,
    lastPrompt: latestUserPrompt(root.head),
    askLine: unfinished === "ask" ? glanceAskLine(root.head?.approvalHead ?? null) : "",
    questionLine: unfinished === "question" && root.head instanceof SessionTurn ? root.head.questionLine : "",
    path: root.path,
    calls: outgoingAgentRelations(root),
  };
}

function captureInstallStreams(): { readonly streams: InstallStreams; stderr(): string } {
  let err = "";
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      err += String(chunk);
      cb();
    },
  });
  const streams: InstallStreams = {
    stdout: new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
    stderr,
    writeErr: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(message.endsWith("\n") ? message : `${message}\n`);
    },
  };
  return { streams, stderr: () => err };
}

function withoutDependency(raw: unknown, npmName: string): Record<string, unknown> {
  const pkg: Record<string, unknown> = {};
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) pkg[key] = value;
  }
  const dependencies: Record<string, unknown> = {};
  const depsRaw = pkg.dependencies;
  if (depsRaw != null && typeof depsRaw === "object" && !Array.isArray(depsRaw)) {
    for (const [key, value] of Object.entries(depsRaw)) dependencies[key] = value;
  }
  delete dependencies[npmName];
  pkg.dependencies = dependencies;
  return pkg;
}
