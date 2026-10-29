import { readFileSync } from "node:fs";

import { EvalTrace } from "@here.build/arrival/provenance";
import { docTag, fail, step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  AGENT_ASK,
  AGENT_SEND,
  AgentCallbackJob,
  AgentCallJob,
  BotCallJob,
  CallJob,
  AgentCallNotification,
  AgentMessageJob,
  AgentNotifyJob,
  ApprovableJob,
  cancelOutcomeText,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  delegatesPermissionMode,
  deskPermissionSnap,
  type DeskPermissionSnap,
  hostingTurnOf,
  type KernelPlexus,
  McpToolExpectation,
  MCPToolJob,
  type JobStopReport,
  liveBackgroundJobs,
  permissionDeskSessionId,
  ProgrammaticJob,
  projectWorkerPermissions,
  type SessionPlexus,
  SessionRoot,
  SessionTurn,
  SystemToolJob,
  parseGrantRows,
  tapeCompletion,
  ToolCallJob,
  WebExtractToolJob,
  WebSearchToolJob,
} from "@inhuman.tools/harness-model";
import {
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX,
  reActLoopIntentDetectedTriggerFor,
} from "@inhuman.tools/harness-model/shared";
import {
  type CapabilityConnection,
  type CompleteRequest,
  type CompleteResult,
  connectionSupports,
} from "@inhuman.tools/harness-provider-sdk";
import { interpretSchemeRepl, liveModelsOf } from "@inhuman.tools/harness-scheme";
import { type DriverSpec, Job, walkWork, WorkExpectation } from "@inhuman.tools/plexus-expectations";
import { ConnectionMiss, type DriverConnectionClass, type PEWDriver } from "@inhuman.tools/plexus-expectations/driver";
import { dropConnection, Orchestrator } from "@inhuman.tools/plexus-expectations/executor";
import { type ToolCall } from "@inhuman.tools/tool-call-normalize";
import {
  closeTurn,
  type CloseTurnOptions,
  isCallPaused,
  joinReleased,
  schemeDeskReadonly,
  shouldSkipTurnCancel,
  type TurnEnding,
} from "@inhuman.tools/turn/agent-calls";
import { autorun, comparer, reaction, runInAction, when } from "mobx";
import invariant from "tiny-invariant";

import { admitPrivateMcpTool, type NoteLog } from "@/extensions";
import { license, noteDenied } from "@/policy-processor/license";
import { scopes } from "@/policy-processor/scope";
import { documentKey } from "@/protocol/document";
import {
  hydrateMcpAlwaysAllows,
  MCP_HTTP_DRIVER,
  mcpSessionPersistAllows,
  mcpSessionPersistDenies,
} from "@/providers/mcp";
import {
  borrowedEnsureKey,
  memoBorrowedEnsure,
  NOUS_GATEWAY_CONNECTION_ID,
  nousGatewaySourceOf,
  secretsConnectionId,
} from "@/providers/nous";
import { isPrivatePluginConnection, parsePrivateConnectionKey, persistJobIntent } from "@/runtime";
import {
  abortParkableWork,
  type CompactHost,
  dispatchedMcpSettled,
  failLeftoverApprovables,
  liveEvalWork,
  mcpJobOnWire,
  turnLoopStopped,
} from "@/session";
import { behaviorEntriesOf } from "@/tool-catalog";
import {
  agentCallFromWire,
  agentGuardedCall,
  distPolicySource,
  executeSystemTool,
  type GuardedCall,
  guardedCallOf,
  behaviorEntriesThatRun,
  guardHostTool,
  inboundTurnGuard,
  loadPolicySource,
  publishPolicyError,
  cancelUnstartedTool,
  stampLicenseDeny,
  stampUnentered,
} from "@/tool-runtime";

import {
  type AgentRuntimeHost,
  completeCallExceptionally,
  deliverAgentMessage,
  executeAgentCall,
  executeBotCall,
  loadOpenCall,
  notifyAgentCall,
  sealCall,
  settleAgentCallback,
} from "./agent-runtime.js";
import { startAmbientCompact } from "./ambient-compact.js";
import { isParkAbort, SessionBehavior } from "./behavior-host.js";
import { loadCompactProgram } from "./compact.js";
import { CompletionFlights } from "./completion-flight.js";
import { pluginHookTimeoutMs } from "./hook-deadline.js";
import { PROJECT_LAYER_POLL_MS, readProjectAuthorization } from "./project-authorization.js";
import {
  internContinueStreak,
  internJudgeWire,
  runTextOnlyContinueIntern,
} from "./re-act-loop-intent-detected-trigger.js";
import type { SessionDaemon } from "./SessionDaemon.js";
import { iterateTurn } from "./turn-iterator.js";
import { createTurnResolvers } from "./turn-resolvers.js";
import { resolveCompactStrategyPath } from "../../defaults/index.js";
import { internedComplete } from "../../drivers/interned-complete.js";
import { pickWebExtractConnection, pickWebSearchConnection } from "../../drivers/web-search/pick.js";
import { readConnectionSecrets, writeConnectionSecrets } from "../../secrets.js";
import { KernelToolCatalog, sessionCatalog } from "../../toolkit/tool-table.js";
import type { KernelDaemon } from "../kernel/KernelDaemon.js";

const INTENT_NOT_PERSISTED = "intent could not be persisted";
const OUTSIDE_WORKER_CEILING = "outside worker tool ceiling";

/** Not a property alias. An early `=== false` must not narrow the getter across `await license`. */
function licenseDecisionNow(job: ToolCallJob): boolean | null {
  return job.licenseDecision;
}

export class SessionOrchestrator extends Orchestrator implements Disposable {
  declare readonly kernel: KernelPlexus;
  declare readonly session: SessionPlexus;
  readonly #disposeConnections: () => void;
  readonly #disposeBoundWire: () => void;
  readonly #disposeLive: () => void;
  readonly #disposePromptQueue: () => void;
  readonly #disposeAutoAllow: () => void;
  readonly #disposeDesk: () => void;
  readonly #disposeCompletions: () => void;
  #closed = false;
  /** Judge pairs that cannot send json_schema. Sticky skip, not retry. */
  readonly #reActLoopIntentDetectedTriggerHaltKeys = new Set<string>();
  /** Cutoff round → prefix key of the ambient completion still running. */
  readonly #ambientInflight = new Map<CompletionJob, string>();
  readonly #flights = new CompletionFlights((req) => this.#driveCompletion(req));
  /**
   * Rounds already open at {@link activate}. Recovery does not replay them
   * (`unknown-no-replay`); honor adopts one only after `startedAtMs`.
   */
  #completionBaseline: Set<CompletionJob> | null = null;
  readonly #loggedError = new Map<string, string>();
  readonly #loggedDriver = new Map<string, string | null>();
  readonly #gatewayEnsure = new Map<string, Promise<PEWDriver>>();
  readonly #behavior: SessionBehavior;
  /** One-shot recipe calls whose tools an agent guard narrowed, until the worker is minted. */
  readonly #agentTools = new Map<AgentCallJob, readonly string[]>();

  get #behaviorNotes(): NoteLog {
    return this.sessionDaemon.kernel.behavior.notes;
  }

  constructor(readonly sessionDaemon: SessionDaemon) {
    super(sessionDaemon.kernel.plexus, sessionDaemon.plexus);
    this.#behavior = new SessionBehavior(
      sessionDaemon.kernel.behavior,
      this.session.root,
      sessionDaemon.project.path,
      sessionDaemon.kernel.catalog,
      {
        syncTools: (turn) => sessionDaemon.syncBehaviorTools(turn),
        hookTimeoutMs: () => pluginHookTimeoutMs(this.session.root.kvs, this.kernel.root.kvs),
      },
    );
    const scope = scopes.get(this.session.root);
    runInAction(() => {
      scope.cap = this.kernel.root.speculativePolicyProcessingTools;
      stampSessionPrograms(this.session.root, this.sessionDaemon.kernel.root, this.kernel.root);
    });
    scope.complete = (req) => this.complete(req);
    scope.judgeFallbackKvs = this.kernel.root.kvs;
    scope.judgeConfiguredModel = (connectionId: string) => this.#configuredModel(connectionId);
    scope.onPolicyError = (text) => publishPolicyError(this.session, text);
    scope.mcpPersistAllows = (job) =>
      job instanceof MCPToolJob &&
      mcpSessionPersistAllows(
        job.connectionKey,
        job.serverToolName,
        this.session.root.toolAllowlist,
        this.session.root.toolBlocklist,
      );
    scope.mcpPersistDenies = (job) =>
      job instanceof MCPToolJob &&
      mcpSessionPersistDenies(job.connectionKey, job.serverToolName, this.session.root.toolBlocklist);
    runInAction(() => {
      hydrateMcpAlwaysAllows(this.session.root.toolAllowlist, this.kernel.root.connections);
    });
    // The authorization table: the user layer from `config.json`, the project layer from
    // `<repo>/.inhuman/authorization.json` (tighten only). Both are re-stamped when their files change, so a
    // mid-session tightening applies to the next call.
    const projectPath = this.sessionDaemon.project.path;
    const syncAuthorization = () => {
      const session = this.session.root;
      const user = this.kernel.root.authorizationJson;
      if (session.authorizationUserJson !== user) session.authorizationUserJson = user;
      const project = readProjectAuthorization(projectPath);
      if (session.authorizationProjectJson !== project) session.authorizationProjectJson = project;
    };
    runInAction(syncAuthorization);
    const poll = setInterval(() => {
      if (this.activated && !this.#closed) runInAction(syncAuthorization);
    }, PROJECT_LAYER_POLL_MS);
    poll.unref();
    const stopAuthorization = reaction(
      () => (this.activated ? this.kernel.root.authorizationJson : null),
      () => {
        if (!this.activated) return;
        runInAction(syncAuthorization);
      },
    );
    // Stored grants of project, bot and global scope come from the kernel's `grants.json`.
    scope.persistentGrants = () => parseGrantRows(this.kernel.root.grantsJson);
    scope.botName = () => {
      const spec = this.session.root.agent.spec;
      return spec.name.trim() === "" ? undefined : spec.name;
    };
    const stopGrants = reaction(
      () => this.kernel.root.grantsJson,
      () => scope.reconcileGrants(),
    );
    scope.onRunStopped = (stop) => {
      publishPolicyError(this.session, `Run stopped: ${stop.reason}`);
    };
    scope.onRunNotice = (notice) => {
      publishPolicyError(this.session, notice.text);
    };
    this.#disposeAutoAllow = () => {
      clearInterval(poll);
      stopAuthorization();
      stopGrants();
    };
    this.#disposeDesk = reaction(
      () => (this.activated ? this.#deskPermissionSnap() : null),
      (snap) => {
        if (snap == null) return;
        const desk = this.#permissionDesk();
        if (desk == null) return;
        runInAction(() => projectWorkerPermissions(this.session.root, desk));
      },
      { equals: comparer.structural, fireImmediately: true },
    );
    this.#disposePromptQueue = reaction(
      () => {
        if (!this.activated || this.#closed) return "";
        const root = this.session.root;
        if (root.findRunningTurn() != null) return "";
        const first = root.promptQueue[0];
        if (first == null) return "";
        return `${first.uuid}:${(root.kvs.connection ?? "").trim()}`;
      },
      (key) => {
        if (key === "") return;
        void this.sessionDaemon.drainPromptQueue();
      },
    );
    this.registerExecutor(
      SystemToolJob,
      (job) => this.#guardTool(job),
      async (job, signal) => {
        if (await this.#bodyRefused(job, signal)) return;
        try {
          await executeSystemTool(job, signal, {
            shellTailBytes: this.kernel.root.shellTailBytes,
            stopJob: async (jobId): Promise<JobStopReport> => {
              const nodes = this.session.root.motionWork();
              const id = jobId.trim();
              if (id === "") return { ok: true, value: { jobs: await liveBackgroundJobs(nodes) } };
              for (const node of nodes) {
                if (!(node instanceof ProgrammaticJob || node instanceof CallJob || node instanceof SystemToolJob))
                  continue;
                if (!node.isTrackedBackground || node.toolCallId !== id) continue;
                if (node.completed) return { ok: true, value: { job_id: id, status: "completed" } };
                if (node.cancelled) return { ok: true, value: { job_id: id, status: "cancelled" } };
                this.#abortWork(node);
                return { ok: true, value: { job_id: id, status: "cancelled" } };
              }
              return { ok: true, value: { job_id: id, status: "absent" } };
            },
          });
        } finally {
          await this.#behavior.finishTool(job, signal);
          if (!job.completed && !job.cancelled) job.markComplete();
        }
      },
      { seal: false },
    );
    this.registerExecutor(
      MCPToolJob,
      (job) => this.#guardTool(job),
      async (job, signal) => {
        if (await this.#bodyRefused(job, signal)) return;
        try {
          await this.#runMcp(job, signal);
        } finally {
          await this.#behavior.finishTool(job, signal);
        }
      },
      { seal: false },
    );
    this.registerExecutor(
      WebSearchToolJob,
      (job) => this.#guardTool(job),
      (job, signal) => this.#runWeb(job, signal),
      { seal: false },
    );
    this.registerExecutor(
      WebExtractToolJob,
      (job) => this.#guardTool(job),
      (job, signal) => this.#runWeb(job, signal),
      { seal: false },
    );
    this.registerExecutor(
      BotCallJob,
      (job) => this.#guardTool(job),
      async (job, signal) => {
        try {
          await executeBotCall(job, this.#agentHost());
        } catch (error) {
          sealCall(job, "error", error instanceof Error ? error.message : String(error));
        } finally {
          await waitUntil(() => job.completed, signal);
          await this.#finishCall(job, signal);
        }
      },
      { seal: false },
    );
    this.registerExecutor(
      AgentCallJob,
      (job) => this.#guardTool(job),
      async (job, signal) => {
        try {
          await executeAgentCall(job, this.#agentHost(), this.#agentTools.get(job));
        } catch (error) {
          sealCall(job, "error", error instanceof Error ? error.message : String(error));
        } finally {
          await waitUntil(() => job.completed, signal);
          await this.#finishCall(job, signal);
        }
      },
      { seal: false },
    );
    this.registerExecutor(
      AgentCallbackJob,
      () => true,
      async (job, signal) => {
        if (await this.#bodyRefused(job, signal)) return;
        await settleAgentCallback(job, this.#agentHost(), (node) => this.#abortWork(node));
      },
    );
    this.registerExecutor(
      AgentNotifyJob,
      () => true,
      async (job, signal) => {
        if (await this.#bodyRefused(job, signal)) return;
        notifyAgentCall(job, this.#agentHost());
      },
    );
    this.registerExecutor(
      AgentMessageJob,
      (job) => this.#license(job),
      async (job, signal) => {
        if (await this.#bodyRefused(job, signal)) return;
        await deliverAgentMessage(job, this.#agentHost(), signal);
      },
    );
    this.registerExecutor(
      ContextNeedToolJob,
      (job) => this.#license(job),
      async (job) => {
        job.outcomeSnap ??= { ok: true };
      },
    );
    this.registerExecutor(
      ProgrammaticJob,
      // Bag is not remainder. Inner System/MCP/agent leaves still `#license`.
      () => true,
      async (job, signal) => {
        if (!(await this.#waitEvalAdmission(signal))) return;
        const catalog = sessionCatalog(this.session.root) ?? new KernelToolCatalog();
        await interpretSchemeRepl(job, {
          catalog,
          root: this.session.root.path.trim() === "" ? process.cwd() : this.session.root.path,
          signal,
          sessionId: this.session.root.sessionId,
          observe: (run) => {
            const evalTrace = new EvalTrace();
            evalTrace.withAutoBindings();
            return run(evalTrace);
          },
          readonly: schemeDeskReadonly(
            this.session.root,
            enclosingCallOf(this.sessionDaemon.kernel, this.session.root, job),
          ),
          session: this.session.root,
          doors: this.sessionDaemon.doors,
          evalProgram: (hostingTurnOf(this.session.root, job) ?? this.session.root.head)?.evalSpec != null,
          connectionId: this.session.root.kvs.connection?.trim() || undefined,
          completionModel: this.session.root.kvs.model?.trim() || undefined,
          complete: async (req) => {
            try {
              return await this.complete(req);
            } catch (error) {
              if (error instanceof ConnectionMiss) throw new Error(error.message);
              throw error;
            }
          },
          connectionModels: (name) => {
            const spec = this.sessionDaemon.kernel.plexus.root.connections[name];
            invariant(spec != null, `unknown connection ${name}`);
            return liveModelsOf(spec);
          },
          admit: (call: ToolCall) =>
            this.sessionDaemon.project.toolCalls.admit(call, catalog, {
              session: this.session.root,
              loadAgentCall: (uuid) => loadOpenCall(this.sessionDaemon.kernel, this.session.root, uuid),
            }),
          abort: (leaf: ApprovableJob, reason?: unknown) => this.#abortLeaf(leaf, reason),
          notify: (note: AgentCallNotification) => {
            const call = enclosingCallOf(this.sessionDaemon.kernel, this.session.root, job);
            if (call != null) {
              call.notifications.push(note);
              return;
            }
            job.notifications.push(note);
          },
        });
      },
      { seal: false },
    );
    this.registerExecutor(
      SessionTurn,
      (turn) => inboundTurnGuard(turn),
      async (turn, signal) => {
        // Any other abort runs the close below; the iterator stops at once.
        if (!(await this.#waitEvalAdmission(signal)) && isParkAbort(signal)) return;
        if (turn.reducerExited) return;
        // Rewound away before it ran. Its close touches only itself: the steers and holds belong to the live head.
        if (!this.reachableJobs.includes(turn)) {
          closeTurn(turn, { kind: "rewound" }, this.#closeOptions());
          return;
        }
        const session = this.session.root;
        const toolCalls = this.sessionDaemon.project.toolCalls;
        let broke = "";
        try {
          const connectionId = session.kvs.connection?.trim() ?? "";
          const model = session.kvs.model?.trim() ?? "";
          trace("harness:turn", `open ${turn.uuid} connection=${connectionId || "(none)"} model=${model || "(none)"}`);
          await iterateTurn(
            turn,
            {
              session,
              resolvers: createTurnResolvers({
                complete: (req) => this.complete(req),
                join: (job, abort) => waitCompleted(job, abort, this.sessionDaemon.kernel.catalog),
                compactHost: () => this.#compactHost(turn, session, connectionId, model),
              }),
              notes: this.#behaviorNotes,
              compactKeepTurns: this.kernel.root.compactKeepTurns,
              hardCompactTrigger: this.kernel.root.compactTriggers.hard,
              loopLimits: () => {
                const root = this.kernel.root;
                // A thread reached through bot/ask has its own round cap.
                const bot = session.agent.spec.botDepth > 0;
                return {
                  maxRounds: bot ? root.maxBotRounds : root.maxRounds,
                  lengthContinuations: root.lengthContinuations,
                };
              },
              remoteMcp: (key) => this.kernel.root.connections[key]?.driver?.name === MCP_HTTP_DRIVER,
              admit: (call) => {
                const catalog = sessionCatalog(session) ?? toolCalls.kernel.catalog;
                const ctx = {
                  session,
                  originTurn: turn,
                  parent: turn,
                  loadAgentCall: (uuid: string) => loadOpenCall(this.sessionDaemon.kernel, session, uuid),
                };
                return call.function.name === AGENT_ASK || call.function.name === AGENT_SEND
                  ? agentCallFromWire(call, catalog, ctx)
                  : toolCalls.admit(call, catalog, ctx);
              },
              waitInbound: (abort) => this.#inboundResumed(turn, abort, () => turnLoopStopped(turn, abort)),
              openRound: async (resumed) => {
                const behavior = await this.#behavior.enterTurn(turn, resumed);
                return (
                  behavior != null && !turnLoopStopped(turn, signal) && (await this.#behavior.openRound(turn, behavior))
                );
              },
              closeRound: (settle) => this.#behavior.closeRound(turn, settle),
              classifyIntent: (pew, abort) => this.#reActLoopIntentDetectedTrigger(turn, pew, abort),
              startAmbientCompact: (options) => {
                void startAmbientCompact({
                  ...options,
                  complete: (req) => this.complete(req),
                  inflight: this.#ambientInflight,
                });
              },
            },
            signal,
          );
        } catch (error) {
          broke = error instanceof Error ? error.message : String(error);
          fail("turn", error);
        } finally {
          trace("harness:turn", `close ${turn.uuid} cancel=${turn.cancelRequested} park=${signal.reason === "park"}`);
          if (signal.reason === "park") this.#behavior.dropTurn(turn);
          else {
            // The post hooks are bounded, but a throw must still reach the close below.
            try {
              await this.#behavior.leaveTurn(turn, broke);
            } catch (error) {
              fail("turn boundary", error);
            }
            const ending: TurnEnding = turn.cancelRequested
              ? { kind: "cancel" }
              : broke === ""
                ? { kind: "finish" }
                : { kind: "broke", detail: broke };
            closeTurn(turn, ending, this.#closeOptions());
            this.#releaseUnansweredCall(turn);
            // Self-service lane: the turn that was head takes the next queued message itself.
            // The prompt-queue reaction stays as the fallback (a restart re-arms it).
            void this.sessionDaemon.drainPromptQueue();
          }
        }
      },
      { seal: false },
    );
    this.#disposeLive = autorun(() => {
      if (!this.activated || this.#closed) return;
      const reachable = this.reachableJobs;
      for (const job of this.inFlightJobs()) {
        if (!(job instanceof SessionTurn) || job.reducerExited || reachable.includes(job)) continue;
        failLeftoverApprovables(job, (leaf) => this.#abortLeaf(leaf), this.sessionDaemon.kernel.catalog);
      }
    });
    // Honor refuses an unstamped completion (`shouldHonor`). An executor would
    // stamp `orchestrationResult` or `completed` on every historical round.
    // Snapshot at activate is the recovery set; only a round that appears after
    // that is a new attempt, including an isolated `.prompt`.
    const stopBaseline = reaction(
      () => this.activated,
      (activated) => {
        if (!activated || this.#completionBaseline !== null) return;
        this.#completionBaseline = new Set(this.#openUnstartedCompletions());
      },
    );
    const stopDrive = reaction(
      () => this.#openUnstartedCompletions(),
      (jobs) => {
        const baseline = this.#completionBaseline;
        if (baseline === null) return;
        for (const job of jobs) {
          if (baseline.has(job)) continue;
          baseline.add(job);
          const pew = job.expectation;
          void this.complete(completionRequest(pew)).catch((error: unknown) => {
            if (pew.isDone || this.#flights.aborted(pew)) return;
            pew.fail("crash", error instanceof Error ? error.message : String(error), "null");
          });
        }
      },
      { equals: comparer.shallow },
    );
    this.#disposeCompletions = () => {
      stopBaseline();
      stopDrive();
    };
    this.#disposeConnections = autorun(() => {
      if (!this.activated || this.#closed) return;
      for (const name of Object.keys(this.drivers)) {
        const spec = this.drivers[name];
        if (spec === undefined) continue;
        if (!this.#loggedDriver.has(name)) {
          this.#loggedDriver.set(name, "");
          step(`driver ${name}`);
        }
        if (spec.readyState === "ready" && this.#loggedDriver.get(name) !== "ready") {
          this.#loggedDriver.set(name, "ready");
          step(`driver ${name} ready`);
        }
        if (spec.readyState === "failed") {
          const detail = spec.error === "" ? "failed" : spec.error;
          if (this.#loggedError.get(`driver:${name}`) !== detail) {
            this.#loggedError.set(`driver:${name}`, detail);
            fail(`driver ${name}`, detail);
          }
        }
      }
      for (const connectionId of Object.keys(this.connections)) {
        const spec = this.connections[connectionId];
        if (spec === undefined) continue;
        // Catalog is report. Honor ensures a wire when work names it.
        const live = spec.live;
        const models = Array.isArray(live.models) ? live.models.map(String) : [];
        const can = spec.driver?.abilityClaim ?? [];
        const liveSig = `${spec.readyState}|${can.join(",")}|${models.length}|${models.slice(0, 8).join(",")}`;
        if (this.#loggedError.get(`live:${connectionId}`) !== liveSig) {
          this.#loggedError.set(`live:${connectionId}`, liveSig);
          const authoring = spec.__doc__;
          const transport = this.kernel.doc;
          step(
            `kernel live: connection=${connectionId} readyState=${spec.readyState} can=${can.join(",") || "(none)"} models=${models.length} ${models.length === 0 ? "(none)" : models.slice(0, 8).join(",")} shadow=${docTag(authoring)} main=${docTag(transport)} sameDoc=${authoring === transport}`,
          );
        }
        if (spec.readyState !== "failed") continue;
        const detail = spec.error === "" ? "failed" : spec.error;
        if (this.#loggedError.get(connectionId) === detail) continue;
        this.#loggedError.set(connectionId, detail);
        fail(`connection ${connectionId}`, detail);
      }
    });
    this.#disposeBoundWire = reaction(
      () => (this.activated ? (this.session.root.kvs.connection ?? "").trim() : ""),
      (id) => {
        if (!this.activated || this.#closed || id === "" || this.connections[id] === undefined) return;
        void this.ensure(id);
      },
      { fireImmediately: true },
    );
  }

  async #runMcp(job: MCPToolJob, signal: AbortSignal): Promise<void> {
    if (this.#outsideWorkerCeiling(job)) {
      closeMcpFailure(job, OUTSIDE_WORKER_CEILING);
      return;
    }
    if (mcpSessionPersistDenies(job.connectionKey, job.serverToolName, this.session.root.toolBlocklist)) {
      closeMcpFailure(job, `unknown MCP tool "${job.serverToolName.trim() || job.name}"`);
      return;
    }
    if (isPrivatePluginConnection(job.connectionKey)) {
      const parsed = parsePrivateConnectionKey(job.connectionKey);
      const recipe = this.session.root.agent.spec.name;
      if (parsed == null || recipe === "") {
        closeMcpFailure(job, "private MCP tool not admitted");
        return;
      }
      const admission = admitPrivateMcpTool(
        this.sessionDaemon.kernel.catalog.pluginInstall,
        recipe,
        parsed.pluginName,
        parsed.serverName,
        job.serverToolName,
      );
      if (!admission.allowed) {
        closeMcpFailure(job, admission.reason ?? "private MCP tool not admitted");
        return;
      }
      if (job.serverToolName === "commit") {
        const requestId = job.argString("requestId");
        const open = loadOpenCall(this.sessionDaemon.kernel, this.session.root, requestId);
        if (open == null) {
          closeMcpFailure(job, "commit requestId is not an open writer Call");
          return;
        }
      }
    }
    if (!(await this.#inboundResumed(hostingTurnOf(this.session.root, job) ?? this.session.root.head, signal))) {
      if (isParkAbort(signal)) return;
      closeMcpFailure(job, signal.aborted ? cancelOutcomeText(signal.reason) : "contribution paused");
      return;
    }
    if (signal.aborted) {
      if (isParkAbort(signal)) {
        await waitDispatchedMcp(job);
        sealMcpIfSettled(job);
        return;
      }
      closeMcpFailure(job, cancelOutcomeText(signal.reason));
      return;
    }
    const key = job.connectionKey.trim();
    if (key === "") {
      const name = job.serverToolName.trim() || job.name.trim() || "mcp";
      closeMcpFailure(job, `${name}: missing MCP connection`);
      return;
    }
    if (job.dispatched && !job.completed) {
      if ((await this.#settleLeftoverPew(job.expectation, key, "MCP connection", signal)) === "settled") {
        sealMcpIfSettled(job);
        return;
      }
      if (isParkAbort(signal)) {
        await waitDispatchedMcp(job);
        sealMcpIfSettled(job);
        return;
      }
      job.outcomeSnap ??= { ok: false, text: cancelOutcomeText(signal.reason) };
      this.#terminatePew(job.expectation);
      job.markComplete();
      return;
    }
    const missing = this.#connectionFailure(key, "MCP connection");
    if (missing !== null) {
      closeMcpFailure(job, missing);
      return;
    }
    try {
      const instance = (await this.ensure(key)) as CapabilityConnection;
      if (!connectionSupports(instance, "mcp") || instance.callTool == null) {
        closeMcpFailure(job, `${key}: missing MCP connection`);
        return;
      }
      const args = job.args;
      if (args === null) {
        closeMcpFailure(job, "mcp: arguments");
        return;
      }
      const result = await instance.callTool({
        serverToolName: job.serverToolName,
        args,
        signal,
        onDispatch: () => {
          job.dispatched = true;
        },
      });
      job.outcomeSnap ??= result;
      await this.#behavior.finishTool(job, signal);
      if (!job.completed && !job.cancelled) job.markComplete();
    } catch (error) {
      if (isParkAbort(signal)) {
        await waitDispatchedMcp(job);
        sealMcpIfSettled(job);
        return;
      }
      if (error instanceof ConnectionMiss) {
        closeMcpFailure(job, error.code === "noconnect" ? `${key}: missing MCP connection` : error.message);
        return;
      }
      closeMcpFailure(
        job,
        signal.aborted ? cancelOutcomeText(signal.reason) : error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * A paused inbound call holds its turn's work. True when the call is not
   * paused or resumed while waiting; false when it ended, stopped, or aborted.
   */
  async #inboundResumed(turn: SessionTurn | null, signal: AbortSignal, stopped = () => false): Promise<boolean> {
    const inboundId = turn?.agentRequestId.trim() ?? "";
    if (inboundId === "") return true;
    const catalog = this.sessionDaemon.kernel.catalog;
    const inbound = loadOpenCall(this.sessionDaemon.kernel, this.session.root, inboundId);
    if (inbound == null || !isCallPaused(inbound, catalog)) return true;
    await waitUntil(() => !isCallPaused(inbound, catalog) || inbound.completed || stopped(), signal);
    return !signal.aborted && !inbound.completed && !isCallPaused(inbound, catalog);
  }

  /**
   * Covering receipt before BODY. Failed write is not dispatch. Recheck
   * cancel after the receipt — local mutation is not a receipt.
   */
  async #gateIntent(
    job: Job,
    signal: AbortSignal,
  ): Promise<{ readonly dispatch: true } | { readonly dispatch: false; readonly persistFailed: boolean }> {
    const documents = this.sessionDaemon.kernel.runtime.documents;
    if (documents != null) {
      const gate = await persistJobIntent(documents, documentKey("sessions", this.session.root.sessionId), job);
      if (!gate.ok) return { dispatch: false, persistFailed: true };
    }
    if (
      job.cancelled ||
      job.completed ||
      signal.aborted ||
      hostingTurnOf(this.session.root, job)?.cancelRequested === true
    ) {
      return { dispatch: false, persistFailed: false };
    }
    return { dispatch: true };
  }

  /**
   * A BODY the gate refused still settles and runs its finish step, so the
   * turn's join returns. A park leaves the job open for the next wrap.
   */
  async #bodyRefused(job: ToolCallJob, signal: AbortSignal): Promise<boolean> {
    const intent = await this.#gateIntent(job, signal);
    if (intent.dispatch) return false;
    if (!job.completed && (intent.persistFailed || !isParkAbort(signal))) {
      const text = intent.persistFailed ? INTENT_NOT_PERSISTED : cancelOutcomeText(signal.reason);
      job.outcomeSnap ??= { ok: false, text };
      if (job instanceof MCPToolJob && !job.expectation.isDone) job.expectation.fail("crash", text, "null");
      job.markComplete();
    }
    await this.#behavior.finishTool(job, signal);
    return true;
  }

  /** The two web tools differ only in their argument, their connection pick, and the call. */
  async #runWeb(job: WebSearchToolJob | WebExtractToolJob, signal: AbortSignal): Promise<void> {
    if (await this.#bodyRefused(job, signal)) return;
    const web =
      job instanceof WebSearchToolJob
        ? {
            name: "web_search",
            ability: "web-search" as const,
            missing: job.query === "" ? "query is required — call web_search again with the text to search for" : "",
            pick: pickWebSearchConnection,
            call: (instance: CapabilityConnection) =>
              instance.webSearch?.({ query: job.query, limit: job.limit, signal }),
          }
        : {
            name: "web_extract",
            ability: "web-extract" as const,
            missing: job.url === "" ? "url is required — call web_extract again with the page url" : "",
            pick: pickWebExtractConnection,
            call: (instance: CapabilityConnection) =>
              instance.webExtract?.({ url: job.url, charLimit: job.charLimit, signal }),
          };
    try {
      if (this.#outsideWorkerCeiling(job)) {
        job.outcomeSnap ??= { ok: false, text: OUTSIDE_WORKER_CEILING };
        return;
      }
      if (signal.aborted) {
        job.outcomeSnap ??= { ok: false, text: cancelOutcomeText(signal.reason) };
        return;
      }
      if (web.missing !== "") {
        job.outcomeSnap ??= { ok: false, text: `${web.name}: ${web.missing}` };
        return;
      }
      const key = web.pick(this.kernel.root);
      if (key === null) {
        job.outcomeSnap ??= {
          ok: false,
          text: `${web.name}: no ${web.ability} connection — /connect a provider or leave the keyless ring on`,
        };
        return;
      }
      job.connectionKey = key;
      if (job.expectation.startedAtMs == null) job.expectation.connectionId = key;
      const leftoverPew = job.expectation;
      if (leftoverPew.startedAtMs != null && !leftoverPew.isDone) {
        if ((await this.#settleLeftoverPew(leftoverPew, key, `${web.ability} connection`, signal)) === "aborted") {
          job.outcomeSnap ??= { ok: false, text: cancelOutcomeText(signal.reason) };
          this.#terminatePew(leftoverPew);
        }
        return;
      }
      try {
        const instance = (await this.ensure(key)) as CapabilityConnection;
        const found = connectionSupports(instance, web.ability) ? await web.call(instance) : undefined;
        job.outcomeSnap ??= found ?? { ok: false, text: `${web.name}: intern failed` };
      } catch (error) {
        job.outcomeSnap ??= {
          ok: false,
          text: signal.aborted
            ? cancelOutcomeText(signal.reason)
            : error instanceof Error
              ? error.message
              : String(error),
        };
      }
    } finally {
      await this.#behavior.finishTool(job, signal);
      this.#sealWebJob(job);
    }
  }

  /** A named worker runs only the tools its catalog lists. */
  #outsideWorkerCeiling(job: ToolCallJob): boolean {
    const root = this.session.root;
    return root.agent.spec.name !== "" && sessionCatalog(root)?.catalogEntry(job.name) == null;
  }

  /** Why `key` cannot serve, or null while it may. */
  #connectionFailure(key: string, what: string): string | null {
    const spec = this.connections[key];
    if (spec === undefined) return `${key}: missing ${what}`;
    if (spec.readyState === "failed") return spec.error === "" ? `${key}: failed` : spec.error;
    return null;
  }

  /**
   * A PEW an earlier wrap started settles on its own; it fails here only when
   * its connection is gone. Aborted leaves the PEW to the caller.
   */
  async #settleLeftoverPew(
    pew: WorkExpectation,
    key: string,
    what: string,
    signal: AbortSignal,
  ): Promise<"settled" | "aborted"> {
    const settled = await waitUntil(() => pew.isDone || this.#connectionFailure(key, what) !== null, signal);
    if (settled === "aborted") return settled;
    const detail = this.#connectionFailure(key, what);
    if (detail !== null && !pew.isDone) pew.fail("crash", detail, "null");
    return settled;
  }

  #sealWebJob(job: WebSearchToolJob | WebExtractToolJob): void {
    if (job.completed || job.cancelled) return;
    if ((job.receiptJson != null && job.receiptJson !== "") || job.expectation.isDone) {
      job.markComplete();
    }
  }

  /**
   * Guard phase of a host tool. The session's plugin guards wrap the license:
   * a guard may refuse, answer without running the tool, or narrow the
   * arguments, which are written back before the license judges them.
   * Pre hooks run once the call is licensed.
   */
  async #guardTool(job: ToolCallJob): Promise<boolean> {
    // Origin-aware door. Scheme inner admits and RPC/statusline still enter
    // here as model until those callers pass their origin through this path.
    const result = await guardHostTool({
      job,
      origin: "model",
      agent: this.#behavior.agent,
      behaviorEntries: behaviorEntriesThatRun(behaviorEntriesOf(this.session.root), (wire) =>
        sessionCatalog(this.session.root)?.catalogEntry(wire),
      ),
      guardedCall: (leaf) => this.#guardedCall(leaf),
      license: (leaf) => this.#license(leaf),
      turnId: (hostingTurnOf(this.session.root, job) ?? this.session.root.head)?.uuid ?? "",
      narrowAgent: (leaf, tools) => this.#narrowAgent(leaf, tools),
      onUnentered: stampUnentered,
      onProblem: (what, error) => this.#behavior.problem(what, error),
      onReport: (leaf, outcome) => this.#behavior.toolReport(leaf, outcome),
    });
    if (result.opened != null) this.#behavior.holdTool(job, result.opened);
    return result.allowed;
  }

  #guardedCall(job: ToolCallJob): GuardedCall | null {
    if (job instanceof BotCallJob) {
      // Named bot calls retain the existing agent guard point, without child tool grants.
      if (job.name !== AGENT_ASK && job.name !== AGENT_SEND) return guardedCallOf(job, this.session.root.path);
      const spec = job.botName || job.contributionBotName || job.argString("spec").trim();
      const catalog = sessionCatalog(this.session.root) ?? this.sessionDaemon.kernel.catalog;
      const recipe = catalog.recipe(spec);
      return recipe == null ? null : agentGuardedCall(job, spec, recipe.spec.tools, false);
    }
    if (!(job instanceof AgentCallJob)) return guardedCallOf(job, this.session.root.path);
    if (job.name !== AGENT_ASK && job.name !== AGENT_SEND) return null;
    const spec = job.argString("spec").trim();
    const fresh = job.workerSessionId === "";
    const catalog = sessionCatalog(this.session.root) ?? this.sessionDaemon.kernel.catalog;
    if (spec === "") {
      const tools = job.inheritCallerTools ? catalog.catalogWireNames() : job.tools;
      return agentGuardedCall(job, "", tools, fresh);
    }
    const recipe = catalog.recipe(spec);
    return recipe == null ? null : agentGuardedCall(job, spec, recipe.spec.tools, fresh);
  }

  /** An ad-hoc ask carries its tools on the job; a one-shot recipe worker takes them at mint. */
  #narrowAgent(job: AgentCallJob, tools: readonly string[]): void {
    if (job.argString("spec").trim() === "") {
      job.tools = [...tools];
      job.inheritCallerTools = false;
      return;
    }
    this.#agentTools.set(job, tools);
    // A call cancelled before its worker is minted never takes these.
    void when(() => job.completed || job.cancelled).then(() => this.#agentTools.delete(job));
  }

  async #finishCall(job: CallJob, signal: AbortSignal): Promise<void> {
    if (job instanceof AgentCallJob) this.#agentTools.delete(job);
    await this.#behavior.finishCall(job, signal);
  }

  async #license(job: ToolCallJob): Promise<boolean> {
    const started = Date.now();
    trace(
      "harness:license",
      `wait ${job.toolCallId || job.name} tool=${job.name} policy=${job.policyResult ?? "pending"}`,
    );
    if (licenseDecisionNow(job) === false) {
      stampLicenseDeny(job, this.session.root.permissionMode);
      await noteDenied(job, this.session.root);
      trace("harness:license", `deny ${job.toolCallId || job.name}`);
      return false;
    }
    const hostTurn = hostingTurnOf(this.session.root, job) ?? this.session.root.head;
    const ok = await license(job, hostTurn, this.session.root);
    trace(
      "harness:license",
      `${ok ? "allow" : "deny"} ${job.toolCallId || job.name} ms=${Date.now() - started} policy=${job.policyResult ?? ""} judge=${job.classifierResult ?? ""}`,
    );
    if (ok || job.cancelled || job.completed) return ok;
    const decision = licenseDecisionNow(job);
    if (decision === false) stampLicenseDeny(job, this.session.root.permissionMode);
    else if (!this.#closed) cancelUnstartedTool(job);
    return false;
  }

  #agentHost(): AgentRuntimeHost {
    return {
      kernel: this.sessionDaemon.kernel,
      project: this.sessionDaemon.project,
      caller: this.session.root,
      problem: (what, error) => this.#behavior.problem(what, error),
    };
  }

  #permissionDesk(): SessionRoot | null {
    if (!delegatesPermissionMode(this.session.root)) return null;
    const id = permissionDeskSessionId(this.session.root, this.kernel.root);
    if (id === "" || id === this.session.root.sessionId) return null;
    return this.sessionDaemon.kernel.sessionPlexus(id)?.root ?? null;
  }

  #deskPermissionSnap(): DeskPermissionSnap | null {
    const desk = this.#permissionDesk();
    return desk == null ? null : deskPermissionSnap(desk);
  }

  override ensure(connectionId: string): Promise<PEWDriver> {
    if (connectionId === NOUS_GATEWAY_CONNECTION_ID) return this.#ensureBorrowedGateway();
    return this.#loggedEnsure(connectionId, this.isEnsured(connectionId), super.ensure(connectionId));
  }

  /**
   * `web-nous` is one intern id whose person can move. Memo by intern+source;
   * {@link dropConnection} is the remint door so B is not A's lease.
   */
  #ensureBorrowedGateway(): Promise<PEWDriver> {
    const connectionId = NOUS_GATEWAY_CONNECTION_ID;
    const source = nousGatewaySourceOf(this.kernel.root, connectionId);
    const tracked = this.#gatewayEnsure.has(borrowedEnsureKey(connectionId, source));
    return this.#loggedEnsure(
      connectionId,
      tracked,
      memoBorrowedEnsure(
        this.#gatewayEnsure,
        connectionId,
        source,
        (id) => this.ensure(id),
        () => super.ensure(connectionId),
        () => dropConnection(this.kernel.root, connectionId),
      ),
    );
  }

  #loggedEnsure(connectionId: string, tracked: boolean, pending: Promise<PEWDriver>): Promise<PEWDriver> {
    if (tracked) return pending;
    step(`ensure ${connectionId}`);
    void pending.then(
      () => step(`ensure ${connectionId} ready`),
      (error) => fail(`ensure ${connectionId}`, error),
    );
    return pending;
  }

  protected override attachConnection(connectionId: string, instance: PEWDriver): void {
    const kernel = this.sessionDaemon.kernel;
    instance.bindSettingsWriter((patch) => {
      kernel.adjustConfig((config) => {
        if (!Object.hasOwn(config.connections, connectionId)) return;
        const row = config.connections[connectionId];
        row.settings = { ...row.settings, ...patch };
      });
    });
  }

  protected override connectionSecrets(connectionId: string) {
    const root = this.sessionDaemon.kernel.root;
    const ownerId = () => secretsConnectionId(this.kernel.root, connectionId);
    return {
      get: (field: string) => readConnectionSecrets(root, ownerId())[field],
      all: () => readConnectionSecrets(root, ownerId()),
      replace: (secrets: Readonly<Record<string, string>>) => {
        writeConnectionSecrets(root, ownerId(), { ...secrets });
      },
    };
  }

  /**
   * Remainder / compact `.prompt` / turn port. Interns the row, then
   * `connection.complete` → `handle(round)`. `KernelDaemon` has no `complete()`.
   */
  complete(req: CompleteRequest): Promise<CompleteResult> {
    return this.#flights.complete(req);
  }

  /**
   * Open completions honor will not start. `startedAtMs` means the attempt
   * already began. Tape completions belong to the turn resolution strategy. Only isolated
   * completions use this driver, so there is one dispatch owner per node.
   */
  #openUnstartedCompletions(): CompletionJob[] {
    if (!this.activated || this.#closed) return [];
    const open: CompletionJob[] = [];
    for (const node of this.reachableJobs) {
      if (!(node instanceof CompletionJob)) continue;
      const pew = node.expectation;
      if (pew.isDone || pew.startedAtMs != null) continue;
      const parent = node.parent;
      if (parent instanceof SessionTurn && (parent.queue.includes(node) || parent.doneWork.includes(node))) continue;
      open.push(node);
    }
    return open;
  }

  #stopCompletions(reason?: unknown): void {
    this.#disposeCompletions();
    this.#flights.abortAll(reason);
  }

  async #driveCompletion(req: CompleteRequest): Promise<CompleteResult> {
    const owner = req.round.parent;
    if (owner instanceof CompletionJob) {
      if (owner.orchestrationResult == null) {
        runInAction(() => {
          owner.orchestrationResult = true;
        });
      }
      const intent = await this.#gateIntent(owner, req.signal ?? new AbortController().signal);
      if (!intent.dispatch) {
        if (intent.persistFailed && req.round.outcome == null) {
          req.round.fail("crash", INTENT_NOT_PERSISTED, "null");
        }
        throw new Error(intent.persistFailed ? INTENT_NOT_PERSISTED : "completion cancelled");
      }
    }
    // The retry budget is read once, here, and recorded on the round. A live setting change
    // does not reach a round that is already retrying.
    req.round.stampRetryLimits({
      maxMs: this.kernel.root.retryMaxMs,
      maxAttempts: this.kernel.root.retryMaxAttempts,
    });
    const started = Date.now();
    const id = req.round.uuid;
    trace(
      "harness:complete",
      `start ${id} connection=${req.connectionId} model=${req.model} isolated=${req.round.completionMode === "isolated"}`,
    );
    this.originCompletions.add(req.round);
    try {
      const result = await internedComplete(this, req);
      trace("harness:complete", `done ${id} ms=${Date.now() - started} chars=${result.text.length}`);
      return result;
    } catch (error) {
      trace(
        "harness:complete",
        `fail ${id} ms=${Date.now() - started} ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof ConnectionMiss) this.originCompletions.delete(req.round);
      throw error;
    }
  }

  /**
   * A guard or body threw. The job's joiners (the turn's `joinReleased`, a
   * program's leaf wait) read the receipt, so the model sees the error as
   * the tool result and the turn continues instead of waiting forever.
   */
  protected override stampCrash(job: Job, phase: "license" | "body", detail: string): void {
    const text = `${phase === "license" ? "license crashed" : "tool crashed"}: ${detail === "" ? "unknown error" : detail}`;
    trace("harness:crash", `${job.__type__} ${phase} ${detail}`);
    if (job instanceof ToolCallJob) stampUnentered(job, { ok: false, text });
    else if (job instanceof ProgrammaticJob) job.outcomeSnap ??= { ok: false, text };
  }

  protected override shouldHonor(node: WorkExpectation): boolean {
    if (!super.shouldHonor(node)) return false;
    if (node instanceof McpToolExpectation) return node.startedAtMs != null || node.dispatched;
    if (node instanceof CompletionExpectation) return node.startedAtMs != null;
    return true;
  }

  async loadDriverModule(driver: DriverSpec): Promise<DriverConnectionClass> {
    return this.sessionDaemon.kernel.runtime.loadDriver(driver);
  }

  #holdingDispatchedMcp = false;
  #holdingEval = false;

  get holdingEval(): boolean {
    return this.#holdingEval;
  }

  /** Honor still running after last-seat park: on-wire MCP or an unsealed eval bag. */
  get holding(): boolean {
    return this.#holdingDispatchedMcp || this.#holdingEval;
  }

  async #waitEvalAdmission(signal: AbortSignal): Promise<boolean> {
    const held = this.sessionDaemon.evalAdmissionHeld;
    return !held.get() || (await waitUntil(() => !held.get(), signal)) === "settled";
  }

  /**
   * Pause interpretation. Open Calls and agentCallbacks stay. Abort reason
   * `"park"` so Call / program / turn handlers do not seal.
   *
   * ONE SETTLEMENT. `tools/call` already on the wire is not aborted and not
   * started again — a second dispatch would hide whether the mutation landed.
   * Park waits for that settlement. Undispatched MCP is aborted without a
   * cancel receipt.
   *
   * Live eval bags are a wrap hold, not a mutation hold: last-seat drop must
   * not mint a second honor on the unsealed program. On-wire MCP does not
   * keep `interpreting` true.
   *
   * A held program keeps calling tools, and a tool is licensed and run by the
   * executors that a stop disposes. So the stop waits for the programs
   * instead of leaving them parked on a leaf nobody will run: until the last
   * live program settles this wrap keeps interpreting (and says so), then
   * parks as usual. The round a park interrupts is never ended: it is the
   * resumed turn that opens a fresh one.
   */
  park(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (liveEvalWork(this.session.root).size === 0) return this.#parkNow();
    this.#deferredPark ??= (async () => {
      this.#holdingEval = true;
      try {
        await when(() => this.#closed || liveEvalWork(this.session.root).size === 0);
      } finally {
        this.#holdingEval = false;
      }
      await this.#parkNow();
    })();
    return this.#deferredPark;
  }

  #deferredPark: Promise<void> | null = null;

  #parkNow(): Promise<void> {
    if (!this.#stop("park")) return Promise.resolve();
    const hold = this.#abortParkableWork();
    if (!hold.mcpPending && !hold.evalPending) {
      this.#abortParkableWork();
      this.#release();
      return Promise.resolve();
    }
    this.#holdingDispatchedMcp = hold.mcpPending;
    this.#holdingEval = hold.evalPending;
    return when(() => dispatchedMcpSettled(this.session.root) && liveEvalWork(this.session.root).size === 0).then(
      () => {
        this.#holdingDispatchedMcp = false;
        this.#holdingEval = false;
        this.#abortParkableWork();
        this.#release();
        return undefined;
      },
    );
  }

  /** Close the wrap to new work. Park and dispose share it; false once closed. */
  #stop(cause?: "park"): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    this.#disposeLive();
    this.#disposeConnections();
    this.#disposeBoundWire();
    this.#disposePromptQueue();
    this.#disposeAutoAllow();
    this.#disposeDesk();
    // A park pauses the round it interrupts; only a dispose ends it.
    this.#stopCompletions(cause);
    this.stopAdmission();
    scopes.get(this.session.root).close();
    return true;
  }

  /** Release what the wrap holds, once its last held work settled. */
  #release(): void {
    this.#behavior[Symbol.dispose]();
    super[Symbol.dispose]();
  }

  #abortParkableWork(): { readonly mcpPending: boolean; readonly evalPending: boolean } {
    return abortParkableWork(this.session.root, {
      inFlightJobs: () => this.inFlightJobs(),
      abortJob: (job, reason) => this.abortJob(job, reason),
      abortExpectation: (expectation, reason) => {
        this.actorOf(expectation)?.abort(reason);
      },
    });
  }

  [Symbol.dispose](): void {
    if (!this.#stop()) return;
    for (const job of this.inFlightJobs()) {
      if (job instanceof SessionTurn) {
        failLeftoverApprovables(job, (leaf) => this.#abortLeaf(leaf), this.sessionDaemon.kernel.catalog);
      }
    }
    this.#release();
  }

  #compactHost(turn: SessionTurn, session: SessionRoot, connectionId: string, model: string): CompactHost {
    return {
      turn,
      session,
      compactKeepTurns: this.kernel.root.compactKeepTurns,
      compactStrategy: this.kernel.root.compactStrategy,
      kernelFsRoot: this.sessionDaemon.kernel.root,
      connectionId,
      model,
      complete: (req) => this.complete(req),
      loadProgram: (spec, root) => loadCompactProgram(spec, root),
      log: (message) => step(message),
      fail: (label, error) => fail(label, error),
    };
  }

  cancelOwned(turn: SessionTurn): void {
    const catalog = this.sessionDaemon.kernel.catalog;
    turn.cancelRequested = true;
    for (const node of walkWork(turn)) {
      if (node instanceof CallJob && !node.completed) {
        if (shouldSkipTurnCancel(node, catalog)) continue;
        completeCallExceptionally(node, this.#agentHost(), "cancelled");
      }
    }
    failLeftoverApprovables(turn, (leaf) => this.#abortLeaf(leaf), catalog);
    for (const node of walkWork(turn)) {
      if (node instanceof ProgrammaticJob && !node.completed) {
        if (node.orchestrated) this.abortJob(node);
        else {
          node.outcomeSnap ??= { ok: false, text: "cancelled" };
          node.cancelled = true;
          node.markComplete();
        }
      }
      if (node instanceof WorkExpectation && !node.isDone) this.#terminatePew(node);
    }
    let inFlight = false;
    for (const job of this.inFlightJobs()) {
      if (job === turn) {
        inFlight = true;
        break;
      }
    }
    this.abortJob(turn);
    if (!inFlight) {
      // The executor is not inside this turn, so its finally will not clear `inLoop`.
      closeTurn(turn, { kind: "cancel" }, this.#closeOptions());
    }
  }

  /** What every turn close needs from this wrap: the abort of an in-flight body, the actor-aware end, the inbox. */
  #closeOptions(): CloseTurnOptions {
    return {
      catalog: this.sessionDaemon.kernel.catalog,
      abort: (job) => (job instanceof ApprovableJob ? this.#abortLeaf(job) : this.abortJob(job)),
      terminate: (expectation) => this.#terminatePew(expectation),
      releaseCall: (call) => {
        if (!call.completed) completeCallExceptionally(call, this.#agentHost(), "cancelled");
      },
      session: this.session.root,
    };
  }

  /**
   * Stream stall failed this turn's completion. A keepAlive worker can still
   * respond after any other close, and eval timeout cancels the call itself.
   * The turn is already closed, so force-stop does not abort this executor.
   */
  #releaseUnansweredCall(turn: SessionTurn): void {
    const requestId = turn.agentRequestId.trim();
    if (requestId === "") return;
    const call = loadOpenCall(this.sessionDaemon.kernel, this.session.root, requestId);
    if (call == null || call.completed) return;
    let detail = "";
    for (const node of walkWork(turn)) {
      const pew = node instanceof CompletionExpectation ? node : tapeCompletion(node);
      if (pew == null) continue;
      if (pew.outcome !== "failed") continue;
      const text = pew.endDetail?.trim() || pew.failReason?.trim() || "";
      if (!text.startsWith("stream stalled after ")) continue;
      detail = text;
      break;
    }
    if (detail === "") return;
    completeCallExceptionally(call, this.#agentHost(), "error", detail);
  }

  /**
   * In-flight BODY abort. `abortJob` does not stop a worker session — AgentCall
   * must complete exceptionally. MCP/web terminate PEW.
   */
  #abortLeaf(leaf: ApprovableJob, reason?: unknown): void {
    this.abortJob(leaf, reason);
    if (leaf instanceof CallJob) {
      if (!leaf.completed) {
        completeCallExceptionally(leaf, this.#agentHost(), "cancelled", cancelOutcomeText(reason));
      }
      return;
    }
    if (leaf instanceof MCPToolJob || leaf instanceof WebSearchToolJob || leaf instanceof WebExtractToolJob) {
      leaf.outcomeSnap ??= { ok: false, text: cancelOutcomeText(reason) };
      const pew = leaf.expectation;
      if (!pew.isDone) this.#terminatePew(pew);
    }
  }

  #abortWork(job: Job): void {
    if (job instanceof ApprovableJob) this.#abortLeaf(job);
    else this.abortJob(job);
  }

  #terminatePew(expectation: WorkExpectation): void {
    const actor = this.actorOf(expectation);
    if (actor !== undefined) actor.admitTermination();
    if (!expectation.isDone) expectation.fail("cancel", "terminate", "null");
  }

  #configuredModel(connectionId: string): string {
    const spec = this.kernel.root.connections[connectionId];
    if (spec == null) return "";
    const configured = typeof spec.configuration.model === "string" ? spec.configuration.model.trim() : "";
    if (configured !== "") return configured;
    const activeConnection = (this.session.root.kvs.connection || this.kernel.root.kvs.connection || "").trim();
    if (connectionId === activeConnection) {
      const activeModel = (this.session.root.kvs.model || this.kernel.root.kvs.model || "").trim();
      if (activeModel !== "") return activeModel;
    }
    const liveModels = spec.live?.models;
    if (Array.isArray(liveModels)) {
      const first = liveModels.find((id) => typeof id === "string" && id.trim() !== "");
      if (typeof first === "string") return first.trim();
    }
    return "";
  }

  async #reActLoopIntentDetectedTrigger(
    turn: SessionTurn,
    pew: CompletionExpectation,
    signal: AbortSignal,
  ): Promise<"continue" | "question" | "seal"> {
    if (internContinueStreak(turn) >= RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX) return "seal";
    if (
      !reActLoopIntentDetectedTriggerFor(this.kernel.root.reActLoopIntentDetectedTrigger, pew.connectionId, pew.model)
    )
      return "seal";
    const wire = internJudgeWire(this.session.root.kvs, this.kernel.root.kvs, (id) => this.#configuredModel(id));
    if (wire == null) return "seal";
    return runTextOnlyContinueIntern({
      speech: pew.responseText,
      wire,
      haltKeys: this.#reActLoopIntentDetectedTriggerHaltKeys,
      home: turn,
      complete: (req) => this.complete(req),
      signal,
    });
  }
}

function completionRequest(pew: CompletionExpectation): CompleteRequest {
  return {
    connectionId: pew.connectionId,
    model: pew.model,
    promptText: pew.userPrompt,
    messages: pew.messages,
    responseSchemaJson: pew.responseSchema == null ? undefined : JSON.stringify(pew.responseSchema),
    systemNote: pew.systemNote,
    round: pew,
  };
}

async function waitCompleted(
  job: Job,
  signal: AbortSignal,
  catalog: KernelToolCatalog,
): Promise<"settled" | "aborted"> {
  return waitUntil(() => joinReleased(job, catalog), signal);
}

async function waitUntil(pred: () => boolean, signal: AbortSignal): Promise<"settled" | "aborted"> {
  if (signal.aborted) return "aborted";
  if (pred()) return "settled";
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const joined = when(pred);
  try {
    return await Promise.race([
      joined.then(
        () => "settled" as const,
        () => "aborted" as const,
      ),
      aborted,
    ]);
  } finally {
    joined.cancel();
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function stampSessionPrograms(
  session: SessionRoot,
  kernelFsRoot: string,
  kernel: { readonly autoModeClassifier: string },
): void {
  session.policyProgram = loadPolicySource(kernelFsRoot) ?? distPolicySource();
  try {
    session.judgeAskProgram = readFileSync(resolveCompactStrategyPath(kernel.autoModeClassifier, kernelFsRoot), "utf8");
  } catch {
    session.judgeAskProgram = "";
  }
}

function closeMcpFailure(job: MCPToolJob, text: string): void {
  job.outcomeSnap ??= { ok: false, text };
  const pew = job.expectation;
  if (!pew.isDone) pew.fail("crash", text, "null");
  if (!job.completed && !job.cancelled) job.markComplete();
}

function waitDispatchedMcp(job: MCPToolJob): Promise<void> {
  if (!mcpJobOnWire(job)) return Promise.resolve();
  return when(() => !mcpJobOnWire(job) || job.completed || job.cancelled);
}

function sealMcpIfSettled(job: MCPToolJob): void {
  if (job.completed || job.cancelled) return;
  if (job.receiptJson == null || job.receiptJson === "") return;
  if (job.expectation.startedAtMs != null && !job.expectation.isDone) return;
  job.markComplete();
}

function enclosingCallOf(kernel: KernelDaemon, session: SessionRoot, job: ProgrammaticJob): CallJob | undefined {
  let unit: SessionTurn | null = session.head;
  let holding: SessionTurn | undefined;
  // A tail cycle is a corrupt document, not an endless walk.
  const seen = new Set<SessionTurn>();
  while (unit instanceof SessionTurn && !seen.has(unit)) {
    seen.add(unit);
    if (unit.queue.includes(job) || unit.doneWork.includes(job) || unit.children.includes(job)) {
      holding = unit;
      break;
    }
    unit = unit.turnTail instanceof SessionTurn ? unit.turnTail : null;
  }
  const requestId = holding?.agentRequestId.trim() ?? "";
  if (requestId === "") return undefined;
  return loadOpenCall(kernel, session, requestId);
}
