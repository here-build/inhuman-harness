import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import { DefaultedMap } from "@here.build/collections";
import { asUserPrompt } from "@inhuman.tools/harness-commons";
import {
  contract,
  encodeUiDefinition,
  KERNEL_SCOPE_ID,
  projectScopeId,
  type PendingAskRowInsert,
} from "@inhuman.tools/harness-contract";
import {
  pendingAsksTable,
  sessionsTable,
  sessionTurnsTable,
  type ScmResourceKind,
} from "@inhuman.tools/harness-contract/schema";
import { fail, step } from "@inhuman.tools/harness-diagnostics";
import {
  DEFAULT_COMPACT_STRATEGY,
  DEFAULT_COMPACT_TRIGGERS,
  DEFAULT_COMPACT_KEEP_TURNS,
  bindSessionProjections,
  PluginProjectionRegistry,
  KernelDocument,
  HOST_QUEUE_VERBS,
  ProjectDocument,
  SessionDocument,
  SessionTurn,
  sessionIsOccupied,
  projectBotSpecs,
  fencedSubtree,
  grantLabel,
  rowKind,
  type GrantRow,
  parseAuthorizationConfig,
  parseGrantRows,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { applyKv, type KvProposal, type PermissionMode } from "@inhuman.tools/harness-model/shared";
import { runWithBlobReader, runWithVisualReader } from "@inhuman.tools/harness-provider-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import type { DocumentContainer } from "@inhuman.tools/model";
import { disposeKernelConnections, dropConnection } from "@inhuman.tools/expectations/executor";
import { HarnessDatabase, UpdateLaneHub } from "@inhuman.tools/scope-plane/sqlite";
import {
  glanceAskLine,
  sessionColumns,
  sessionSummary,
  observeSessionSummary,
  type SessionSummary,
} from "@inhuman.tools/turn/runtime";
import type { SessionCheckpoint, SessionReceipt } from "@inhuman.tools/turn/session-runtime";
import { runWithBlobWriter } from "@inhuman.tools/turn/tool-runtime";
import { eq } from "drizzle-orm";
import fs from "fs-extra";
import { autorun, comparer, observable, reaction, runInAction, type IReactionDisposer } from "mobx";

import { NAMED_AGENT_BOTS } from "@/builtin-tools";
import { allocateConnectionId, openDriverRegistry, type DriverRegistry } from "@/connections";
import {
  BehaviorKernel,
  DbStateStore,
  KernelStateStore,
  PackPluginCatalogHost,
  readBundledPluginInventory,
  type PackPluginRow,
} from "@/extensions";
import { installPlugin, installedNpmName, packageNameOf, type InstallStreams } from "@/extensions/install";
import { scopes } from "@/policy-processor/scope";
import {
  adoptMcp,
  logoutMcpHttp,
  addConnectionAlwaysAllow,
  addConnectionToolExclude,
  searchOfficialRegistry,
} from "@/providers/mcp";
import { graphEligibleSessionIds, isConversationSession, ProductionRuntime } from "@/runtime";

import { internLookedAt, probeCompletionCatalog, warmCompletionCatalog } from "./completion-catalog.js";
import { duplicateConnectionOf, loginConnection, requireConnection, settingsBag, toListRow } from "./connection-rpc.js";
import {
  healKernelDependencies,
  KERNEL_SEED_PACKAGES,
  linkSeedPackage,
  resolveSeedPackageRoot,
} from "./kernel-package.js";
import {
  disposeNativeDirectoryPicker,
  pickNativeDirectory,
  warmNativeDirectoryPicker,
  type DirectoryPicker,
} from "./pick-directory.js";
import { RemoteAccess, remoteLoggedIn } from "./remote-access.js";
import { RemoteConnector } from "./remote-connector.js";
import { WEB_STATIC_DIR_ENV } from "./remote-http.js";
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
import type { BlobBucketSync } from "../../blobs/bucket.js";
import { FsBlobBucket } from "../../blobs/fs-bucket.js";
import { MemoryBlobBucket } from "../../blobs/memory-bucket.js";
import { BlobStore, bindBlobBucket } from "../../blobs/store.js";
import { PRODUCT_PROVIDERS } from "../../composition.js";
import { DaemonRpcMethod, isAbortError, isUiCancelled, RequestHost, RpcInvalidParams } from "../../contract.js";
import { KernelReflector } from "./fs-reflection/KernelReflector.js";
import { projectKernelConfigToRoot, reflectKernel } from "./fs-reflection/reflectKernel.js";
import { defaultCompactSource } from "../../defaults/index.js";
import { parseConfigJson, parseKvBag, connectionSliceSchema, type ConfigJson } from "../../schemas/well-known.js";
import { FsSecretsVault, MemorySecretsVault, type SecretsVaultPort } from "../../secrets.js";
import { HOST_PLUGINS, projectHostPluginSpecs, SYSTEM_PLUGIN_NAMES } from "../../system-plugins/index.js";
import { KernelToolCatalog } from "../../toolkit/tool-table.js";
import { attachPlane, PresenceRoom, type PlaneSocket } from "../../transport/plane.js";
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
import {
  bindVisualStore,
  FsVisualStore,
  MemoryVisualStore,
  type VisualStorePort,
} from "../session/visual-store.js";

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

export type KernelContour = "local" | "server";

export type KernelDaemonOptions = {
  readonly contour?: KernelContour;
  readonly kernelId?: string;
  readonly root?: string;
  readonly db?: HarnessDatabase;
  readonly ownsDb?: boolean;
  readonly laneHub?: UpdateLaneHub;
  readonly ownsLaneHub?: boolean;
  readonly registry?: DriverRegistry;
  readonly secrets?: SecretsVaultPort;
  readonly ownsSecrets?: boolean;
  readonly blobBucket?: BlobBucketSync;
  readonly ownsBlobs?: boolean;
  readonly visuals?: VisualStorePort;
  readonly ownsVisuals?: boolean;
  readonly bundledPlugins?: ReadonlyArray<{ readonly npmName: string; readonly rootPath: string }>;
};

export class KernelDaemon extends RequestHost implements Disposable, AsyncDisposable {
  readonly contour: KernelContour;
  readonly kernelId: string;
  readonly root: string;
  readonly db: HarnessDatabase;
  readonly laneHub: UpdateLaneHub;
  readonly secrets: SecretsVaultPort;
  readonly blobs: BlobStore;
  readonly visuals: VisualStorePort;
  readonly #ownsDb: boolean;
  readonly #ownsLaneHub: boolean;
  readonly #ownsSecrets: boolean;
  readonly #ownsBlobs: boolean;
  readonly #ownsVisuals: boolean;
  readonly #bundledPlugins?: ReadonlyArray<{ readonly npmName: string; readonly rootPath: string }>;
  doc!: KernelDocument;
  #room!: PresenceRoom;
  readonly #flushStops = new Map<string, () => void>();
  /** In-flight document writers; shutdown waits for them before releasing. */
  readonly #drains = new Set<Promise<void>>();
  readonly #sessionRooms = new Map<string, PresenceRoom>();
  readonly #projectDocs = new Map<string, ProjectDocument>();
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
  readonly runtime: ProductionRuntime<SessionDocument>;
  /** Plugin behavior: the state directory and note log every agent's pin attaches to. */
  readonly behavior: BehaviorKernel;
  /** Remote-access login and tokens; durable in the kernel's secret vault. */
  readonly #remote: RemoteAccess;
  /**
   * Dials the relay while logged in. The static directory is the CLI's to
   * name (the daemon does not depend on the web app); file roots are the
   * projects this kernel knows.
   */
  readonly #connector: RemoteConnector | null = null;
  readonly ready: Promise<void>;
  readonly #daemons = new Map<string, SessionDaemon>();
  readonly #acquiring = new Map<string, Promise<SessionDocument | undefined>>();
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
  #disposedSync = false;
  #disposingPromise: Promise<void> | null = null;
  /**
   * Serializes mutating `execute`. A second write door races.
   * PARK_RELEASE: `ui()` drops this chain while the browser is open —
   * otherwise `term-continue/set` on the next TUI boot waits forever.
   */
  #writeChain: Promise<void> = Promise.resolve();
  readonly #loginAttempts = new Map<string, object>();
  #pickDirectory: DirectoryPicker = pickNativeDirectory;
  #pickingProject: Promise<string | null> | null = null;
  override rpcMethods = [
    DaemonRpcMethod.fromContract(contract.kernel.termContinue.set, (args) => {
      this.doc.root.termContinue[args.key] = args.sessionId;
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.termContinue.clear, (args) => {
      delete this.doc.root.termContinue[args.key];
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.drop, async (args) => {
      if (args.confirm !== true) {
        try {
          await this.ui(encodeUiDefinition({ kind: "confirm", title: `Remove ${args.id}?` }));
        } catch (error) {
          if (isUiCancelled(error)) return { ok: false };
          throw error;
        }
      }
      this.adjustConfig((config) => {
        RpcInvalidParams.invariant(args.id in config.connections, `connect/drop: unknown connection ${args.id}`);
        delete config.connections[args.id];
      });
      this.secrets.deleteConnectionSecrets(args.id);
      step(`memo-clear: connection=${args.id}`);
      await dropConnection(this.doc.root, args.id);
      return { ok: true };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.adopt, async ({ driver, name, settings, secrets }) => {
      step(`connect/adopt ${driver}`);
      const spec = this.doc.root.drivers[driver];
      RpcInvalidParams.invariant(
        spec !== undefined && spec.importPath.trim() !== "",
        `connect/adopt: unknown driver ${driver}`,
      );
      const signal = this.requestSignal();
      let bags;
      try {
        bags = await this.runtime.adopt(
          driver,
          this.doc.root.drivers,
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
      this.rejectDuplicateConnection("connect/adopt", driver, bags.settings ?? {}, {
        ...bags.secrets,
        ...(secrets ?? {}),
      });
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
      if (Object.keys(secretBag).length > 0) this.secrets.writeConnectionSecrets(id, secretBag);
      warmCompletionCatalog(this, this, id);
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
        this.doc.root.drivers[bags.driver] !== undefined,
        `mcp-server/adopt: unknown driver ${bags.driver}`,
      );
      this.rejectDuplicateConnection("mcp-server/adopt", bags.driver, bags.settings ?? {}, {
        ...bags.secrets,
        ...(secrets ?? {}),
      });
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
      if (Object.keys(secretBag).length > 0) this.secrets.writeConnectionSecrets(id, secretBag);
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
      let attempt: object | undefined;
      try {
        const spec = requireConnection(this.connections, args.id, "connect/login");
        attempt = {};
        this.#loginAttempts.set(args.id, attempt);
        const driver = spec.driver.name;
        const settings = settingsBag(spec);
        const beforeSettings = structuredClone(settings);
        const assertCurrent = (config = this.#config()): void => {
          if (signal.aborted) throw new DOMException("Sign-in cancelled", "AbortError");
          RpcInvalidParams.invariant(
            this.#loginAttempts.get(args.id) === attempt,
            "A newer sign-in attempt replaced this one. Try again.",
          );
          const row = config.connections[args.id];
          RpcInvalidParams.invariant(
            row?.driver === driver &&
              this.connections[args.id] === spec &&
              isDeepStrictEqual(row.settings, beforeSettings),
            "Connection changed during sign-in. Try again.",
          );
        };
        if (spec.driver.abilityClaim.includes("completion")) {
          // Re-run the driver's sign-in ceremony without allocating another connection.
          // Do not pass old secrets: key-based drivers must ask for a replacement too.
          const bags = await this.runtime.adopt(
            driver,
            this.doc.root.drivers,
            { name: spec.name, settings, signal, reauthenticate: true },
            (kind, body) => {
              RpcInvalidParams.invariant(kind === "UI", `unknown callback ${kind}`);
              return this.ui(body);
            },
          );
          if (signal.aborted) return { ok: false as const };
          this.adjustConfig((config) => {
            assertCurrent(config);
            const row = config.connections[args.id]!;
            row.settings = { ...row.settings, ...bags.settings };
          });
          this.secrets.writeConnectionSecrets(args.id, { ...bags.secrets });
          await dropConnection(this.doc.root, args.id);
          // The picker is still looking at the same id, so awareness does not
          // change. Warm the replacement handle explicitly after dropping it.
          await probeCompletionCatalog(this, this, args.id);
          return { ok: true as const };
        }
        const result = await loginConnection(args.id, this.connections, {
          signal,
          ui: (body) => this.ui(body),
          writeSecrets: (id, secrets) => {
            assertCurrent();
            this.secrets.writeConnectionSecrets(id, { ...secrets });
          },
          readSecrets: (id) => this.secrets.readConnectionSecrets(id),
        });
        assertCurrent();
        step(`memo-clear: connection=${args.id}`);
        await dropConnection(this.doc.root, args.id);
        return result;
      } catch (error) {
        if (isUiCancelled(error) || isAbortError(error)) return { ok: false as const };
        if (error instanceof RpcInvalidParams) throw error;
        fail("connect/login", error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "connect/login failed");
      } finally {
        if (attempt != null && this.#loginAttempts.get(args.id) === attempt) this.#loginAttempts.delete(args.id);
      }
    }),
    DaemonRpcMethod.fromContract(contract.kernel.connect.logout, (args) => {
      step(`connect/logout ${args.id}`);
      requireConnection(this.connections, args.id, "connect/logout");
      logoutMcpHttp(args.id, {
        writeSecrets: (connectionId, secrets) => this.secrets.writeConnectionSecrets(connectionId, { ...secrets }),
      });
      step(`memo-clear: connection=${args.id}`);
      void dropConnection(this.doc.root, args.id).catch((error: unknown) => fail("connect/logout", error));
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.set, (args) => {
      RpcInvalidParams.invariant(this.doc.root.plugins[args.name] != null, `plugin/set: unknown plugin ${args.name}`);
      this.adjustConfig((config) => applyPluginSet(config, args));
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.install, async (args) => {
      RpcInvalidParams.invariant(
        this.contour === "local",
        "plugin/install: server contour uses host-installed runtime plugins only",
      );
      let spec = args.spec?.trim() ?? "";
      if (spec === "") {
        try {
          const answered = await this.ui(
            encodeUiDefinition({
              kind: "input",
              name: "Plugin package or path",
              description: "npm package, path, or file: URL",
            }),
          );
          spec = answered.kind === "text" ? answered.input.trim() : "";
        } catch (error) {
          if (isUiCancelled(error) || isAbortError(error)) return { ok: false as const };
          throw error;
        }
      }
      if (spec === "") return { ok: false as const };
      const npmName = installedNpmName(spec) ?? packageNameOf(spec);
      const captured = captureInstallStreams();
      const code = await installPlugin(captured.streams, this.root, spec);
      if (code !== 0) {
        const detail = captured.stderr().trim();
        RpcInvalidParams.invariant(false, detail === "" ? `plugin/install: ${spec} failed` : detail);
      }
      // install writes package.json and config on its own. Reflect before the
      // caller reads the document, instead of waiting for the file watcher.
      this.adjustConfig(() => {});
      const plugin = Object.values(this.doc.root.plugins).find((row) => row.sourceNpm === npmName);
      RpcInvalidParams.invariant(plugin != null, `plugin/install: ${spec} did not appear`);
      return { name: plugin.pluginName, npmName };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.plugin.remove, async (args) => {
      RpcInvalidParams.invariant(
        this.contour === "local",
        "plugin/remove: server contour uses host-installed runtime plugins only",
      );
      const plugin = this.doc.root.plugins[args.name];
      RpcInvalidParams.invariant(plugin != null, `plugin/remove: unknown plugin ${args.name}`);
      if (args.confirm === false) {
        try {
          await this.ui(encodeUiDefinition({ kind: "confirm", title: `Remove ${args.name}?` }));
        } catch (error) {
          if (isUiCancelled(error) || isAbortError(error)) return { ok: false };
          throw error;
        }
      }
      const current = this.doc.root.plugins[args.name];
      RpcInvalidParams.invariant(current != null, `plugin/remove: unknown plugin ${args.name}`);
      const npmName = current.sourceNpm;
      adjustJson(join(this.root, "package.json"), (raw) => withoutDependency(raw, npmName));
      if (npmName !== "") {
        rmSync(join(this.root, "node_modules", ...npmName.split("/")), { recursive: true, force: true });
      }
      this.adjustConfig((config) => {
        delete config.plugins[args.name];
      });
      return { ok: true };
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
      return { skills: listSkillFiles(project, skillsHome(), this.#reservedSkillCommands()) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.skill.write, (args) => {
      const root = args.scope === "home" ? this.#skillsHome() : this.#knownProject(args.project);
      RpcInvalidParams.invariant(root != null, "skill/write: no directory for that scope");
      const location = writeSkillFile(root, args.name, args.description, args.body);
      const listed = listSkillFiles(
        args.scope === "project" ? root : null,
        args.scope === "home" ? root : skillsHome(),
        this.#reservedSkillCommands(),
      );
      const row = listed.find((skill) => skill.location === location || skill.name === args.name);
      return (
        row ?? {
          name: args.name,
          description: args.description,
          location,
          invoke: this.#reservedSkillCommands().has(args.name) ? `skill:${args.name}` : args.name,
          scope: args.scope,
        }
      );
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
        this.#reservedSkillCommands(),
      );
      const row = listed.find((skill) => skill.name === args.name && skill.scope === args.scope);
      RpcInvalidParams.invariant(row != null, `skill/read: unknown skill ${args.name}`);
      return { ...row, body: skillBody(row.location) };
    }),
    DaemonRpcMethod.fromContract(contract.kernel.remote.login, async ({ name }) => {
      RpcInvalidParams.invariant(
        this.contour === "local" && this.#connector != null,
        "remote: only available in local contour",
      );
      step("remote/login");
      const signal = this.requestSignal();
      try {
        const done = await this.#remote.login((body) => this.ui(body), {
          signal,
          ...(name === undefined ? {} : { name }),
        });
        this.#connector.start();
        return { ok: true as const, ...done };
      } catch (error) {
        if (isUiCancelled(error) || isAbortError(error)) return { ok: false as const };
        fail("remote/login", error);
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "remote/login failed");
      }
    }),
    DaemonRpcMethod.fromContract(contract.kernel.remote.status, () =>
      this.#remote.status(this.#connector?.connected ?? false),
    ),
    DaemonRpcMethod.fromContract(contract.kernel.remote.logout, async () => {
      RpcInvalidParams.invariant(
        this.contour === "local" && this.#connector != null,
        "remote: only available in local contour",
      );
      step("remote/logout");
      const done = this.#remote.logout();
      await this.#connector.stop();
      return { ok: true as const, ...done };
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
    DaemonRpcMethod.fromContract(contract.kernel.project.pick, async () => {
      RpcInvalidParams.invariant(
        this.contour === "local" && !this.isRemoteRequest(),
        "project/pick: only available locally",
      );
      const signal = this.requestSignal();
      let picking = this.#pickingProject;
      if (picking == null) {
        const run = Promise.resolve().then(() => this.#pickDirectory(signal));
        this.#pickingProject = run;
        picking = run.finally(() => {
          if (this.#pickingProject === run) this.#pickingProject = null;
        });
      }
      let picked: string | null;
      try {
        picked = await picking;
      } catch (error) {
        if (isAbortError(error)) return { ok: false as const };
        RpcInvalidParams.invariant(false, error instanceof Error ? error.message : "project/pick failed");
      }
      if (picked == null || picked.trim() === "" || signal.aborted) return { ok: false as const };
      let resolved: string;
      try {
        resolved = realpathSync(picked.trim());
        RpcInvalidParams.invariant(statSync(resolved).isDirectory(), `project/pick: not a directory: ${picked}`);
      } catch (error) {
        if (error instanceof RpcInvalidParams) throw error;
        RpcInvalidParams.invariant(false, `project/pick: invalid directory: ${picked}`);
      }
      const project = this.project(resolved);
      await project.ready;
      return { ok: true as const, path: project.path };
    }),
  ];

  constructor(root: string, registry?: DriverRegistry);
  constructor(options: KernelDaemonOptions);
  constructor(
    rootOrOptions: string | KernelDaemonOptions,
    // Fixture drivers (park-mcp) join the product roster here; no mutable global table.
    registry?: DriverRegistry,
  ) {
    super();
    const options: KernelDaemonOptions =
      typeof rootOrOptions === "string" ? { root: rootOrOptions, registry } : rootOrOptions;
    const contour: KernelContour = options.contour ?? "local";
    const kernelId = options.kernelId ?? "local";
    const resolvedRoot =
      options.root ?? (contour === "server" ? `server://kernel/${kernelId}` : "");
    if (contour === "local" && resolvedRoot === "") {
      throw new Error("KernelDaemon(local): root directory is required");
    }
    this.contour = contour;
    this.kernelId = kernelId;
    this.root = resolvedRoot;
    this.#bundledPlugins = options.bundledPlugins;
    if (contour === "local") {
      mkdirSync(this.root, { recursive: true });
    }
    this.db =
      options.db ??
      new HarnessDatabase(contour === "server" ? ":memory:" : join(this.root, "harness.db"), {
        kernelId: this.kernelId,
      });
    this.#ownsDb = options.ownsDb ?? options.db === undefined;
    this.laneHub = options.laneHub ?? new UpdateLaneHub(this.db);
    this.#ownsLaneHub = options.ownsLaneHub ?? options.laneHub === undefined;
    this.secrets =
      options.secrets ??
      (contour === "server" ? new MemorySecretsVault() : new FsSecretsVault(this.root));
    this.#ownsSecrets = options.ownsSecrets ?? options.secrets === undefined;
    const bucket =
      options.blobBucket ??
      (contour === "server" ? new MemoryBlobBucket() : new FsBlobBucket(this.root));
    this.blobs = new BlobStore(bucket, {
      ownsBucket: options.ownsBlobs ?? options.blobBucket === undefined,
    });
    this.#ownsBlobs = true;
    this.visuals =
      options.visuals ??
      (contour === "server" ? new MemoryVisualStore() : new FsVisualStore(this.root));
    this.#ownsVisuals = options.ownsVisuals ?? options.visuals === undefined;
    this.behavior = new BehaviorKernel({
      packages: () =>
        Object.values(this.doc.root.plugins)
          .filter((plugin) => plugin.enabled && plugin.rootPath !== "")
          .map((plugin) => ({
            name: plugin.pluginName,
            root: plugin.rootPath,
            foreground: this.#config().plugins[plugin.pluginName]?.foreground !== false,
          })),
      approved: (plugin) => new Set(this.#config().plugins[plugin]?.guards),
      store:
        contour === "server"
          ? new DbStateStore({
              db: this.db,
              kernelId: this.kernelId,
              sessionRoot: (sessionId) => this.runtime.replica(sessionId)?.root,
            })
          : new KernelStateStore(
              () => this.root,
              (sessionId) => this.runtime.replica(sessionId)?.root,
            ),
    });
    this.#remote = new RemoteAccess({
      credentials: {
        read: (id) => this.secrets.readConnectionSecrets(id),
        write: (id, secrets) => this.secrets.writeConnectionSecrets(id, { ...secrets }),
      },
    });
    if (contour === "local") {
      this.#connector = new RemoteConnector({
        access: this.#remote,
        sockPath: daemonSocketPath(realpathOrSelf(this.root)),
        http: {
          staticDir: process.env[WEB_STATIC_DIR_ENV],
          fileRoots: () => Object.keys(this.doc.root.projects),
        },
      });
      if (options.visuals === undefined) {
        bindVisualStore(this.root);
      }
      if (options.blobBucket === undefined) {
        bindBlobBucket(bucket);
      }
    }
    const effectiveRegistry =
      options.registry ?? registry ?? openDriverRegistry(PRODUCT_PROVIDERS);
    this.runtime = new ProductionRuntime({
      registry: effectiveRegistry,
      catalog: this.catalog,
    });
    // A failed boot must not keep the watchers and autoruns it already built.
    this.ready = this.#boot().catch((error: unknown) => {
      this[Symbol.dispose]();
      throw error;
    });
  }

  runInStoreContext<T>(fn: () => T): T {
    return runWithBlobWriter(this.blobs.write, () =>
      runWithBlobReader(this.blobs.readBytes, () =>
        runWithVisualReader((sessionId, id) => this.visuals.read(sessionId, id), fn),
      ),
    );
  }

  /** Dispose can land at any await; each one bails rather than build on a closed kernel. */
  async #boot(): Promise<void> {
    this.doc = this.#hydrateKernel();
    if (this.#closed) return;
    const kernel = this.doc;
    this.runtime.bind(kernel.root, this.contour === "local" ? { moduleRoot: this.root } : undefined);
    this.#room = new PresenceRoom(kernel.awareness);
    if (this.contour === "local") {
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
      for (const npm of KERNEL_SEED_PACKAGES) {
        const packageRoot = resolveSeedPackageRoot(npm);
        if (packageRoot !== null) linkSeedPackage(this.root, npm, packageRoot);
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
    } else {
      if (this.#readServerScm("policy", "config.json") === undefined) {
        this.#writeServerScm(
          "policy",
          "config.json",
          JSON.stringify(
            {
              connections: {},
              compact: DEFAULT_COMPACT_STRATEGY,
              compactTriggers: { ...DEFAULT_COMPACT_TRIGGERS },
              compactKeepTurns: DEFAULT_COMPACT_KEEP_TURNS,
            },
            null,
            2,
          ),
        );
      }
      this.adjustConfig((config) => {
        if (!Number.isInteger(config.compactKeepTurns) || (config.compactKeepTurns as number) < 1) {
          config.compactKeepTurns = DEFAULT_COMPACT_KEEP_TURNS;
        }
      });
      if (this.#readServerScm("command", "compact.scm") === undefined) {
        this.#writeServerScm("command", "compact.scm", defaultCompactSource());
      }
      this.#syncServerReflection();
    }
    if (this.#closed) return;
    projectHostPluginSpecs(kernel.root);
    this.projections.install(HOST_PLUGINS);
    this.#packPluginHost = new PackPluginCatalogHost({
      catalog: this.catalog,
      kernelRoot: this.root,
      kernel: kernel.root,
      onError: (pluginName, error) => fail(`pack plugin ${pluginName}`, error),
    });
    this.#disposePackPluginWatch = autorun(() => {
      const rows: PackPluginRow[] = [];
      for (const [key, spec] of Object.entries(this.doc.root.plugins)) {
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
    let initialAbi: Promise<void> = Promise.resolve();
    this.#disposePluginBots = autorun(() => {
      this.#syncPluginBots();
      initialAbi = this.#syncPluginAbi();
    });
    let initialRevisions: Promise<void> = Promise.resolve();
    this.#disposeBotRevisions = reaction(
      () => this.behavior.packages().map((plugin) => `${plugin.name}\0${plugin.root}`),
      (keys) => {
        const enabled = new Set(keys);
        const packages = this.behavior.packages().filter((plugin) => enabled.has(`${plugin.name}\0${plugin.root}`));
        const epoch = ++this.#botRevisionEpoch;
        initialRevisions = botRevisions(packages)
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
    if (this.contour === "local") {
      this.#reflector = new KernelReflector(this.root, kernel.root, this.runtime.registry);
      await Promise.all([this.#reflector.ready, initialAbi, initialRevisions]);
      if (this.#closed) return;
      warmCompletionCatalog(this, this);
      this.#homeWatcher = new BotsWatcher(defaultBotsHome(this.root), () => this.#syncHomeBots(true));
    } else {
      await Promise.all([initialAbi, initialRevisions]);
      if (this.#closed) return;
      warmCompletionCatalog(this, this);
    }
    this.#globalHost = new ProjectDaemon(this, this.root, true);
    await this.#globalHost.ready;
    if (this.#closed) return;
    const storedWorkspaces = new Set<string>(Object.keys(kernel.root.projects));
    const scopeRows = this.db.sqlite
      .prepare("SELECT DISTINCT scope_id FROM scope_nodes WHERE kernel_id = ? AND scope_id LIKE 'project:%'")
      .all(this.kernelId) as Array<{ readonly scope_id: string }>;
    for (const row of scopeRows) {
      storedWorkspaces.add(row.scope_id.slice("project:".length));
    }
    for (const workspace of storedWorkspaces) {
      if (this.#closed) return;
      if (workspace === "" || workspace === this.#globalHost.path) continue;
      if (this.contour === "local" && !existsSync(workspace)) continue;
      // One unloadable project is that project's failure, not the kernel's.
      await this.project(workspace).ready.catch((error: unknown) => fail(`project ${workspace}`, error));
    }
    const prunedSessions = new Set<string>();
    const touchedProjectPaths = new Set<string>();
    runInAction(() => {
      for (const id of Object.keys(kernel.root.sessions)) {
        if (!this.hasStoredSession(id)) {
          prunedSessions.add(id);
          delete kernel.root.sessions[id];
          kernel.root.reconcileAgentRelations(id, []);
        }
      }
      for (const [name, id] of Object.entries(kernel.root.botsRoster)) {
        if (!this.hasStoredSession(id)) {
          prunedSessions.add(id);
          delete kernel.root.botsRoster[name];
        }
      }
      for (const project of [this.#globalHost, ...this.#projects.values()]) {
        if (project?.doc == null) continue;
        let projectTouched = false;
        for (const id of Object.keys(project.root.sessions)) {
          if (!this.hasStoredSession(id)) {
            prunedSessions.add(id);
            delete project.root.sessions[id];
            projectTouched = true;
          }
        }
        for (const [name, id] of Object.entries(project.root.botsRoster)) {
          if (!this.hasStoredSession(id)) {
            prunedSessions.add(id);
            delete project.root.botsRoster[name];
            projectTouched = true;
          }
        }
        if (projectTouched) touchedProjectPaths.add(project.path);
      }
      if (prunedSessions.size > 0) {
        for (const [callId, rel] of Object.entries(kernel.root.agentCalls)) {
          if (prunedSessions.has(rel.callerSessionId) || prunedSessions.has(rel.workerSessionId)) {
            delete kernel.root.agentCalls[callId];
          }
        }
        for (const [tabKey, id] of Object.entries(kernel.root.termContinue)) {
          if (prunedSessions.has(id)) {
            delete kernel.root.termContinue[tabKey];
          }
        }
      }
    });
    if (prunedSessions.size > 0) {
      for (const path of touchedProjectPaths) {
        const projectDoc = this.#projectDocs.get(path);
        if (projectDoc != null) this.#flushScopeSync(projectScopeId(path), projectDoc);
      }
      this.flushKernel();
    }
    for (const [id, glance] of Object.entries(kernel.root.sessions)) {
      if (glance?.resident !== true) continue;
      if (this.#closed) break;
      await this.attachSession(id).catch((error: unknown) => fail(`resident ${id}`, error));
    }
    // An attach in flight when dispose ran may have registered a daemon after it.
    if (this.#closed) {
      this[Symbol.dispose]();
    } else {
      this.#activate();
      if (this.contour === "local" && remoteLoggedIn(this.secrets)) this.#connector?.start();
    }
  }

  /** Occupancy attach starts after needed replicas are interned. */
  #activate(): void {
    if (this.#activated) return;
    this.#activated = true;
    this.runtime.activate();
    for (const [id, session] of this.runtime.replicaEntries()) {
      this.#watchSessionOccupancy(id, session);
    }
    this.#watchEligibility();
  }

  get connections() {
    return this.doc.root.connections;
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
    projectBotSpecs(this.doc.root, faces);
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
        this.doc.root.replacePluginTools(
          row.plugin,
          row.entries.map((entry) => ({
            name: entry.wireName,
            question: entry.question ?? null,
            effect: entry.effect ?? null,
            caption: entry.caption ?? null,
          })),
        );
      }
      for (const name of dropped) this.doc.root.replacePluginTools(name, []);
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
    for (const plugin of Object.values(this.doc.root.plugins)) {
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
    RpcInvalidParams.invariant(Object.hasOwn(this.doc.root.projects, path), `unknown project ${path}`);
    return path;
  }

  #reservedSkillCommands(): ReadonlySet<string> {
    const reserved = new Set<string>(HOST_QUEUE_VERBS);
    for (const [key, spec] of Object.entries(this.doc.root.commands)) {
      if (key !== "") reserved.add(key);
      if (spec == null) continue;
      if (spec.verb !== "") reserved.add(spec.verb);
      for (const alias of spec.aliases) {
        if (alias !== "") reserved.add(alias);
      }
    }
    return reserved;
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

  #scmResourceId(kind: ScmResourceKind, name: string): string {
    return `${this.kernelId}\0kernel\0${kind}\0${name}`;
  }

  #readServerScm(kind: ScmResourceKind, name: string): string | undefined {
    return this.db.getScmResource(this.#scmResourceId(kind, name))?.source;
  }

  #writeServerScm(kind: ScmResourceKind, name: string, source: string): void {
    this.db.upsertScmResource({
      id: this.#scmResourceId(kind, name),
      kernelId: this.kernelId,
      scope: "kernel",
      scopeId: this.kernelId,
      kind,
      name,
      source,
      sha256: createHash("sha256").update(source).digest("hex"),
      updatedAtMs: Date.now(),
    });
  }

  #readServerGrantRows(): GrantRow[] {
    const raw = this.#readServerScm("policy", "grants.json");
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return parseGrantRows(
        JSON.stringify(Array.isArray(parsed) ? parsed : ((parsed as { rows?: unknown })?.rows ?? [])),
      );
    } catch {
      return [];
    }
  }

  #syncServerReflection(): void {
    let config: ConfigJson | undefined;
    const rawConfig = this.#readServerScm("policy", "config.json");
    if (rawConfig !== undefined) {
      try {
        config = parseConfigJson(JSON.parse(rawConfig));
      } catch (error) {
        config = undefined;
        fail("config.json", error);
      }
    }
    const disabled = new Set<string>();
    if (config !== undefined) {
      for (const [name, policy] of Object.entries(config.plugins)) {
        if (policy.enabled === false) disabled.add(name);
      }
    }
    const grants = this.#readServerGrantRows();
    const grantsJson = grants.length === 0 ? "" : JSON.stringify(grants);
    const compactBody = this.#readServerScm("command", "compact.scm") ?? defaultCompactSource();
    let kvBag: Record<string, string> = {};
    try {
      const state = this.db.getKernelState(this.kernelId);
      kvBag = state !== undefined ? parseKvBag(JSON.parse(state.kvsJson)) : { ...this.doc.root.kvs };
    } catch {
      kvBag = { ...this.doc.root.kvs };
    }
    const packages =
      this.#bundledPlugins ??
      KERNEL_SEED_PACKAGES.flatMap((npmName) => {
        const rootPath = resolveSeedPackageRoot(npmName);
        return rootPath === null ? [] : [{ npmName, rootPath }];
      });
    projectKernelConfigToRoot(this.doc.root, {
      config,
      grantsJson,
      kvBag,
      compactBody,
      compactSource: "scm://kernel/compact.scm",
      inventory: readBundledPluginInventory(packages, disabled),
      registry: this.runtime.registry,
    });
  }

  #config(): ConfigJson {
    if (this.contour === "server") {
      try {
        const raw = this.#readServerScm("policy", "config.json");
        return parseConfigJson(raw === undefined ? {} : JSON.parse(raw));
      } catch {
        return parseConfigJson({});
      }
    }
    try {
      return parseConfigJson(fs.readJsonSync(join(this.root, "config.json")));
    } catch {
      return parseConfigJson({});
    }
  }

  /** Refuses a second connection to the same endpoint with the same (or no) static token. */
  private rejectDuplicateConnection(
    method: string,
    driver: string,
    settings: Readonly<Record<string, unknown>>,
    secrets: Readonly<Record<string, string>>,
  ): void {
    const stored = Object.fromEntries(
      Object.entries(this.connections).map(([id, spec]) => [
        id,
        { driver: spec.driver.name, settings: settingsBag(spec), secrets: this.secrets.readConnectionSecrets(id) },
      ]),
    );
    const twin = duplicateConnectionOf({ driver, settings, secrets }, stored);
    RpcInvalidParams.invariant(
      twin === null,
      `${method}: already connected as ${twin ?? ""} (same endpoint and token); sign in with OIDC or use another token for a second connection`,
    );
  }

  adjustConfig(update: (config: ConfigJson) => ConfigJson | void): ConfigJson {
    if (this.contour === "server") {
      const current = this.#config();
      const next = parseConfigJson(update(current) ?? current);
      this.#writeServerScm("policy", "config.json", `${JSON.stringify(next, null, 2)}\n`);
      this.#syncServerReflection();
      return next;
    }
    const next = adjustJson<ConfigJson>(join(this.root, "config.json"), (raw) => {
      const config = parseConfigJson(raw);
      return parseConfigJson(update(config) ?? config);
    });
    reflectKernel(this.root, this.doc.root, this.runtime.registry);
    return next;
  }

  /** Stored grants of project, bot and global scope (`grants.json`). Session grants live on their session. */
  persistentGrants(): GrantRow[] {
    return parseGrantRows(this.doc.root.grantsJson);
  }

  /** Write one more stored grant (a human's "remember", or a settings grant). */
  addPersistentGrant(row: GrantRow): void {
    if (this.contour === "server") {
      const rows = this.#readServerGrantRows();
      this.#writeServerScm("policy", "grants.json", `${JSON.stringify([...rows, row], null, 2)}\n`);
      this.#syncServerReflection();
      this.#reconcileGrants();
      return;
    }
    adjustJson<GrantRow[]>(join(this.root, "grants.json"), (raw) => {
      const rows = parseGrantRows(JSON.stringify(Array.isArray(raw) ? raw : []));
      return [...rows, row];
    });
    reflectKernel(this.root, this.doc.root, this.runtime.registry);
    this.#reconcileGrants();
  }

  /** Revoke a stored grant by id, in the kernel file or on a session. Re-floors the unlicensed asks it covered. */
  revokeGrant(id: string, sessionId?: string): boolean {
    let removed = false;
    const rows = this.persistentGrants();
    if (rows.some((row) => row.id === id)) {
      const remaining = rows.filter((row) => row.id !== id);
      if (this.contour === "server") {
        this.#writeServerScm("policy", "grants.json", `${JSON.stringify(remaining, null, 2)}\n`);
        this.#syncServerReflection();
      } else {
        adjustJson<GrantRow[]>(join(this.root, "grants.json"), () => remaining);
        reflectKernel(this.root, this.doc.root, this.runtime.registry);
      }
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
    if (this.contour === "server") {
      this.#writeServerScm("policy", "grants.json", `${JSON.stringify(live, null, 2)}\n`);
      this.#syncServerReflection();
    } else {
      adjustJson<GrantRow[]>(join(this.root, "grants.json"), () => live);
      reflectKernel(this.root, this.doc.root, this.runtime.registry);
    }
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
    if (this.contour === "server") {
      let current: Record<string, string> = {};
      try {
        const state = this.db.getKernelState(this.kernelId);
        current = parseKvBag(state !== undefined ? JSON.parse(state.kvsJson) : { ...this.doc?.root.kvs });
      } catch {
        current = parseKvBag({ ...this.doc?.root.kvs });
      }
      const next = parseKvBag(update(current) ?? current);
      this.db.upsertKernelState({
        id: this.kernelId,
        kernelId: this.kernelId,
        defaultModel: next.model ?? "",
        permissionMode: this.doc?.root.defaultPermissionMode ?? "manual",
        enabledPluginsJson: JSON.stringify(this.doc?.root.enabledPlugins ?? []),
        kvsJson: JSON.stringify(next),
        updatedAtMs: Date.now(),
      });
      return next;
    }
    return adjustJson(join(this.root, "kv.json"), (raw) => {
      const bag = parseKvBag(raw);
      return update(bag) ?? bag;
    });
  }

  writeKvs(proposals: readonly KvProposal[]): void {
    this.adjustKv((bag) => {
      applyKv(bag, proposals);
    });
    this.doc.root.applyKvs(proposals);
  }

  rememberModelChoice(connection: string, model: string): void {
    this.doc.root.stampModelUsage(connection, model);
  }

  writeDefaultPermissionMode(policy: PermissionMode): void {
    this.adjustConfig((config) => {
      config.defaultPermissionMode = policy;
    });
  }

  override ui(body: string) {
    this.#writeChain = Promise.resolve();
    return super.ui(body);
  }

  protected override queuesExecute(method: string): boolean {
    return method !== "term-continue/set" && method !== "term-continue/clear" && method !== "project/pick";
  }

  protected override execute(run: () => unknown | Promise<unknown>) {
    const bound = this.bindPerform(run);
    const wrapped = () => this.runInStoreContext(() => bound());
    const next = this.#writeChain.then(wrapped, wrapped);
    this.#writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  protected override attach(socket: PlaneSocket, connectionId: string): ((text: string) => boolean) | void {
    return attachPlane({
      socket,
      connectionId,
      laneHub: this.laneHub,
      room: this.#room,
    });
  }

  internSession(sessionId: string, session: SessionDocument, daemon?: SessionDaemon): void {
    bindSessionProjections(session.root, this.projections);
    this.runtime.intern(sessionId, session);
    this.sessionRoom(sessionId, session.awareness);
    this.#bindSessionFlush(sessionId, session);
    if (daemon != null && daemon.interpreting) this.#daemons.set(sessionId, daemon);
    this.#rememberConversation(sessionId, session);
    this.#watchSessionGlance(sessionId, session);
    runInAction(() => this.#eligibilityEpoch.set(this.#eligibilityEpoch.get() + 1));
    if (this.#activated) this.#watchSessionOccupancy(sessionId, session);
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

  foregroundSessionIds(): ReadonlySet<string> {
    const snap = this.#eligibilitySnapshot();
    return graphEligibleSessionIds({ ...snap, resident: new Set(), reserved: new Set(), running: new Set() });
  }

  #eligibilitySnapshot() {
    this.#eligibilityEpoch.get();
    const occupied = new Set<string>();
    const running = new Set<string>();
    for (const id of this.runtime.acquired) {
      if (sessionIsOccupied(this.doc.awareness, id)) occupied.add(id);
      const live = this.liveSession(id);
      if (live?.orchestrator.activated === true) {
        for (const turn of live.root.liveTurns) {
          if ((!turn.reducerExited && !turn.completed) || turn.openBackgroundWork.length > 0) {
            running.add(id);
            break;
          }
        }
      }
    }
    return this.runtime.eligibilitySnapshot({
      occupied,
      reserved: new Set(this.#reservations),
      running,
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
  sessionDoc(sessionId: string): SessionDocument | undefined {
    return this.runtime.replica(sessionId);
  }

  sessionRoom(sessionId: string, awareness: SessionDocument["awareness"]): PresenceRoom {
    const held = this.#sessionRooms.get(sessionId);
    if (held != null) return held;
    const room = new PresenceRoom(awareness);
    this.#sessionRooms.set(sessionId, room);
    return room;
  }

  #bindScopeFlush(scopeId: string, doc: DocumentContainer<any, any>, afterFlush?: () => void): void {
    const slot = `scope:${scopeId}`;
    if (this.#flushStops.has(slot)) return;
    let scheduled = false;
    const flushNow = (): void => {
      scheduled = false;
      if (this.#closed) return;
      try {
        this.#flushScopeSync(scopeId, doc);
        afterFlush?.();
      } catch (error) {
        fail("scope flush", error);
      }
    };
    const unsub = doc.onPatch(() => {
      if (scheduled || this.#closed) return;
      scheduled = true;
      queueMicrotask(flushNow);
    });
    this.#flushStops.set(slot, () => {
      scheduled = false;
      unsub();
    });
  }

  #bindSessionFlush(sessionId: string, session: SessionDocument): void {
    const slot = `session:${sessionId}`;
    if (this.#flushStops.has(slot)) return;
    let timer: NodeJS.Timeout | undefined;
    const flushNow = (): void => {
      timer = undefined;
      if (this.#closed) return;
      try {
        const delta = session.peekNodeDelta();
        if (delta.upserts.length === 0 && delta.deletes.length === 0) return;
        this.#flushSessionSync(session);
      } catch (error) {
        fail("session flush", error);
      }
    };
    const unsub = session.onPatch(() => {
      if (timer !== undefined || this.#closed) return;
      timer = setTimeout(flushNow, 50);
      timer.unref();
    });
    this.#flushStops.set(slot, () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      unsub();
    });
  }

  /**
   * Persist the session's nodes and normalized tables in SQLite.
   * `force` replaces all stored `session_nodes` rows for this session after pruning unreachable nodes.
   */
  async flushSession(
    session: SessionDocument,
    options?: { readonly force?: boolean; readonly checkpoint?: SessionCheckpoint },
  ): Promise<void> {
    if (options?.checkpoint != null) {
      this.commitCheckpoint(options.checkpoint, { force: options.force });
      session.commitNodeDelta({
        revision: options.checkpoint.revision,
        upserts: options.checkpoint.upsertedNodes,
        deletes: options.checkpoint.deletedNodeIds,
      });
      return;
    }
    this.#flushSessionSync(session, options);
  }

  commitCheckpoint(checkpoint: SessionCheckpoint, options?: { readonly force?: boolean }): SessionReceipt {
    this.db.writeTransaction(
      ["sessions", "session_nodes", "session_turns", "pending_asks", "session_effects"],
      (tx) => {
        const row = checkpoint.sessionRow;
        tx.insert(sessionsTable)
          .values({
            sessionId: checkpoint.sessionId,
            kernelId: this.kernelId,
            projectId: row.projectId ?? "",
            title: row.title ?? "",
            workspacePath: row.workspacePath ?? "",
            mode: row.mode ?? "assistant",
            permissionMode: row.permissionMode ?? "manual",
            running: row.running ?? false,
            headTurnId: row.headTurnId ?? null,
            parentSessionId: row.parentSessionId ?? null,
            parentCallId: row.parentCallId ?? null,
            depth: row.depth ?? 0,
            revision: checkpoint.revision,
            createdAtMs: row.createdAtMs ?? Date.now(),
            lastActiveAtMs: row.lastActiveAtMs ?? Date.now(),
            archivedAtMs: row.archivedAtMs ?? null,
          })
          .onConflictDoUpdate({
            target: sessionsTable.sessionId,
            set: {
              kernelId: this.kernelId,
              ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
              ...(row.title !== undefined ? { title: row.title } : {}),
              ...(row.workspacePath !== undefined ? { workspacePath: row.workspacePath } : {}),
              ...(row.mode !== undefined ? { mode: row.mode } : {}),
              ...(row.permissionMode !== undefined ? { permissionMode: row.permissionMode } : {}),
              ...(row.running !== undefined ? { running: row.running } : {}),
              ...(row.headTurnId !== undefined ? { headTurnId: row.headTurnId } : {}),
              ...(row.parentSessionId !== undefined ? { parentSessionId: row.parentSessionId } : {}),
              ...(row.parentCallId !== undefined ? { parentCallId: row.parentCallId } : {}),
              ...(row.depth !== undefined ? { depth: row.depth } : {}),
              revision: checkpoint.revision,
              lastActiveAtMs: row.lastActiveAtMs ?? Date.now(),
              ...(row.archivedAtMs !== undefined ? { archivedAtMs: row.archivedAtMs } : {}),
            },
          })
          .run();

        this.db.commitSessionNodesInTx(
          tx,
          checkpoint.sessionId,
          {
            rootId: checkpoint.rootNodeId,
            revision: checkpoint.revision,
            upserts: checkpoint.upsertedNodes,
            deletes: checkpoint.deletedNodeIds,
            replaceAll: options?.force === true,
          },
          this.kernelId,
        );

        for (const turn of checkpoint.dirtyTurns) {
          tx.insert(sessionTurnsTable)
            .values(turn)
            .onConflictDoUpdate({
              target: sessionTurnsTable.turnId,
              set: {
                status: turn.status,
                cancelRequested: turn.cancelRequested,
                reducerExited: turn.reducerExited,
                endedAtMs: turn.endedAtMs,
              },
            })
            .run();
        }

        tx.delete(pendingAsksTable).where(eq(pendingAsksTable.sessionId, checkpoint.sessionId)).run();
        for (const ask of checkpoint.pendingAsks) {
          tx.insert(pendingAsksTable).values(ask).run();
        }

        for (const eff of checkpoint.effectRecords) {
          this.db.upsertSessionEffectInTx(tx, eff);
        }
      },
    );

    return {
      sessionId: checkpoint.sessionId,
      incarnation: checkpoint.incarnation,
      revision: checkpoint.revision,
    };
  }

  flushKernel(options?: { readonly force?: boolean }): void {
    if (this.doc == null) return;
    this.#flushScopeSync(KERNEL_SCOPE_ID, this.doc, options);
    this.#syncKernelStateToDb(this.doc);
  }

  #flushAllDirtyBeforeClose(): void {
    for (const session of this.runtime.replicaValues()) {
      if (session.isDestroyed) continue;
      try {
        const delta = session.peekNodeDelta();
        if (delta.upserts.length > 0 || delta.deletes.length > 0) {
          this.#flushSessionSync(session);
        }
      } catch {
        // Best-effort drain on shutdown; read-only or unbooted DBs must not fail dispose.
      }
    }
    for (const [path, projectDoc] of this.#projectDocs) {
      if (projectDoc.isDestroyed) continue;
      try {
        this.#flushScopeSync(projectScopeId(path), projectDoc);
      } catch {
        // Ignore shutdown flush failures.
      }
    }
    if (this.doc != null && !this.doc.isDestroyed) {
      try {
        this.#flushScopeSync(KERNEL_SCOPE_ID, this.doc);
        this.#syncKernelStateToDb(this.doc);
      } catch {
        // Ignore shutdown flush failures.
      }
    }
  }

  #flushScopeSync(scopeId: string, doc: DocumentContainer<any, any>, options?: { readonly force?: boolean }): void {
    if (options?.force === true) {
      doc.pruneUnreachableNodes();
      const rows = doc.toNodeRows();
      const revision = Math.max(doc.revision, 1);
      this.db.commitScopeNodes(
        scopeId,
        {
          rootId: doc.root.uuid,
          revision,
          upserts: rows,
          deletes: [],
          replaceAll: true,
        },
        this.kernelId,
      );
      doc.markAllNodesCommitted();
      return;
    }
    const delta = doc.peekNodeDelta();
    if (delta.upserts.length === 0 && delta.deletes.length === 0) return;
    this.db.commitScopeNodes(scopeId, delta, this.kernelId);
    doc.commitNodeDelta(delta);
  }

  #syncKernelStateToDb(kernel: KernelDocument = this.doc): void {
    const root = kernel.root;
    this.db.upsertKernelState({
      id: this.kernelId,
      kernelId: this.kernelId,
      defaultModel: root.kvs.model ?? "",
      permissionMode: root.defaultPermissionMode,
      enabledPluginsJson: JSON.stringify(root.enabledPlugins),
      kvsJson: JSON.stringify(root.kvs),
      updatedAtMs: Date.now(),
    });
  }

  #flushSessionSync(session: SessionDocument, options?: { readonly force?: boolean }): void {
    const root = session.root;
    const sessionId = root.sessionId;
    const now = Date.now();
    const face = sessionColumns(root);
    const pendingAsks = collectPendingAsks(root, now);

    if (options?.force === true) {
      session.pruneUnreachableNodes();
      const rows = session.toNodeRows();
      const revision = Math.max(session.revision, 1);
      this.db.writeTransaction(["sessions", "session_nodes", "pending_asks"], (tx) => {
        tx.insert(sessionsTable)
          .values({
            sessionId,
            kernelId: this.kernelId,
            projectId: root.projectId,
            ...face,
            revision,
            createdAtMs: now,
            lastActiveAtMs: now,
          })
          .onConflictDoUpdate({
            target: sessionsTable.sessionId,
            set: {
              kernelId: this.kernelId,
              projectId: root.projectId,
              ...face,
              revision,
              lastActiveAtMs: now,
            },
          })
          .run();
        this.db.commitSessionNodesInTx(
          tx,
          sessionId,
          {
            rootId: root.uuid,
            revision,
            upserts: rows,
            deletes: [],
            replaceAll: true,
          },
          this.kernelId,
        );
        tx.delete(pendingAsksTable).where(eq(pendingAsksTable.sessionId, sessionId)).run();
        for (const ask of pendingAsks) {
          tx.insert(pendingAsksTable).values(ask).run();
        }
      });
      session.markAllNodesCommitted();
      return;
    }

    const delta = session.peekNodeDelta();
    const revision = delta.revision;
    const hasNodeDelta = delta.upserts.length > 0 || delta.deletes.length > 0;
    this.db.writeTransaction(
      hasNodeDelta ? ["sessions", "session_nodes", "pending_asks"] : ["sessions", "pending_asks"],
      (tx) => {
        tx.insert(sessionsTable)
          .values({
            sessionId,
            kernelId: this.kernelId,
            projectId: root.projectId,
            ...face,
            revision,
            createdAtMs: now,
            lastActiveAtMs: now,
          })
          .onConflictDoUpdate({
            target: sessionsTable.sessionId,
            set: {
              kernelId: this.kernelId,
              projectId: root.projectId,
              ...face,
              revision,
              lastActiveAtMs: now,
            },
          })
          .run();
        if (hasNodeDelta) {
          this.db.commitSessionNodesInTx(tx, sessionId, delta, this.kernelId);
        }
        tx.delete(pendingAsksTable).where(eq(pendingAsksTable.sessionId, sessionId)).run();
        for (const ask of pendingAsks) {
          tx.insert(pendingAsksTable).values(ask).run();
        }
      },
    );
    if (hasNodeDelta) {
      session.commitNodeDelta(delta);
    }
  }

  recordSessionBlob(sessionId: string, blobId: string, _byteSize?: number): void {
    this.db.writeTransaction(["session_blobs"], (tx) => {
      this.db.insertSessionBlobInTx(tx, {
        sessionId,
        kernelId: this.kernelId,
        blobId,
        createdAtMs: Date.now(),
      });
    });
  }

  hasStoredSession(sessionId: string): boolean {
    if (this.runtime.replica(sessionId) != null) return true;
    return (
      this.db.sqlite
        .prepare("SELECT 1 FROM session_nodes WHERE kernel_id = ? AND session_id = ? LIMIT 1")
        .get(this.kernelId, sessionId) !== undefined
    );
  }

  sessionStoredBytes(sessionId: string): number {
    const row = this.db.sqlite
      .prepare(
        "SELECT COALESCE(SUM(LENGTH(row_json)), 0) AS bytes FROM session_nodes WHERE kernel_id = ? AND session_id = ?",
      )
      .get(this.kernelId, sessionId) as { readonly bytes: number } | undefined;
    return row?.bytes ?? 0;
  }

  async mintSessionDocument(sessionId: string, path: string): Promise<SessionDocument> {
    const live = this.runtime.replica(sessionId);
    if (live != null) {
      this.#bindSessionFlush(sessionId, live);
      return live;
    }
    const existingOwner = this.db.sqlite
      .prepare("SELECT kernel_id FROM sessions WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { readonly kernel_id: string } | undefined;
    if (existingOwner !== undefined && existingOwner.kernel_id !== this.kernelId) {
      throw new Error(`mintSessionDocument: session ${sessionId} belongs to another kernel`);
    }
    if (this.hasStoredSession(sessionId)) {
      const loaded = this.db.loadSessionNodes(sessionId);
      if (loaded !== undefined) {
        const restored = SessionDocument.fromNodeRows(loaded.rows, {
          rootId: loaded.rootId,
          sessionId,
          revision: loaded.revision,
          meta: this.db.loadSessionRuntimeMeta(sessionId),
        });
        this.#bindSessionFlush(sessionId, restored);
        return restored;
      }
    }
    const boot = SessionDocument.create(sessionId, path);
    this.#flushSessionSync(boot, { force: true });
    this.#bindSessionFlush(sessionId, boot);
    return boot;
  }

  async loadProjectDoc(
    path: string,
  ): Promise<{ readonly doc: DocumentContainer<any, any>; readonly existing: boolean }> {
    const scopeId = projectScopeId(path);
    const held = this.#projectDocs.get(path);
    if (held !== undefined) {
      this.#bindScopeFlush(scopeId, held);
      return { doc: held, existing: true };
    }
    const loaded = this.db.loadScopeNodes(scopeId, this.kernelId);
    if (loaded !== undefined) {
      const restored = ProjectDocument.fromNodeRows(loaded.rows, {
        rootId: loaded.rootId,
        revision: loaded.revision,
      });
      this.#projectDocs.set(path, restored);
      this.#bindScopeFlush(scopeId, restored);
      return { doc: restored, existing: true };
    }
    const boot = ProjectDocument.create(path);
    this.#projectDocs.set(path, boot);
    this.#flushScopeSync(scopeId, boot, { force: true });
    this.#bindScopeFlush(scopeId, boot);
    return { doc: boot, existing: false };
  }

  /**
   * Hydrate a session replica and pin it. Does not start an interpreter.
   * Undefined only when no such session exists; overload or corruption throws.
   */
  async acquireSession(sessionId: string): Promise<SessionDocument | undefined> {
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

  async #acquireSessionNow(sessionId: string): Promise<SessionDocument | undefined> {
    const live = this.runtime.replica(sessionId);
    if (live != null) return live;
    if (!this.hasStoredSession(sessionId)) return undefined;
    const loaded = this.db.loadSessionNodes(sessionId);
    if (loaded === undefined) return undefined;
    const interned = this.runtime.replica(sessionId);
    if (interned != null) return interned;
    const restored = SessionDocument.fromNodeRows(loaded.rows, {
      rootId: loaded.rootId,
      sessionId,
      revision: loaded.revision,
      meta: this.db.loadSessionRuntimeMeta(sessionId),
    });
    this.internSession(sessionId, restored);
    return restored;
  }

  registerProject(project: ProjectDaemon): void {
    if (project.globalHost) return;
    this.#projects.set(project.path, project);
    this.doc.root.registerProject(project.path);
  }

  /** Title tracks `SessionRoot.title`; recency is turn/steer. Liveness is not recency. */
  #watchSessionGlance(sessionId: string, session: SessionDocument): void {
    if (this.#glanceWatch.has(sessionId)) return;
    const stopLens = observeSessionSummary(session, (snap) => {
      this.#upsertSessionGlance(sessionId, snap);
      this.#rememberConversationFromSnap(sessionId, snap);
    });
    const stopHead = reaction(
      () => session.root.head?.uuid ?? "",
      (uuid) => {
        if (uuid === "") return;
        this.#touchSessionGlance(sessionId);
      },
    );
    const stopSteer = reaction(
      () => session.root.steerQueue.length,
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
  #watchSessionOccupancy(sessionId: string, session?: SessionDocument): void {
    if (this.#occupancyWatch.has(sessionId)) return;
    const stop = reaction(
      () => {
        const occupied = sessionIsOccupied(this.doc.awareness, sessionId);
        const resident = (session ?? this.runtime.replica(sessionId))?.root.agent.spec.resident === true;
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
          if (this.#reservations.has(id)) {
            const root = this.sessionDoc(id)?.root;
            if (root != null && !isConversationSession(root)) {
              this.dropReservation(id);
              continue;
            }
          }
          this.#parkIfIneligible(id);
        }
      },
      { fireImmediately: true, equals: comparer.structural },
    );
  }

  #parkIfIneligible(sessionId: string): void {
    const daemon = this.liveSession(sessionId);
    if (daemon == null) return;
    const scope = daemon.root.agent.spec.recipeScope;
    if (scope === "global" || scope === "project") return;
    void daemon.park().catch((error: unknown) => fail("grant park", error));
  }

  #upsertSessionGlance(sessionId: string, snap: SessionSummary): void {
    this.doc.root.projectSessionGlance(sessionId, snap, Date.now());
  }

  #touchSessionGlance(sessionId: string): void {
    const glance = this.doc.root.sessions[sessionId];
    if (glance == null) return;
    glance.lastMessageAt = Date.now();
  }

  /** Conversation catalog is empty-scope only. Stamp/re-intern retracts a named worker. */
  #rememberConversation(sessionId: string, session: SessionDocument): void {
    this.#rememberConversationFromSnap(sessionId, sessionSummary(session.root));
  }

  #rememberConversationFromSnap(sessionId: string, snap: SessionSummary): void {
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

  setDirectoryPicker(picker: DirectoryPicker): void {
    this.#pickDirectory = picker;
  }

  warmDirectoryPicker(): void {
    if (this.#closed || this.#pickDirectory !== pickNativeDirectory || process.env["VITEST"]) return;
    warmNativeDirectoryPicker();
  }

  hasProject(workspacePath: string): boolean {
    if (this.contour === "server" && !existsSync(workspacePath)) {
      return Object.hasOwn(this.doc.root.projects, workspacePath);
    }
    try {
      const resolved = realpathSync(workspacePath);
      return Object.hasOwn(this.doc.root.projects, resolved);
    } catch {
      return false;
    }
  }

  project(path: string): ProjectDaemon {
    if (this.#globalHost != null) {
      if (path === this.#globalHost.path) return this.#globalHost;
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
    const root = (this.sessionDoc(id) ?? (await this.acquireSession(id)))?.root;
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
    const session = this.sessionDoc(sessionId) ?? (await this.acquireSession(sessionId));
    if (session == null) throw new Error(`worker session ${sessionId} missing`);
    session.root.enqueueAgentRequest(requestId, callerSessionId, asUserPrompt(prompt));
    if (this.liveSession(sessionId) == null) {
      if (session.root.agent.spec.recipeScope === "global") await this.globalSession(sessionId);
      else await this.project(session.root.path).session(sessionId);
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
    if (this.#disposingPromise !== null) {
      return this.#disposingPromise;
    }
    this.#disposingPromise = (async () => {
      this.#closed = true;
      let expired = false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, SHUTDOWN_DEADLINE_MS);
        timer.unref();
      });
      const stopConnector = this.#connector?.stop().catch(() => undefined) ?? Promise.resolve();
      const disposeSessions = Promise.allSettled(
        [...this.#daemons.values()].map((daemon) => daemon[Symbol.asyncDispose]()),
      );
      const projects = [this.#globalHost, ...this.#projects.values()].filter(
        (project): project is ProjectDaemon => project != null,
      );
      const disposeProjects = Promise.allSettled(projects.map((project) => project[Symbol.asyncDispose]()));
      await Promise.race([Promise.all([stopConnector, disposeSessions, disposeProjects]), deadline]);
      while (this.#drains.size > 0 && !expired) {
        await Promise.race([Promise.allSettled(this.#drains), deadline]);
      }
      clearTimeout(timer);
      this[Symbol.dispose]();
    })();
    return this.#disposingPromise;
  }

  [Symbol.dispose](): void {
    if (this.#disposedSync) return;
    this.#disposedSync = true;
    this.#closed = true;
    if (this.contour === "local") {
      disposeNativeDirectoryPicker();
    }
    void this.#connector?.stop();
    this.#eligibilityWatch?.();
    this.#eligibilityWatch = null;
    this.#room?.close(1001, "kernel disposed");
    for (const room of this.#sessionRooms.values()) room.close(1001, "kernel disposed");
    this.#sessionRooms.clear();
    for (const stop of this.#glanceWatch.values()) stop();
    this.#glanceWatch.clear();
    for (const stop of this.#occupancyWatch.values()) stop();
    this.#occupancyWatch.clear();
    for (const daemon of this.#daemons.values()) daemon[Symbol.dispose]();
    this.#globalHost?.[Symbol.dispose]();
    this.#globalHost = undefined;
    for (const project of this.#projects.values()) project[Symbol.dispose]();
    this.#projects.clear();
    for (const stop of this.#flushStops.values()) stop();
    this.#flushStops.clear();
    this.#flushAllDirtyBeforeClose();
    this.doc?.awareness.destroy();
    this.doc?.destroy();
    for (const session of this.runtime.replicaValues()) {
      session.awareness.destroy();
      session.destroy();
    }
    for (const projectDoc of this.#projectDocs.values()) {
      projectDoc.awareness.destroy();
      projectDoc.destroy();
    }
    this.#projectDocs.clear();
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
    if (this.doc != null) disposeKernelConnections(this.doc.root);
    this.catalog[Symbol.dispose]();
    if (this.#ownsBlobs) this.blobs[Symbol.dispose]();
    if (this.#ownsVisuals) this.visuals[Symbol.dispose]();
    if (this.#ownsSecrets) this.secrets[Symbol.dispose]();
    if (this.#ownsLaneHub) this.laneHub.dispose();
    if (this.#ownsDb) this.db[Symbol.dispose]();
  }

  #hydrateKernel(): KernelDocument {
    const loaded = this.db.loadScopeNodes(KERNEL_SCOPE_ID, this.kernelId);
    if (loaded !== undefined) {
      const restored = KernelDocument.fromNodeRows(loaded.rows, {
        rootId: loaded.rootId,
        revision: loaded.revision,
      });
      if (restored.root.kernelId !== this.kernelId) {
        runInAction(() => {
          restored.root.kernelId = this.kernelId;
        });
      }
      this.#bindScopeFlush(KERNEL_SCOPE_ID, restored, () => this.#syncKernelStateToDb(restored));
      return restored;
    }
    const boot = KernelDocument.bootstrap();
    runInAction(() => {
      boot.root.kernelId = this.kernelId;
    });
    this.#flushScopeSync(KERNEL_SCOPE_ID, boot, { force: true });
    this.#syncKernelStateToDb(boot);
    this.#bindScopeFlush(KERNEL_SCOPE_ID, boot, () => this.#syncKernelStateToDb(boot));
    return boot;
  }
}

function collectPendingAsks(root: SessionRoot, now: number): PendingAskRowInsert[] {
  const pendingAsks: PendingAskRowInsert[] = [];
  for (const workItem of root.work) {
    if (!(workItem instanceof SessionTurn)) continue;
    for (const job of workItem.approvalLeaves) {
      if (!job.completed && !job.cancelled) {
        const isAck = job.ackState === "pending";
        const isAsk = job.policyResult === "ask" && job.humanApprove == null;
        if (isAck || isAsk) {
          pendingAsks.push({
            jobId: job.uuid,
            sessionId: root.sessionId,
            turnId: workItem.uuid,
            kind: isAck ? "ack" : "ask",
            object: glanceAskLine(job) || (job as { name?: string }).name || job.constructor.name,
            summary: job.policyMessage ?? glanceAskLine(job) ?? "",
            createdAtMs: now,
          });
        }
      }
    }
  }
  return pendingAsks;
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

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
