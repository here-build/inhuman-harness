import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { asUserPrompt, asSystemPrompt } from "@inhuman.tools/harness-commons";
import { connectAdoptOutput, contract, isUiForm } from "@inhuman.tools/harness-contract";
import { fail, step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  SCHEME_REPL_TOOL_NAME,
  CallJob,
  AskAgentSpec,
  bindSessionProjections,
  clampChars,
  evalProgramOf,
  findEvalTurnByRequestId,
  HARNESS_CONSTITUTION,
  HOST_QUEUE_VERBS,
  isEvalRequestCancelled,
  mcpConnectionsEqual,
  mcpToolListStamp,
  parseStatuslineRefresh,
  ProgrammaticJob,
  refreshSystemPrompt,
  RegisteredToolsSet,
  resolvedTip,
  retractLastQueued,
  SESSION_TITLE_MAX_CHARS,
  sessionMintPermissionMode,
  steerFirstQueued,
  type SessionPlexus,
  type SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  layerErrors,
  parseAuthorizationConfig,
  SystemToolJob,
  ToolSpec,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";
import {
  applyKv,
  type KvProposal,
  sessionMintKvs,
  sessionMintLastUsedConnectionModel,
} from "@inhuman.tools/harness-model/shared";
import { schemeReplDescription, liveModelsOf, type CompletionFace } from "@inhuman.tools/harness-scheme";
import { discoverProjectSkills, expandSkillPrompt } from "@inhuman.tools/project-skills";
import { isGitShellCommand, runStatusline } from "@inhuman.tools/statusline";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { inspectAgentCall, listAgentCalls, namedWorkerIds, settleCancelledTurn } from "@inhuman.tools/turn/agent-calls";
import { turnRetentionJson } from "@inhuman.tools/turn/context";
import { writeBlob } from "@inhuman.tools/turn/tool-runtime";
import { observable, type IReactionDisposer, reaction, runInAction } from "mobx";

import { pluginStateSnapshotFromHead, restoreSessionPluginState, Refusal, toJS } from "@/extensions";
import { explainCall } from "@/policy-processor/explain";
import { scopes } from "@/policy-processor/scope";
import { documentImageSegments } from "@/protocol/document";
import { isMcpDriver } from "@/providers/mcp";
import { bindCompletionFace, OpenAiCompatActor } from "@/providers/openai-compat";
import { recoverSessionJobs } from "@/runtime";
import {
  admitCompact,
  admitTurn,
  cancelTurnCommand,
  drainPromptQueue,
  retryTurn,
  rewindTurn,
  type SessionCommandHost,
} from "@/session";
import { behaviorEntriesOf, bindSessionCatalog } from "@/tool-catalog";
import { resolveEvalPermissionMode, unattendedFailureText } from "@/tool-runtime";
import { attachLens, type AwarenessRoom, type PlaneSocket } from "@/yjs";

import { cancelAgentCall } from "./agent-calls-operator.js";
import { completeCallExceptionally } from "./agent-runtime.js";
import { withInstructions } from "./instructions.js";
import { SessionOrchestrator } from "./SessionOrchestrator.js";
import { watchGitStatusline } from "./statusline-git.js";
import {
  decodeVisualBytes,
  fitVisual,
  modelSeesImages,
  readVisual,
  writeVisual,
  type FittedVisual,
} from "./visual-store.js";
import { ackRequestOf } from "../../ack-requests.js";
import { applyAckAnswer, applyAskAnswer, promptTtlOf } from "../../ask-answer.js";
import { utf8TextOf } from "../../blobs/media.js";
import { readBlobSync } from "../../blobs/store.js";
import { vacuumSession, type VacuumCounts } from "../../blobs/vacuum.js";
import { captureEnv } from "../../capture-env.js";
import { DaemonRpcMethod, parseRpcInput, RequestHost, RpcInvalidParams } from "../../contract.js";
import { SHELL_TOOL_NAME } from "../../toolkit/catalog.js";
import { sessionCatalog } from "../../toolkit/tool-table.js";
import { applyPendingBotNotice } from "../bots/index.js";
import type { KernelDaemon } from "../kernel/KernelDaemon.js";
import type { ProjectDaemon } from "../project/ProjectDaemon.js";

function isModelChoiceKey(key: string): boolean {
  return key === "model" || key === "connection";
}

function parsePluginArgs(json: string | undefined): Record<string, unknown> {
  if (json == null || json.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("args must be a JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("args must be a JSON object");
  }
  return { ...(parsed as Record<string, unknown>) };
}

function evalProgramArgs(args: { readonly expr: string; readonly source?: string; readonly sourcePath?: string }): {
  expr: string;
  source?: string;
  sourcePath?: string;
  description: string;
} {
  return {
    expr: args.expr,
    // Host-initiated eval. Caption is optional; this one names the program.
    description: "eval program",
    ...(args.source == null ? {} : { source: args.source }),
    ...(args.sourcePath == null ? {} : { sourcePath: args.sourcePath }),
  };
}

function sameEvalProgramInput(
  program: ProgrammaticJob,
  args: {
    readonly expr: string;
    readonly source?: string;
    readonly sourcePath?: string;
  },
): boolean {
  const raw = program.args ?? {};
  return (
    program.expr === args.expr &&
    (typeof raw.source === "string" ? raw.source : "") === (args.source ?? "") &&
    (typeof raw.sourcePath === "string" ? raw.sourcePath : "") === (args.sourcePath ?? "")
  );
}

export class SessionDaemon extends RequestHost implements Disposable {
  readonly plexus: SessionPlexus;
  readonly orchestrator: SessionOrchestrator;
  readonly ready: Promise<void>;
  /** Teaching verbosity for scheme-repl envelope doors. Process-local, not a Plexus field. */
  readonly doors = new DoorSession((line) => step(line));
  /** Held until the eval-admission flush receipt; honor must not start the program. */
  readonly evalAdmissionHeld = observable.box(false);
  readonly #room: AwarenessRoom;
  #closed = false;
  #parked = false;
  #parkWait: Promise<void> | null = null;
  #statuslineRunning = false;
  #statuslineAgain = false;
  #statuslineClock: IReactionDisposer | undefined;
  #statuslineRefreshWatch: IReactionDisposer | undefined;
  #statuslineTimer: ReturnType<typeof setInterval> | undefined;
  #statuslineGitWatch: ReturnType<typeof watchGitStatusline> | undefined;
  #statuslineGitShellStop: IReactionDisposer | undefined;
  #mcpBlockStamp = "";
  #behaviorStamp = "";
  #actionChain: Promise<void> = Promise.resolve();
  readonly #hydrated: boolean;
  #recovered = false;
  #activated = false;
  #resolveReady = (): void => undefined;
  override rpcMethods = [
    DaemonRpcMethod.fromContract(contract.session.kv.set, (args) => {
      step(`kv/set ${args.scope} ${args.key}=${args.value}${args.remember === true ? " remember" : ""}`);
      this.#write(args.scope, [{ form: "kv-set", key: args.key, value: args.value }], args.remember === true);
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.session.kv.clear, (args) => {
      step(`kv/clear ${args.scope} ${args.key}`);
      this.#write(args.scope, [{ form: "kv-clear", key: args.key }]);
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.session.plugin.method, async (args) => {
      step(`plugin/method ${args.plugin} ${args.scope} ${args.method}`);
      try {
        const record = parsePluginArgs(args.args);
        if (args.field != null && args.field !== "") {
          const text = (args.input ?? "").trim();
          if (text === "") return { ok: false as const, error: `${args.field} is required` };
          record[args.field] = text;
        }
        const value = await this.kernel.behavior.callState({
          plugin: args.plugin,
          scope: args.scope,
          agentId: this.sessionId,
          projectId: this.project.path,
          method: args.method,
          args: record,
        });
        if (value instanceof Refusal) return { ok: false as const, error: value.message };
        return { ok: true as const, value: toJS(value) };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
    DaemonRpcMethod.fromContract(contract.session.policy.set, (args) => {
      step(`policy/set ${args.policy}`);
      this.#writeDefaultPermissionMode(args.policy);
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.session.connect.adopt, async (input) => {
      const result = await this.kernel.handleRequest("connect/adopt", input);
      if (isUiForm(result)) return result;
      const parsed = parseRpcInput(connectAdoptOutput, result);
      if ("id" in parsed) {
        this.#write("session", [{ form: "kv-set", key: "connection", value: parsed.id }]);
        // /model reads live.models. Adopt is demand — intern now, not on first turn.
        try {
          await this.orchestrator.ensure(parsed.id);
        } catch {
          /* probe miss is connection.failed; the row is already persisted */
        }
      }
      return parsed;
    }),
    DaemonRpcMethod.fromContract(contract.session.policy.explain, async (args) => {
      return await explainCall(scopes.get(this.root), args.probe, { mode: args.mode, unattended: args.unattended });
    }),
    DaemonRpcMethod.fromContract(contract.session.policy.overlay, (args) => {
      // A human decision for this session only. It may loosen what the user's config says, but the
      // project layer still caps it (the resolution table applies the project layer last).
      if (args.overlay === null) {
        runInAction(() => this.root.replaceAuthorizationOverlay(""));
        return { ok: true, errors: [] };
      }
      const parsed = parseAuthorizationConfig(args.overlay);
      if (!parsed.ok) return { ok: false, errors: [...parsed.errors] };
      runInAction(() => this.root.replaceAuthorizationOverlay(JSON.stringify(parsed.config)));
      return { ok: true, errors: [] };
    }),
    DaemonRpcMethod.fromContract(contract.session.policy.configGet, () => {
      const root = this.root;
      const warnings: string[] = [];
      for (const [name, text] of [
        ["user", root.authorizationUserJson],
        ["session", root.authorizationOverlayJson],
      ] as const) {
        for (const error of layerErrors(text)) warnings.push(`${name} layer: ${error}`);
      }
      if (root.authorizationProjectJson !== "" && layerErrors(root.authorizationProjectJson).length > 0) {
        warnings.push(
          "project layer (.inhuman/authorization.json) does not parse: every call it would govern asks a person",
        );
      }
      return {
        layers: {
          user: root.authorizationUserJson,
          project: root.authorizationProjectJson,
          session: root.authorizationOverlayJson,
        },
        warnings,
      };
    }),
    DaemonRpcMethod.fromContract(contract.session.turn.send, (args) => {
      const incoming = args.visuals ?? [];
      const named = args.kind;
      const kind = named === "queue" || named === "continue" ? named : undefined;
      if (incoming.length > 0) {
        if (named === "steer" || named === "queue" || named === "continue" || this.root.findRunningTurn() != null) {
          throw new RpcInvalidParams("an image can't be sent with that");
        }
        if (!modelSeesImages(this.root.kvs.model ?? "")) {
          throw new RpcInvalidParams("this model can't see images");
        }
        if ((this.root.kvs.connection ?? "").trim() === "") {
          throw new RpcInvalidParams("connection is required");
        }
      }
      const visuals = incoming.length === 0 ? undefined : this.#seatVisuals(incoming);
      const result = admitTurn(this.#commandHost(), {
        prompt: args.prompt,
        kind,
        ...(visuals === undefined ? {} : { visuals }),
      });
      if (!result.ok && result.invalid) throw new RpcInvalidParams(result.reason);
      if (result.ok && (result.action === "steer" || result.action === "queue")) {
        trace("harness:turn", `admit ${result.action} chars=${args.prompt.trim().length}`);
      }
      return { ok: true as const };
    }),
    DaemonRpcMethod.fromContract(contract.session.compact, (args) => {
      const result = admitCompact(this.#commandHost(), args.focus ?? "");
      if (!result.ok && result.invalid) throw new RpcInvalidParams(result.reason);
      if (!result.ok) return { ok: false as const, reason: result.reason };
      return { ok: true as const, compacted: false as const };
    }),
    DaemonRpcMethod.fromContract(contract.session.rename, (args) => {
      return this.#applyRename(args.title);
    }),
    DaemonRpcMethod.fromContract(contract.session.eval, async (args) => {
      const existing = findEvalTurnByRequestId(this.root, args.requestId);
      if (existing != null) {
        const program = evalProgramOf(existing);
        if (
          existing.evalSpec?.permissionMode !== args.policy ||
          program == null ||
          !sameEvalProgramInput(program, args)
        ) {
          throw new RpcInvalidParams("eval requestId already admitted with different input");
        }
        return {
          ok: true as const,
          turnId: existing.uuid,
          programId: program.uuid,
        };
      }
      RpcInvalidParams.invariant(!isEvalRequestCancelled(this.root, args.requestId), "eval request was cancelled");
      const policy = resolveEvalPermissionMode(args.policy);
      if (policy == null) {
        return {
          ok: false as const,
          code: "policy_unavailable" as const,
          text: unattendedFailureText("policy_unavailable", args.policy),
        };
      }
      RpcInvalidParams.invariant(this.root.findRunningTurn() == null, "already running");
      const constitution = this.#constitution();
      const tail =
        this.root.head ??
        new SessionSystemPrompt({
          constitution,
          env: this.#sessionEnv(),
          skills: this.root.skills.map((skill) => skill.clone()),
        });
      const program = new ProgrammaticJob({
        toolCallId: "program",
        argsJson: JSON.stringify(evalProgramArgs(args)),
      });
      const turn = new SessionTurn({
        turnTail: tail,
        prompt: asUserPrompt(""),
        evalSpec: new SessionTurnEvalSpec({
          requestId: args.requestId,
          permissionMode: policy,
        }),
        permissionMode: policy,
        queue: [program],
        toolsDefinition: this.#toolsDefinitionFor(tail),
        retentionJson: this.#retentionJson(),
      });
      const previousHead = this.root.head;
      const previousTip = this.root.tip;
      try {
        await this.kernel.flushSession(this.plexus);
      } catch {
        throw new RpcInvalidParams("eval admission could not be persisted");
      }
      if (isEvalRequestCancelled(this.root, args.requestId)) {
        throw new RpcInvalidParams("eval request was cancelled");
      }
      try {
        runInAction(() => {
          this.evalAdmissionHeld.set(true);
          this.root.head = turn;
          this.root.tip = turn;
          refreshSystemPrompt(turn, {
            constitution,
            env: this.#sessionEnv(),
          });
        });
        if (isEvalRequestCancelled(this.root, args.requestId)) {
          cancelTurnCommand(this.#commandHost(), { requestId: args.requestId });
        }
        await this.kernel.flushSession(this.plexus);
      } catch {
        runInAction(() => this.#abandonAdmission(turn, previousHead, previousTip, args.requestId));
        throw new RpcInvalidParams("eval admission could not be persisted");
      } finally {
        runInAction(() => this.evalAdmissionHeld.set(false));
      }
      step(`eval ${args.requestId}`);
      return {
        ok: true as const,
        turnId: turn.uuid,
        programId: program.uuid,
      };
    }),
    DaemonRpcMethod.fromContract(contract.session.turn.cancel, async (args) => {
      const result = cancelTurnCommand(this.#commandHost(), args);
      await this.kernel.flushSession(this.plexus);
      return result;
    }),
    DaemonRpcMethod.fromContract(contract.session.turn.visual, (args) => {
      const visual = seatedVisual(this.root.head, args.id);
      if (visual == null) throw new RpcInvalidParams("unknown picture");
      const bytes = readVisual(this.sessionId, visual.id);
      if (bytes == null) throw new RpcInvalidParams("unknown picture");
      return {
        id: visual.id,
        mime: visual.mime,
        bytesBase64: Buffer.from(bytes).toString("base64"),
        width: visual.width,
        height: visual.height,
        resizedFrom: visual.resizedFrom,
        sourcePath: visual.sourcePath,
      };
    }),
    DaemonRpcMethod.fromContract(contract.session.blob.get, (args) => {
      const blob = readBlobSync(args.sha256);
      if (blob == null) throw new RpcInvalidParams("unknown blob");
      const text = blob.mime.startsWith("text/") ? utf8TextOf(blob.bytes) : null;
      return {
        sha256: args.sha256,
        bytes: blob.bytes.byteLength,
        mime: blob.mime,
        text,
        bytesBase64: text === null ? Buffer.from(blob.bytes).toString("base64") : null,
      };
    }),
    DaemonRpcMethod.fromContract(contract.session.blob.vacuum, async (args) => {
      const dryRun = args.dryRun === true;
      const imageBytesBefore = this.#imageBytes();
      let counts: VacuumCounts;
      try {
        counts = vacuumSession(this.root, writeBlob, {
          dryRun,
          read: (sha256) => readBlobSync(sha256)?.bytes ?? null,
        });
      } catch (error) {
        // What moved before the stop is moved for good; the snapshot reclaims it.
        if (!dryRun) await this.kernel.flushSession(this.plexus, { force: true }).catch(() => undefined);
        throw error;
      }
      step(`blob/vacuum${dryRun ? " (dry run)" : ""} ${JSON.stringify(counts)}`);
      // The update log still holds the text it was first written with; only a snapshot of the live document drops it.
      if (!dryRun) await this.kernel.flushSession(this.plexus, { force: true });
      return { dryRun, ...counts, imageBytesBefore, imageBytesAfter: dryRun ? imageBytesBefore : this.#imageBytes() };
    }),
    DaemonRpcMethod.fromContract(contract.session.turn.rewind, (args) => {
      const result = rewindTurn(this.#commandHost(), args.turnId);
      if (!result.ok) throw new RpcInvalidParams(result.reason);
      return { ok: true as const, turnId: result.turnId };
    }),
    DaemonRpcMethod.fromContract(contract.session.turn.retry, () => {
      return retryTurn(this.#commandHost());
    }),
    DaemonRpcMethod.fromContract(contract.session.ask.answer, (args) => {
      const target = this.#rootFor(args.sessionId);
      const leaf = target?.findRunningTurn()?.approvalHead;
      if (leaf == null || leaf.uuid !== args.jobId || leaf.humanApprove !== null) {
        return { ok: false, reason: "not-pending" as const };
      }
      const bot = scopes.get(this.root).botName();
      const result = applyAskAnswer(this.root, leaf, args, {
        now: () => Date.now(),
        newId: () => `g-${randomUUID().slice(0, 12)}`,
        promptTtl: promptTtlOf(this.root.authorizationUserJson),
        persist: (row) => this.kernel.addPersistentGrant(row),
        ...(bot === undefined ? {} : { bot }),
      });
      if (!result.ok) return result;
      // A grant just stored may cover other asks that are already waiting.
      if (result.grant !== undefined || args.ackStore !== undefined) scopes.get(this.root).reconcileGrants();
      return result;
    }),
    DaemonRpcMethod.fromContract(contract.session.ack.pending, (args) => {
      const roots =
        args.sessionId === undefined
          ? [this.root, ...namedWorkerIds(this.root).flatMap((id) => this.kernel.sessionPlexus(id)?.root ?? [])]
          : [this.#rootFor(args.sessionId)].flatMap((root) => root ?? []);
      const bot = scopes.get(this.root).botName();
      const promptTtl = promptTtlOf(this.root.authorizationUserJson);
      const acks = roots.flatMap((root) =>
        (root.findRunningTurn()?.approvalLeaves ?? [])
          .filter((leaf) => leaf.ackPending)
          .map((leaf) => ackRequestOf(root, leaf, { bot, promptTtl, now: Date.now() })),
      );
      return { acks };
    }),
    DaemonRpcMethod.fromContract(contract.session.ack.answer, (args) => {
      const target = this.#rootFor(args.sessionId);
      const leaf = target?.findRunningTurn()?.approvalLeaves.find((candidate) => candidate.uuid === args.jobId);
      if (leaf == null || args.ackId !== leaf.uuid || !leaf.ackPending || leaf.humanApprove !== null) {
        return { ok: false, reason: "not-pending" as const };
      }
      const bot = scopes.get(this.root).botName();
      const result = applyAckAnswer(
        this.root,
        leaf,
        { accept: args.accept, store: args.store, comment: args.comment },
        {
          now: () => Date.now(),
          newId: () => `a-${randomUUID().slice(0, 12)}`,
          promptTtl: promptTtlOf(this.root.authorizationUserJson),
          persist: (row) => this.kernel.addPersistentGrant(row),
          ...(bot === undefined ? {} : { bot }),
        },
      );
      if (!result.ok) return result;
      // An ack just stored may satisfy other calls that are already waiting.
      if (result.ack !== undefined) scopes.get(this.root).reconcileGrants();
      return result;
    }),
    DaemonRpcMethod.fromContract(contract.session.resident.set, (args) => {
      this.root.agent.spec.resident = args.resident;
      return { ok: true as const };
    }),
    // Inbox moves run on the door with the turn-close drain; a client-side shift would merge with it.
    DaemonRpcMethod.fromContract(contract.session.queue.steerFirst, (args) => {
      if (this.root.promptQueue[0]?.uuid !== args.id) return { ok: false };
      steerFirstQueued(this.root);
      return { ok: true };
    }),
    DaemonRpcMethod.fromContract(contract.session.queue.retractLast, (args) => {
      if (this.root.promptQueue.at(-1)?.uuid !== args.id) return { ok: false };
      retractLastQueued(this.root);
      return { ok: true };
    }),
    DaemonRpcMethod.fromContract(contract.session.agentCalls.list, () => {
      const calls = listAgentCalls(this.root, this.kernel.catalog);
      return { calls };
    }),
    DaemonRpcMethod.fromContract(contract.session.agentCalls.inspect, (args) => {
      const view = inspectAgentCall(this.root, args.requestId, this.kernel.catalog, (id) => {
        const found = this.plexus.loadEntity<CallJob>(id);
        return found instanceof CallJob ? found : undefined;
      });
      if (view == null) return { ok: false as const, reason: "unknown requestId" };
      return view;
    }),
    DaemonRpcMethod.fromContract(contract.session.agentCalls.cancel, (args) => ({
      ok: cancelAgentCall(
        {
          kernel: this.kernel,
          project: this.project,
          caller: this.root,
        },
        args.requestId,
        (id) => {
          const found = this.plexus.loadEntity<CallJob>(id);
          return found instanceof CallJob ? found : undefined;
        },
      ),
    })),
  ];

  constructor(
    readonly project: ProjectDaemon,
    readonly sessionId: string,
    existing: SessionPlexus,
    restored: boolean,
  ) {
    super();
    this.plexus = existing;
    this.#hydrated = restored;
    this.#room = this.kernel.sessionRoom(this.sessionId, this.plexus.awareness);
    if (!this.#hydrated) {
      runInAction(() => {
        const seed = sessionMintKvs(project.kernel.plexus.root.kvs, project.root.kvs);
        if (seed.length > 0) this.plexus.root.applyKvs(seed);
        const lastUsed = sessionMintLastUsedConnectionModel(
          project.kernel.plexus.root.lastUsedConnectionModel,
          project.root.lastUsedConnectionModel,
        );
        if (Object.keys(lastUsed).length > 0) this.plexus.root.lastUsedConnectionModel = lastUsed;
        const policy = sessionMintPermissionMode(
          project.kernel.plexus.root.defaultPermissionMode,
          project.root.defaultPermissionMode,
        );
        if (this.plexus.root.standingPermissionMode !== policy) this.plexus.root.standingPermissionMode = policy;
        this.#syncSkills();
      });
    }
    this.orchestrator = new SessionOrchestrator(this);
    bindSessionCatalog(this.plexus.root, project.kernel.catalog);
    bindSessionProjections(this.plexus.root, project.kernel.projections);
    // The tools[] face is part of the cached prefix: render the scheme_repl inventory once
    // per session. A turn with a frozen tool set never gets here; the frozen text wins.
    let schemeReplText: string | undefined;
    bindCompletionFace(this.plexus.root, {
      catalog: () => sessionCatalog(this.plexus.root),
      liveDescription: (name) => {
        if (name !== SCHEME_REPL_TOOL_NAME) return undefined;
        if (schemeReplText !== undefined) return schemeReplText;
        const catalog = sessionCatalog(this.plexus.root);
        if (catalog === undefined) return undefined;
        schemeReplText = schemeReplDescription(catalog);
        return schemeReplText;
      },
    });
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  /**
   * Reclaim restored work and pin caller/worker replicas. Honor still waits
   * for {@link activate}.
   */
  async recover(): Promise<void> {
    if (this.#recovered) return;
    if (this.#hydrated) {
      recoverSessionJobs(this.plexus.root, {
        catalog: this.project.kernel.catalog,
        releaseCall: (call) =>
          completeCallExceptionally(
            call,
            {
              kernel: this.project.kernel,
              project: this.project,
              caller: this.plexus.root,
            },
            "cancelled",
          ),
      });
      runInAction(() => {
        this.#syncSkills();
        const resolved = resolvedTip(this.root.head, this.root.tip);
        if (this.root.tip !== resolved) this.root.tip = resolved;
      });
    }
    // A peer that cannot open (overload, corrupt image) must not block this session.
    for (const id of new Set([...namedWorkerIds(this.root), ...Object.values(this.root.agentCallbacks)])) {
      if (id === "" || id === this.sessionId) continue;
      try {
        await this.project.kernel.acquireSession(id);
      } catch (error) {
        fail(`recover peer ${id}`, error);
      }
    }
    this.#recovered = true;
  }

  /** Recovered replica is interned; honor stays off until {@link activate}. */
  releaseReady(): void {
    this.#resolveReady();
  }

  /** Start PEW honor and session observers. Pins and recovery must already have run. */
  activate(): void {
    if (this.#closed) {
      this.#resolveReady();
      return;
    }
    if (this.#activated) {
      this.#resolveReady();
      return;
    }
    this.#activated = true;
    this.orchestrator.activate();
    this.#statuslineRefreshWatch = reaction(
      () => `${this.kernel.plexus.root.statusline}\0${this.kernel.plexus.root.statuslineRefresh}`,
      () => {
        this.#bindStatuslineClock();
        this.requestStatusline("attach");
      },
      { fireImmediately: true },
    );
    this.#ensureGitWatch();
    this.#statuslineGitShellStop = reaction(
      () => {
        const work = this.root.head?.doneWork;
        if (work == null || work.length === 0) return "";
        const last = work.at(-1);
        if (!(last instanceof SystemToolJob) || last.name !== SHELL_TOOL_NAME) return "";
        const command = last.args?.command;
        if (typeof command !== "string" || !isGitShellCommand(command)) return "";
        return last.uuid;
      },
      (uuid) => {
        if (uuid === "") return;
        this.#ensureGitWatch();
        this.requestStatusline("git");
      },
    );
    this.#resolveReady();
  }

  /** Coalesced silent left-slot refresh. `attach` / `git` always run; clocks match config. */
  requestStatusline(reason: "round" | "turn" | "interval" | "attach" | "git" = "attach"): void {
    if (this.#closed) return;
    const parsed = parseStatuslineRefresh(this.kernel.plexus.root.statuslineRefresh);
    if (reason !== "attach" && reason !== "git" && reason !== parsed.kind) return;
    if (this.#statuslineRunning) {
      this.#statuslineAgain = true;
      return;
    }
    this.#statuslineRunning = true;
    void this.#runStatusline().finally(() => {
      this.#statuslineRunning = false;
      if (this.#statuslineAgain) {
        this.#statuslineAgain = false;
        this.requestStatusline(reason);
      }
    });
  }

  async #runStatusline(): Promise<void> {
    const cwd = this.root.path.trim() === "" ? process.cwd() : this.root.path;
    const left = await runStatusline(this.kernel.plexus.root.statusline, cwd);
    if (this.#closed) return;
    if (this.root.statuslineLeft !== left) this.root.statuslineLeft = left;
  }

  #stopStatuslineClock(): void {
    this.#statuslineClock?.();
    this.#statuslineClock = undefined;
    if (this.#statuslineTimer !== undefined) {
      clearInterval(this.#statuslineTimer);
      this.#statuslineTimer = undefined;
    }
  }

  #ensureGitWatch(): void {
    if (this.#closed) return;
    if (this.#statuslineGitWatch != null) return;
    this.#statuslineGitWatch = watchGitStatusline(this.root.path, () => this.requestStatusline("git"));
  }

  #stopGitWatch(): void {
    this.#statuslineGitShellStop?.();
    this.#statuslineGitShellStop = undefined;
    const watcher = this.#statuslineGitWatch;
    this.#statuslineGitWatch = undefined;
    void watcher?.[Symbol.dispose]();
  }

  #bindStatuslineClock(): void {
    this.#stopStatuslineClock();
    if (this.#closed) return;
    const parsed = parseStatuslineRefresh(this.kernel.plexus.root.statuslineRefresh);
    if (parsed.kind === "interval") {
      const timer = setInterval(() => this.requestStatusline("interval"), parsed.ms);
      timer.unref();
      this.#statuslineTimer = timer;
      return;
    }
    this.#statuslineClock = reaction(
      () => {
        const head = this.root.head;
        if (head == null) return "none";
        return parsed.kind === "turn"
          ? `${head.uuid}:${head.reducerExited}`
          : `${head.uuid}:${head.reducerExited}:${head.doneWork.length}`;
      },
      () => this.requestStatusline(parsed.kind),
    );
  }

  get kernel(): KernelDaemon {
    return this.project.kernel;
  }

  get root() {
    return this.plexus.root;
  }

  /** Serialized with the door so a concurrent `turn` cannot twin-mint. */
  drainPromptQueue(): Promise<void> {
    return this.#serialize(() => {
      drainPromptQueue(this.#commandHost());
    });
  }

  /** Standing instructions plus project and user instruction files. */
  #constitution() {
    const base = this.root.agent.spec.instructions || HARNESS_CONSTITUTION;
    return asSystemPrompt(withInstructions(base, this.root.path));
  }

  /** R1: kernel config layered with session kv; kv may only shorten retention. */
  #retentionJson(): string {
    return turnRetentionJson(this.kernel.plexus.root.contextRetentionJson, this.root.kvs);
  }

  /**
   * The env facts for the system prompt. `Mode` rides here, not as a live line, so it
   * enters the cached prefix at turn boundaries only and a mid-turn change cannot move it.
   */
  #sessionEnv(): Record<string, string> {
    const env = captureEnv(this.root.path);
    return this.root.mode === "" ? env : { Mode: this.root.mode, ...env };
  }

  /** This session, or a worker that escalated to it. */
  #rootFor(sessionId: string): SessionRoot | undefined {
    if (sessionId === this.sessionId) return this.root;
    return namedWorkerIds(this.root).includes(sessionId) ? this.kernel.sessionPlexus(sessionId)?.root : undefined;
  }

  #commandHost(): SessionCommandHost {
    return {
      session: this.root,
      constitution: this.#constitution(),
      env: () => this.#sessionEnv(),
      toolsFor: (tail) => this.#toolsDefinitionFor(tail),
      retentionJson: () => this.#retentionJson(),
      queuedVerbs: () => this.#queuedVerbs(),
      expandSkill: (prompt, skills, verbs) => {
        const expanded = expandSkillPrompt(prompt, skills, verbs);
        return {
          prompt: asUserPrompt(expanded.prompt),
          derived: expanded.derived == null ? null : asUserPrompt(expanded.derived),
        };
      },
      syncSkills: () => this.#syncSkills(),
      applyBotNotice: (turn) => applyPendingBotNotice(this.root, turn),
      restorePluginState: () => this.restorePluginState(),
      cancelOwned: (turn) => this.orchestrator.cancelOwned(turn),
      skipBackoff: (completion) => {
        const actor = this.orchestrator.actorOf(completion);
        if (actor instanceof OpenAiCompatActor) actor.skipBackoff();
      },
      loadTurn: (id) => {
        try {
          const loaded = this.plexus.loadEntity(id);
          return loaded instanceof SessionTurn ? loaded : undefined;
        } catch {
          return undefined;
        }
      },
      rename: (title) => this.#applyRename(title),
      log: (message) => step(message),
      compactKeepTurns: () => this.kernel.plexus.root.compactKeepTurns,
      closed: this.#closed || this.#parked,
    };
  }

  /** A second project must not wrap a live daemon. Live eval hold still counts; on-wire MCP hold does not. */
  get interpreting(): boolean {
    return this.#activated && !this.#closed && (!this.#parked || this.orchestrator.holdingEval);
  }

  protected override get parent() {
    return this.project;
  }

  protected override execute(run: () => unknown | Promise<unknown>) {
    return this.#serialize(run);
  }

  /**
   * An answer must not wait behind a perform that is itself parked on the human, and a blob read
   * touches no document, so a diff can paint while a long turn holds the queue.
   */
  protected override queuesExecute(method: string): boolean {
    return method !== "ask/answer" && method !== "ack/answer" && method !== "blob/get";
  }

  protected override attach(socket: PlaneSocket): void {
    if (this.#closed) {
      socket.close(1001, "session disposed");
      return;
    }
    // Clients read through a lens and change state through RPC.
    attachLens(this.plexus.doc, socket, this.#room, this.plexus.awareness);
  }

  /**
   * Drop interpretation; keep intern and the SessionRoot. Re-bootstrap is
   * `project.session(id)` wrapping this plexus — do not mint a twin.
   *
   * On-wire MCP and live eval bags keep this daemon registered until that
   * honor settles. Drop earlier and attach wraps a second honor on the same
   * root — a second `tools/call` would hide whether the mutation landed.
   */
  park(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#parkWait != null) return this.#parkWait;
    if (this.#parked) return Promise.resolve();
    this.#resolveReady();
    this.#statuslineRefreshWatch?.();
    this.#statuslineRefreshWatch = undefined;
    this.#stopStatuslineClock();
    this.#stopGitWatch();
    this.kernel.dropReservation(this.sessionId);
    this.#parked = true;
    const keep = this.kernel.graphEligibleSessionIds();
    const workers: SessionDaemon[] = [];
    for (const id of namedWorkerIds(this.root)) {
      const worker = this.kernel.liveSession(id);
      if (worker == null || keep.has(id)) continue;
      const spec = worker.root.agent.spec;
      if (spec.recipeScope === "session" || spec instanceof AskAgentSpec) workers.push(worker);
    }
    const honor = this.orchestrator.park();
    if (!this.orchestrator.holding) {
      this.#dropParked();
      for (const worker of workers) void worker.park();
      this.#parkWait = honor;
      return honor;
    }
    // eslint-disable-next-line promise/always-return
    const wait = honor.then(async () => {
      this.#dropParked();
      await Promise.all(workers.map((worker) => worker.park()));
    });
    this.#parkWait = wait;
    return wait;
  }

  #dropParked(): void {
    if (this.#closed) return;
    runInAction(() => {
      delete this.project.sessions[this.sessionId];
    });
    this.kernel.dropDaemon(this.sessionId);
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    void this.park();
  }

  /** Persist failed: do not leave a runnable turn or acknowledge admission. */
  #abandonAdmission(
    turn: SessionTurn,
    previousHead: SessionTurn | null,
    previousTip: SessionTurn | null,
    requestId: string,
  ): void {
    try {
      turn.cancelRequested = true;
      this.root.cancelledEvalRequests[requestId] = "1";
    } catch {
      /* persist of the cancel record may be the same failure */
    }
    try {
      this.orchestrator.cancelOwned(turn);
    } catch {
      try {
        settleCancelledTurn(turn, this.kernel.catalog, (call) =>
          completeCallExceptionally(
            call,
            {
              kernel: this.kernel,
              project: this.project,
              caller: this.root,
            },
            "cancelled",
          ),
        );
      } catch {
        /* in-memory bits may already be sealed */
      }
    }
    if (this.root.head === turn) {
      try {
        this.root.head = previousHead;
        this.root.tip = previousTip;
      } catch {
        /* in-memory cancel is the admission failure */
      }
    }
  }

  #seatVisuals(
    visuals: readonly { readonly mime: string; readonly bytesBase64: string; readonly sourcePath?: string }[],
  ): UserVisualIdentity[] {
    const fitted: FittedVisual[] = [];
    for (const visual of visuals) {
      const bytes = decodeVisualBytes(visual.bytesBase64);
      if (bytes == null) throw new RpcInvalidParams("the picture could not be read");
      const fit = fitVisual({ mime: visual.mime, bytes, sourcePath: visual.sourcePath });
      if (!fit.ok) throw new RpcInvalidParams(fit.reason);
      fitted.push(fit);
    }
    return fitted.map((fit) => {
      const id = randomUUID();
      writeVisual(this.sessionId, id, fit.bytes);
      return {
        id,
        mime: fit.mime,
        width: fit.width,
        height: fit.height,
        resizedFrom: fit.resizedFrom,
        sourcePath: fit.sourcePath,
      };
    });
  }

  /**
   * Session plugin state follows the head: the logs the nearest turn recorded
   * when it ended, or none. Project and global state do not move.
   */
  restorePluginState(): void {
    const snapshot = pluginStateSnapshotFromHead(this.root.head);
    runInAction(() => {
      restoreSessionPluginState({
        directory: this.kernel.behavior.directory,
        sessionId: this.sessionId,
        live: this.root.pluginState,
        snapshot,
      });
    });
  }

  #serialize<T>(run: () => T | Promise<T>): Promise<T> {
    const bound = this.bindPerform(run);
    const next = this.#actionChain.then(bound, bound);
    this.#actionChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #mcpConnectionIds(): string[] {
    const ids: string[] = [];
    const kvs = this.root.kvs;
    for (const [id, spec] of Object.entries(this.kernel.plexus.root.connections)) {
      if (spec == null || !isMcpDriver(spec.driver.abilityClaim)) continue;
      if (spec.configuration.enabled === false) continue;
      if ((kvs[`mcp-disabled:${id}`] ?? "") !== "") continue;
      ids.push(id);
    }
    ids.sort();
    return ids;
  }

  /** Size of this session's stored image; 0 before it is first written. */
  #imageBytes(): number {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the kernel's own image path for this session
      return statSync(join(this.kernel.root, ...documentImageSegments("sessions", this.sessionId))).size;
    } catch {
      return 0;
    }
  }

  #applyRename(title: string): { ok: true; title: string } {
    const trimmed = title.trim();
    this.root.manualTitle = trimmed === "" ? "" : clampChars(trimmed, SESSION_TITLE_MAX_CHARS);
    step(`rename ${this.root.manualTitle === "" ? "--auto" : this.root.manualTitle}`);
    return { ok: true as const, title: this.root.title };
  }

  #queuedVerbs(): Set<string> {
    const verbs = new Set<string>(HOST_QUEUE_VERBS);
    for (const [key, spec] of Object.entries(this.kernel.plexus.root.commands)) {
      if (key !== "") verbs.add(key);
      if (spec == null) continue;
      if (spec.verb !== "") verbs.add(spec.verb);
      for (const alias of spec.aliases) {
        if (alias !== "") verbs.add(alias);
      }
    }
    return verbs;
  }

  /**
   * First turn always snapshots. Later turns snapshot when the tail asked
   * (`reloadTools`, compact), kernel MCP ids drifted from the frozen set,
   * or the session tool blocklist changed.
   */
  #toolsDefinitionFor(tail: SessionSystemPrompt | SessionTurn | null): RegisteredToolsSet | null {
    const stamp = mcpToolListStamp(this.root.toolBlocklist);
    const behavior = this.#behaviorToolStamp();
    if (
      tail instanceof SessionTurn &&
      !tail.reloadTools &&
      mcpConnectionsEqual(tail.tools.mcpConnections, this.#mcpConnectionIds()) &&
      this.#mcpBlockStamp === stamp &&
      this.#behaviorStamp === behavior
    ) {
      return null;
    }
    this.#mcpBlockStamp = stamp;
    this.#behaviorStamp = behavior;
    const mcpIds = new Set(this.#mcpConnectionIds());
    const catalog = sessionCatalog(this.root) ?? this.kernel.catalog;
    const plexusRoot = this.kernel.plexus.root;
    const connections: CompletionFace[] = [];
    for (const [id, spec] of Object.entries(plexusRoot.connections)) {
      if (!spec?.driver.abilityClaim.includes("completion")) continue;
      connections.push({ id, models: liveModelsOf(spec) });
    }
    const catalogText = schemeReplDescription(catalog, {
      connections,
      modelsUsage: plexusRoot.modelsUsage,
    });
    return new RegisteredToolsSet({
      entries: catalog
        .catalogEntries()
        .filter((entry) => entry.representation === "tool" || entry.representation === "both")
        .filter((entry) => entry.source.kind !== "connection" || mcpIds.has(entry.source.connectionKey))
        .map(
          (entry) =>
            new ToolSpec({
              name: entry.wireName,
              description: entry.wireName === SCHEME_REPL_TOOL_NAME ? catalogText : entry.description,
              argsJson: JSON.stringify(entry.parameters),
              mutates: entry.class === "write",
            }),
        ),
      mcpConnections: this.#mcpConnectionIds(),
      addendum: catalog.TOOLS_SYSTEM_ADDENDUM,
    });
  }

  #behaviorToolStamp(): string {
    const entries = behaviorEntriesOf(this.root);
    if (entries.length === 0) return "";
    return JSON.stringify(entries.map((entry) => [entry.wireName, entry.description, entry.parameters]));
  }

  /** Behavior attaches after the turn is minted. Re-freeze when its tools moved. */
  syncBehaviorTools(turn: SessionTurn): void {
    if (this.#behaviorToolStamp() === this.#behaviorStamp) return;
    const tools = this.#toolsDefinitionFor(null);
    runInAction(() => {
      turn.toolsDefinition = tools;
    });
  }

  /**
   * Named scope writes that bag only. Session kv-set stays on the session
   * unless `remember` — `/model` and `/connect` pass it so `model` and
   * `connection` also land on project and kernel. A bare session write
   * (subagent, `--model`, `--connection`) does not. Other keys still
   * write through. Session kv-clear stays session-local so a clear cannot
   * reveal (or erase) a parent bag.
   */
  #write(scope: "session" | "project" | "kernel", proposals: readonly KvProposal[], remember = false): void {
    if (scope === "kernel") {
      this.#writeKernel(proposals);
      this.#stampModelUsage("kernel", this.kernel.plexus.root.kvs, proposals);
      return;
    }
    if (scope === "project") {
      this.project.root.applyKvs(proposals);
      this.#stampModelUsage("project", this.project.root.kvs, proposals);
      return;
    }
    this.root.applyKvs(proposals);
    const assigned = proposals.filter((proposal) => proposal.form === "kv-set");
    if (assigned.length === 0) return;
    const projected = remember ? assigned : assigned.filter((proposal) => !isModelChoiceKey(proposal.key));
    if (projected.length === 0) return;
    this.project.root.applyKvs(projected);
    this.#writeKernel(projected);
    if (remember) this.#stampModelUsage("session", this.root.kvs, projected);
  }

  #stampModelUsage(
    scope: "session" | "project" | "kernel",
    bag: Record<string, string>,
    proposals: readonly KvProposal[],
  ): void {
    const assigned = proposals.filter((proposal) => proposal.form === "kv-set");
    const modelSet = assigned.find((proposal) => proposal.key === "model");
    if (modelSet == null || modelSet.value.trim() === "") return;
    const connSet = assigned.find((proposal) => proposal.key === "connection");
    const connection = (connSet?.value ?? bag.connection ?? "").trim();
    if (connection === "") return;
    // Global recency; also the kernel last-used index.
    this.kernel.plexus.root.stampModelUsage(connection, modelSet.value);
    // Per-connection last-used mirrors the remembered kv write.
    if (scope === "session") {
      this.root.stampLastUsedConnectionModel(connection, modelSet.value);
      this.project.root.stampLastUsedConnectionModel(connection, modelSet.value);
    } else if (scope === "project") {
      this.project.root.stampLastUsedConnectionModel(connection, modelSet.value);
    }
  }

  #writeKernel(proposals: readonly KvProposal[]): void {
    this.kernel.adjustKv((bag) => {
      applyKv(bag, proposals);
    });
    this.kernel.plexus.root.applyKvs(proposals);
  }

  #syncSkills(): void {
    const next = discoverProjectSkills(this.root.path, undefined, this.#queuedVerbs());
    const current = this.root.skills;
    if (
      current.length === next.length &&
      current.every(
        (row, i) =>
          row.name === next[i]!.name &&
          row.description === next[i]!.description &&
          row.location === next[i]!.location &&
          (row.invoke === "" ? row.name : row.invoke) === next[i]!.invoke,
      )
    ) {
      return;
    }
    this.root.replaceSkills(next);
  }

  /**
   * Session assignment plus last-choice write-through onto project and
   * kernel — same backing as session kv-set, not a kv key. `eval` overlays
   * the turn and does not call this. Attach does not re-seed.
   */
  #writeDefaultPermissionMode(policy: "manual" | "auto" | "yolo"): void {
    this.root.writeChoicePermissionMode(policy, this.project.root);
    this.kernel.adjustConfig((config) => {
      config.defaultPermissionMode = policy;
    });
  }
}

function seatedVisual(head: SessionTurn | null, id: string): UserVisualIdentity | null {
  const seen = new Set<SessionTurn>();
  let cell: SessionTurn | null = head;
  while (cell != null && !seen.has(cell)) {
    seen.add(cell);
    const visual = cell.visuals.find((item) => item.id === id);
    if (visual !== undefined) return visual;
    const tail = cell.turnTail;
    cell = tail instanceof SessionTurn ? tail : null;
  }
  return null;
}
