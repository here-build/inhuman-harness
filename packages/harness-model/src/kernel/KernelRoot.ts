/**
 * Machine-global kernel image.
 *
 * Catalog membership is `{KERNEL}/config.json` projected onto
 * {@link drivers} / {@link connections}. Plugin consent is the install-root
 * `package.json`. Secrets never ride this document.
 */
import { Model, model as modelDecorator, state } from "@inhuman.tools/model";
import type { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { DEFAULT_STATUSLINE } from "@inhuman.tools/statusline/constants";
import { runInAction } from "mobx";

import { writeAgentRelations, type AgentRelationSnap } from "./agent-relations.js";
import { BotSpec, writeAuthoredBots } from "./BotSpec.js";
import type { CommandSpec } from "./CommandSpec.js";
import { InstalledPlugin } from "./InstalledPlugin.js";
import { KernelAgentRelation } from "./KernelAgentRelation.js";
import { PluginSpec, writePluginTools, type PluginToolFace, type PluginToolSpec } from "./PluginSpec.js";
import {
  hydrateSessionOverview,
  SessionOverview,
  writeOverviewFace,
  type SessionOverviewFace,
} from "./SessionOverview.js";
import type { ActionSpec } from "../shared/ActionSpec.js";
import {
  DEFAULT_COMPACT_TRIGGERS,
  DEFAULT_COMPACT_KEEP_TURNS,
  DEFAULT_LENGTH_CONTINUATIONS,
} from "../shared/compact-settings.js";
import { applyKv } from "../shared/KeyValueStorage.js";
import type { PermissionMode } from "../shared/permission-mode.js";
import { ReActLoopIntentDetectedTrigger } from "../shared/ReActLoopIntentDetectedTrigger.js";
import { SCHEMA_VERSION, type KvProposal } from "../shared/residual.js";

export {
  DEFAULT_COMPACT_TRIGGERS,
  DEFAULT_COMPACT_KEEP_TURNS,
  DEFAULT_LENGTH_CONTINUATIONS,
  parseCompactTrigger,
  parseLoopLimit,
} from "../shared/compact-settings.js";
/**
 * Remaining-until-soft-compact fraction where the composer rail starts
 * mixing into warning. `config.json` `contextGlowRemaining`.
 */
export const DEFAULT_CONTEXT_GLOW_REMAINING = "75%";
export const DEFAULT_SPECULATIVE_POLICY_PROCESSING_TOOLS = 2;
/** Cover confirm-chord delay when the first ask mounts over a nonempty draft. `config.json` `approvalAskThrottleMs`; 0 = off. */
export const DEFAULT_APPROVAL_ASK_THROTTLE_MS = 2000;
/** Live/model shell tail window. `config.json` `shellTailBytes`; 0 = identity only (still spill). */
export const DEFAULT_SHELL_TAIL_BYTES = 10_240;
/** Ceiling so a huge config cannot pin the TUI. */
export const MAX_SHELL_TAIL_BYTES = 64 * 1024;

/** Missing / invalid → default. `0` is off. Above the ceiling clamps. */
export function parseShellTailBytes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SHELL_TAIL_BYTES;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SHELL_TAIL_BYTES;
  return Math.min(Math.floor(n), MAX_SHELL_TAIL_BYTES);
}
/**
 * Persist / More modifier. `config.json` `superKey`. Terminals often do not
 * forward Super, so the default is Ctrl on every platform — not inferred from
 * darwin.
 */
export const DEFAULT_SUPER_KEY = "ctrl" as const;
export type SuperKey = "ctrl" | "cmd";

export function parseSuperKey(value: unknown): SuperKey {
  return typeof value === "string" && value.trim().toLowerCase() === "cmd" ? "cmd" : DEFAULT_SUPER_KEY;
}

/**
 * `config.json` `compact` — a document token the daemon resolves, not an sdk
 * import. Default names the server-owned strategy file; owning the compact is
 * repointing this field, never editing a seeded copy (seeded copies rot).
 */
export const DEFAULT_COMPACT_STRATEGY = "@inhuman.tools/harness/compact.scm";
/**
 * `config.json` `autoModeClassifier` — ask residual processor. Same token shape as
 * `compact`. Dist default updates with the package; owning the processor is
 * repointing this field.
 */
export const DEFAULT_AUTO_MODE_JUDGE = "@inhuman.tools/policy-processor/auto-mode-ask.scm";
export { DEFAULT_STATUSLINE, STATUSLINE_NOTE_SEP } from "@inhuman.tools/statusline/constants";
export const DEFAULT_STATUSLINE_REFRESH = "round";

export type StatuslineRefresh =
  { readonly kind: "round" } | { readonly kind: "turn" } | { readonly kind: "interval"; readonly ms: number };

const STATUSLINE_REFRESH_MS_MIN = 5000;
const STATUSLINE_REFRESH_MS_MAX = 86_400_000;

/** `round` / `turn` / `ms` duration (`5m`, `2h`). Invalid → `round`. Duration floor 5s, cap 1d. */
export function parseStatuslineRefresh(value: unknown): StatuslineRefresh {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "" || raw === "round") return { kind: "round" };
  if (raw === "turn") return { kind: "turn" };
  const match = /^(\d+(?:\.\d+)?)(ms|[smhd])$/i.exec(raw);
  if (match == null) return { kind: "round" };
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return { kind: "round" };
  const unit = match[2]!.toLowerCase();
  const ms =
    unit === "ms"
      ? n
      : unit === "s"
        ? n * 1000
        : unit === "m"
          ? n * 60_000
          : unit === "h"
            ? n * 3_600_000
            : n * 86_400_000;
  return {
    kind: "interval",
    ms: Math.min(STATUSLINE_REFRESH_MS_MAX, Math.max(STATUSLINE_REFRESH_MS_MIN, Math.floor(ms))),
  };
}

@modelDecorator("harness:kernel:compact-triggers")
export class CompactTriggers extends Model<any, KernelRoot | null> {
  @state accessor hard: string = DEFAULT_COMPACT_TRIGGERS.hard;
  @state accessor soft: string = DEFAULT_COMPACT_TRIGGERS.soft;

  constructor(props?: { readonly hard?: string; readonly soft?: string } | symbol) {
    super(typeof props === "symbol" ? props : { ...props });
  }
}

@modelDecorator("harness:kernel:root")
export class KernelRoot extends Model<any, null> {
  @state.record accessor kvs: Record<string, string> = {};

  @state.action
  applyKvs(proposals: readonly KvProposal[]): void {
    applyKv(this.kvs, proposals);
  }

  @state.action
  registerProject(path: string): void {
    this.projects[path] = "";
  }

  @state.action
  stampModelUsage(connection: string, model: string, at: number = Date.now()): void {
    const conn = connection.trim();
    const mid = model.trim();
    if (conn === "" || mid === "") return;
    this.modelsUsage[`${conn}/${mid}`] = at;
    this.lastUsedConnectionModel[conn] = mid;
  }

  @state.action
  replaceAuthoredBots(specs: readonly BotSpec[]): void {
    writeAuthoredBots(this, specs);
  }

  @state.action
  replacePluginTools(pluginName: string, tools: readonly PluginToolFace[]): PluginSpec {
    return writePluginTools(this, pluginName, tools);
  }

  @state.action
  reconcileAgentRelations(callerSessionId: string, calls: readonly AgentRelationSnap[]): void {
    writeAgentRelations(this, callerSessionId, calls);
  }

  /** Create-or-update one glance row and its caller edges. `atMs` is only the create stamp. */
  @state.action
  projectSessionGlance(
    sessionId: string,
    snap: SessionOverviewFace & { readonly calls: readonly AgentRelationSnap[] },
    atMs: number,
  ): void {
    const existing = this.sessions[sessionId];
    if (existing == null) {
      this.sessions[sessionId] = new SessionOverview({
        title: snap.title,
        recipeScope: snap.recipeScope,
        specName: snap.specName,
        resident: snap.resident,
        keepAlive: snap.keepAlive,
        oneShot: snap.oneShot,
        model: snap.model,
        status: snap.status,
        midMotion: snap.midMotion,
        openTurn: snap.openTurn,
        openToolCount: snap.openToolCount,
        periodArmed: snap.periodArmed,
        openCallbackCount: snap.openCallbackCount,
        asking: snap.asking,
        unfinished: snap.unfinished,
        lastPrompt: snap.lastPrompt,
        askLine: snap.askLine,
        questionLine: snap.questionLine,
        lastMessageAt: atMs,
      });
    } else {
      writeOverviewFace(existing, snap);
    }
    writeAgentRelations(this, sessionId, snap.calls);
  }

  @state accessor schemaVersion: number = SCHEMA_VERSION;
  @state accessor compactStrategy: string = DEFAULT_COMPACT_STRATEGY;
  /** Ask residual processor. `config.json` `autoModeClassifier`. */
  @state accessor autoModeClassifier: string = DEFAULT_AUTO_MODE_JUDGE;
  /**
   * Last-choice permission mode for a new session. `config.json`
   * `defaultPermissionMode`. Not a kv key. Project `defaultPermissionMode` wins at mint
   * when set. Omitted / unknown → `manual`.
   */
  @state accessor defaultPermissionMode: PermissionMode = "manual";
  /**
   * The user layer of the authorization table: `config.json` `authorization`, as JSON text.
   * Empty: dist defaults. Daemon-stamped from the file; a client does not write it.
   */
  @state accessor authorizationJson: string = "";
  /**
   * Stored grants of project, bot and global scope (`~/.harness/grants.json`), JSON `GrantRow[]`.
   * Daemon-written; sessions read the rows that are visible to them.
   */
  @state accessor grantsJson: string = "";
  /**
   * Text-only continuation intern. `config.json` `reActLoopIntentDetectedTrigger`.
   * Omitted bag and leftover images hydrate on. Explicit `enabled: false`
   * turns it off. Live overlay.
   */
  @state.child accessor reActLoopIntentDetectedTrigger: ReActLoopIntentDetectedTrigger =
    new ReActLoopIntentDetectedTrigger();

  @state.child accessor compactTriggers: CompactTriggers = new CompactTriggers();
  /** `config.json` `compactKeepTurns`; host clamps to >= 1. 0 is invalid. */
  @state accessor compactKeepTurns: number = DEFAULT_COMPACT_KEEP_TURNS;
  /**
   * `config.json` `contextRetention`, validated and serialized by the host
   * (`parseContextRetention`). Empty = dist defaults. Resolved onto each
   * turn at mint (R1); the layering lives in `@inhuman.tools/turn/context`.
   */
  @state accessor contextRetentionJson: string = "";
  /** Remaining-until-soft-compact fraction where the composer rail starts warning chroma. */
  @state accessor contextGlowRemaining: string = DEFAULT_CONTEXT_GLOW_REMAINING;
  @state accessor speculativePolicyProcessingTools: number = DEFAULT_SPECULATIVE_POLICY_PROCESSING_TOOLS;
  /** First-ask cover throttle when the base draft is nonempty. Milliseconds. 0 = off. */
  @state accessor approvalAskThrottleMs: number = DEFAULT_APPROVAL_ASK_THROTTLE_MS;
  /** Last-N bytes of a live/sealed shell. `config.json` `shellTailBytes`. 0 = no peek. */
  @state accessor shellTailBytes: number = DEFAULT_SHELL_TAIL_BYTES;
  /** Model rounds in one turn. `config.json` `maxRounds`; 0 = unlimited. Recorded on the turn at start. */
  @state accessor maxRounds: number = 0;
  /** `agent/ask` spawns deep. `config.json` `maxDepth`; 0 = unlimited. Recorded on the call at start. */
  @state accessor maxDepth: number = 0;
  /** Model rounds in one turn of a bot thread (a `bot/ask` worker). `config.json` `maxBotRounds`; 0 = unlimited. */
  @state accessor maxBotRounds: number = 0;
  /** `bot/ask` hops deep, counted apart from `maxDepth`. `config.json` `maxBotDepth`; 0 = unlimited. */
  @state accessor maxBotDepth: number = 0;
  /** Rounds that may continue an answer cut off by the output limit. `config.json` `lengthContinuations`. */
  @state accessor lengthContinuations: number = DEFAULT_LENGTH_CONTINUATIONS;
  /** Total time a model round may keep retrying a transient error. `config.json` `retryMaxMs`; 0 = no deadline. */
  @state accessor retryMaxMs: number = 0;
  /** Failed foreground attempts before stopping. `config.json` `retryMaxAttempts`; 0 = no limit. */
  @state accessor retryMaxAttempts: number = 15;
  /** Failed background attempts before stopping. 0 = no limit. */
  @state accessor retryBackgroundMaxAttempts: number = 0;
  /** Persist-mod key. `config.json` `superKey`; `ctrl` (default) or `cmd`. */
  @state accessor superKey: SuperKey = DEFAULT_SUPER_KEY;
  /**
   * Compact tape omits floor-allow calls (`tapeFuse`). `config.json`
   * `hideFloorTools`. Default off: the call stays on the tape while it is
   * still open (question identity) and after it seals. On: known-safe rows
   * drop out of the compact column; a live omitted row does not eat the
   * occupancy pin.
   */
  @state accessor hideFloorTools: boolean = false;
  /** `git`, a shell command, or empty for cwd-only. */
  @state accessor statusline: string = DEFAULT_STATUSLINE;
  /** `round` / `turn` / duration. */
  @state accessor statuslineRefresh: string = DEFAULT_STATUSLINE_REFRESH;
  /**
   * Home-authored bots (`~/.inhuman/bots`). Disk is the store; this is the
   * visible face. Catalog lookup prefers these over compiled stdlib.
   */
  @state.childRecord accessor bots: Record<string, BotSpec> = {};
  @state.childRecord accessor plugins: Record<string, InstalledPlugin> = {};
  /**
   * Authored tool faces for TUI tape paint. Install consent is {@link plugins}.
   * Always-on host plugins write here even when they are not an install row.
   */
  @state.childRecord accessor pluginSpecs: Record<string, PluginSpec> = {};
  @state.childRecord accessor drivers: Record<string, DriverSpec> = {};
  @state.childRecord accessor connections: Record<string, ConnectionSpec> = {};
  @state.childRecord accessor commands: Record<string, CommandSpec> = {};
  @state.childRecord accessor actions: Record<string, ActionSpec> = {};
  /** Global-scope roster: recipe name → bot `sessionId`. */
  @state.record accessor botsRoster: Record<string, string> = {};
  /**
   * Operator recency: `"connection/model"` → last-used epoch ms.
   * First slash is the connection. One-shot `:model` does not write this.
   */
  @state.record accessor modelsUsage: Record<string, number> = {};
  /**
   * `"connection"` → the model last selected or run on that wire. Denormalized
   * from {@link stampModelUsage} so `/connect` reads one lookup instead of a
   * recency scan. Session mint snapshots `{...kernel, ...project}`; session
   * model writes project through to here.
   */
  @state.record accessor lastUsedConnectionModel: Record<string, string> = {};
  /** Known projects. Key = daemon-canonical path. Value is membership (`""`). */
  @state.record accessor projects: Record<string, string> = {};
  /**
   * Tab/pane → last conversation sessionId. Control-plane index, not the roster.
   * Kernel plane is a lens: clients write this via `term-continue/set|clear`, not CRDT.
   */
  @state.record accessor termContinue: Record<string, string> = {};
  /**
   * Glance roster (every interned session). Key = sessionId. Daemon-projected
   * from the session document; not a client CRDT write. Not `ProjectRoot.sessions`
   * (cwd conversation membership `""`).
   */
  @state.childRecord accessor sessions: Record<string, SessionOverview> = {};
  /**
   * Caller → worker edges. Key = `CallJob.uuid`. Daemon-projected from
   * interned caller tapes. Duplicates the Call's relation so listing TUI
   * can walk nested spawns without interning the worker.
   */
  @state.childRecord accessor agentCalls: Record<string, KernelAgentRelation> = {};

  /** First plugin that authored this wire name. Catalog collisions are a load fail. */
  pluginTool(wireName: string): PluginToolSpec | undefined {
    if (wireName === "") return undefined;
    for (const spec of Object.values(this.pluginSpecs)) {
      const tool = spec.tools[wireName];
      if (tool != null) return tool;
    }
    return undefined;
  }

  constructor(
    opts:
      | {
          schemaVersion?: number;
          kvs?: Record<string, string>;
          compactStrategy?: string;
          autoModeClassifier?: string;
          defaultPermissionMode?: PermissionMode;
          reActLoopIntentDetectedTrigger?: ReActLoopIntentDetectedTrigger;
          compactTriggers?: CompactTriggers;
          contextGlowRemaining?: string;
          speculativePolicyProcessingTools?: number;
          approvalAskThrottleMs?: number;
          shellTailBytes?: number;
          superKey?: SuperKey;
          hideFloorTools?: boolean;
          statusline?: string;
          statuslineRefresh?: string;
          bots?: Record<string, BotSpec>;
          plugins?: Record<string, InstalledPlugin>;
          pluginSpecs?: Record<string, PluginSpec>;
          drivers?: Record<string, DriverSpec>;
          connections?: Record<string, ConnectionSpec>;
          commands?: Record<string, CommandSpec>;
          actions?: Record<string, ActionSpec>;
          botsRoster?: Record<string, string>;
          modelsUsage?: Record<string, number>;
          lastUsedConnectionModel?: Record<string, string>;
          projects?: Record<string, string>;
          termContinue?: Record<string, string>;
          sessions?: Record<string, SessionOverview>;
          agentCalls?: Record<string, KernelAgentRelation>;
        }
      | symbol = {},
  ) {
    super(opts);
    hydrateKernelRoot(this);
  }
}

/** Leftover kernel images omit later `@syncing.child` fields. Constructor hydrate does not survive `connect` bind. */
export function hydrateKernelRoot(root: KernelRoot): void {
  runInAction(() => {
    if (root.reActLoopIntentDetectedTrigger == null)
      root.reActLoopIntentDetectedTrigger = new ReActLoopIntentDetectedTrigger();
    if (root.compactTriggers == null) root.compactTriggers = new CompactTriggers();
    for (const row of Object.values(root.sessions)) hydrateSessionOverview(row);
  });
}
