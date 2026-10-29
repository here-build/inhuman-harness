/**
 * The daemon's side of agent calls. Settlement lives in the turn package's
 * agent-calls on acquired replicas; this host maps a kernel and project onto
 * that scope, and resolves the worker a call delivers into.
 */
import { createHash } from "node:crypto";

import { asSystemPrompt, asUserPrompt } from "@inhuman.tools/harness-commons";
import { fail } from "@inhuman.tools/harness-diagnostics";
import {
  AGENT_ASK,
  AGENT_SEND,
  AGENT_VOID,
  AgentCallbackJob,
  AgentCallNotification,
  AgentCallJob,
  AgentMessageJob,
  AgentNotifyJob,
  AskAgentSpec,
  AutonomousToolError,
  BotCallJob,
  CallJob,
  type CallFailCode,
  CompletionExpectation,
  delegatesPermissionMode,
  FailureOutcome,
  HARNESS_CONSTITUTION,
  projectWorkerPermissions,
  type SessionPlexus,
  type SessionRoot,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { oneShotModelError, parseModelRef } from "@inhuman.tools/harness-scheme";
import type { Job } from "@inhuman.tools/plexus-expectations";
import {
  completeCallExceptionally as completeCallOnScope,
  forceStopLoop,
  isCallPaused,
  loadOpenCall as loadOpenCallOnScope,
  markDelivered,
  settleCallFromCallback as settleAcceptedCallback,
  stampCallLifetime,
  type AgentRuntimeHost as AgentCallHost,
} from "@inhuman.tools/turn/agent-calls";
import { runInAction } from "mobx";

import { agentCallSupportsNotify, type CatalogRecipe, invokeDenied } from "@/tool-catalog";
import { isModelOriginContext, pluginCallContextOf } from "@/tool-runtime";

import { recipePin } from "./plugin-bots.js";
import { botPermissionMode } from "../bots/bot-mode.js";
import { renderBotCallWorkerPrompt } from "../../system-plugins/named-agents/agent-catalog.js";
import { botCallToolOf } from "../../toolkit/plugin-registry.js";
import { buildSourceCut, sourceCutCharLimit } from "../../toolkit/source-cut.js";
import { sessionCatalog } from "../../toolkit/tool-table.js";
import type { KernelDaemon } from "../kernel/KernelDaemon.js";
import type { ProjectDaemon } from "../project/ProjectDaemon.js";

export type AgentRuntimeHost = {
  readonly kernel: KernelDaemon;
  readonly project: ProjectDaemon;
  readonly caller: SessionRoot;
  readonly problem?: (what: string, error: unknown) => void;
};

/**
 * What an ad-hoc child may call when it asks to inherit its caller's tools. An unrestricted caller
 * passes the live catalog on. A worker caller is already inside a ceiling, so the child gets exactly
 * the wires that caller can see, not the session's full set.
 */
export function inheritedToolGrant(
  caller: SessionRoot,
  fallback: KernelToolCatalogLike,
  job: { readonly tools?: readonly string[] | null; readonly inheritCallerTools?: boolean },
): { readonly tools: readonly string[]; readonly inheritCallerTools: boolean; readonly toolsOnly: boolean } {
  const tools = job.tools ?? [];
  if (job.inheritCallerTools !== true) return { tools, inheritCallerTools: false, toolsOnly: false };
  const spec = caller.agent.spec;
  const restricted = spec instanceof AskAgentSpec || spec.name !== "";
  if (!restricted) return { tools, inheritCallerTools: true, toolsOnly: false };
  const visible = (sessionCatalog(caller) ?? fallback).catalogWireNames();
  return { tools: [...new Set([...tools, ...visible])], inheritCallerTools: false, toolsOnly: true };
}

type KernelToolCatalogLike = { catalogWireNames(): readonly string[] };

const ASK_NEEDS_RESPONSE = "ask requires a response";
const SCHEMA_REQUIRES_ONE_SHOT_ASK = "Structured output schema can only be used with agent/ask";

export function callHost(host: AgentRuntimeHost): AgentCallHost {
  return {
    caller: host.caller,
    catalog: host.kernel.catalog,
    scope: {
      replica: (id) => host.kernel.sessionPlexus(id),
      abortJob: (id, job) => {
        const daemon = host.kernel.liveSession(id) ?? host.project.sessions[id];
        daemon?.orchestrator.abortJob(job);
      },
    },
  };
}

export function loadOpenCall(kernel: KernelDaemon, session: SessionRoot, uuid: string): CallJob | undefined {
  return loadOpenCallOnScope({ replica: (id) => kernel.sessionPlexus(id) }, session, uuid);
}

export function completeCallExceptionally(
  call: CallJob,
  host: AgentRuntimeHost,
  code: CallFailCode,
  message = "",
  abort?: (job: Job) => void,
): void {
  completeCallOnScope(call, callHost(host), code, message, abort);
}

export function sealCall(job: CallJob, code: CallFailCode, message = ""): void {
  job.settleResult(job.outcome ?? new FailureOutcome({ code, message }));
}

/**
 * The caller's worker id and the worker's callback row are the two halves of
 * a delegated grant. They land in one action, so a park between them cannot
 * strand the worker.
 */
function stampWorker<T>(job: CallJob, worker: SessionPlexus | undefined, callerSessionId: string, stamp: () => T): T {
  return runInAction(() => {
    const stamped = stamp();
    if (stamped !== false) worker?.root.ensureAgentCallback(job.uuid, callerSessionId);
    return stamped;
  });
}

/**
 * A worker's session id is a function of who asks for what, so a re-run after
 * a crash finds the same worker, and its callback row, instead of minting a
 * twin. The seed parts are opaque; the result has the minted ids' UUID form.
 */
function derivedSessionId(...seed: readonly string[]): string {
  const hex = createHash("sha256").update(seed.join("\0")).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function inheritWorkerRuntimeKv(worker: SessionRoot, host: AgentRuntimeHost): void {
  const sources = [host.caller.kvs, host.project.root.kvs, host.kernel.plexus.root.kvs];
  const proposals: Array<{ form: "kv-set"; key: string; value: string }> = [];
  if ((worker.kvs.connection ?? "").trim() === "") {
    for (const bag of sources) {
      const connection = (bag.connection ?? "").trim();
      if (connection !== "") {
        proposals.push({ form: "kv-set", key: "connection", value: connection });
        break;
      }
    }
  }
  if ((worker.kvs.model ?? "").trim() === "") {
    for (const bag of sources) {
      const model = (bag.model ?? "").trim();
      if (model !== "") {
        proposals.push({ form: "kv-set", key: "model", value: model });
        break;
      }
    }
  }
  if (proposals.length > 0) worker.applyKvs(proposals);
  if (delegatesPermissionMode(worker)) projectWorkerPermissions(worker, host.caller);
}

/** A worker that cannot pin its bot's behavior still runs, without it. */
async function workerPin(
  recipe: CatalogRecipe,
  host: AgentRuntimeHost,
): Promise<{ readonly pin: string; readonly revision: string }> {
  try {
    return await recipePin(recipe.spec.behavior, host.kernel.behavior.packages());
  } catch (error) {
    if (host.problem == null) fail(`plugin bot ${recipe.spec.name}`, error);
    else host.problem(`plugin bot ${recipe.spec.name}`, error);
    return { pin: "", revision: "" };
  }
}

/**
 * Record the plugin and program revision this call runs on, once. The revision
 * is what `isCallPaused` compares against the installed bot, so disabling the
 * plugin or editing its program pauses the call.
 */
function stampContribution(job: BotCallJob, recipe: CatalogRecipe, revision: string): void {
  if (job.contributionPluginName !== "" || revision === "") return;
  const plugin = recipe.spec.behavior?.plugin;
  if (typeof plugin !== "string" || plugin === "") return;
  job.stampContribution(plugin, recipe.spec.name, revision);
}

/**
 * The worker's place in the call tree. An agent spawn adds to `depth` and keeps the caller's bot
 * count; a bot hop adds to `botDepth` and keeps the caller's agent count. The call's own stamp is
 * the source, so a rerun after restart lands on the same numbers.
 */
function lineage(job: CallJob, caller: SessionRoot): { readonly depth: number; readonly botDepth: number } {
  const spec = caller.agent.spec;
  return job instanceof BotCallJob
    ? { depth: spec.depth, botDepth: job.depth }
    : { depth: job.depth, botDepth: spec.botDepth };
}

async function resolveWorker(
  recipe: CatalogRecipe,
  host: AgentRuntimeHost,
  job?: CallJob,
): Promise<{ readonly id: string; readonly revision: string }> {
  const bot = recipe.spec;
  const [roster, owner] =
    bot.recipeScope === "session"
      ? [host.caller.botsRoster, host.caller.sessionId]
      : bot.recipeScope === "project"
        ? [host.project.root.botsRoster, host.project.path]
        : [host.kernel.plexus.root.botsRoster, host.kernel.root];
  const id = roster[bot.name] ?? derivedSessionId(owner, bot.name);
  if (roster[bot.name] == null) roster[bot.name] = id;
  const worker = bot.recipeScope === "global" ? await host.kernel.globalSession(id) : await host.project.session(id);
  const spec = worker.root.agent.spec;
  const fresh = spec.name === "" && spec.behaviorPin.trim() === "";
  const pinned = fresh ? await workerPin(recipe, host) : undefined;
  if (spec.name === "") {
    spec.adoptNamedRecipe({
      name: bot.name,
      recipeScope: bot.recipeScope,
      keepAlive: bot.keepAlive,
      description: bot.description,
      instructions: bot.instructions,
      reasoningEffort: bot.reasoningEffort,
      behaviorPinJson: pinned == null ? null : pinned.pin,
    });
    // A bot thread runs in the kernel default mode, or the one the user pinned for this bot. A
    // session-scope bot follows its desk instead (`projectWorkerPermissions`).
    if (bot.recipeScope !== "session") {
      runInAction(() => {
        worker.root.standingPermissionMode = botPermissionMode(host.kernel.plexus.root, bot.name);
      });
    }
  }
  inheritWorkerRuntimeKv(worker.root, host);
  // A standing bot is reached from many places; each delivery records the hop it arrived by.
  if (job != null) {
    runInAction(() => {
      worker.root.agent.spec.depth = lineage(job, host.caller).depth;
      worker.root.agent.spec.botDepth = lineage(job, host.caller).botDepth;
    });
  }
  host.kernel.internSession(id, worker.plexus, worker);
  return { id, revision: pinned?.revision ?? "" };
}

async function resolveOneShotWorker(
  recipe: CatalogRecipe,
  host: AgentRuntimeHost,
  opts: {
    readonly readonly: boolean;
    readonly voidLegal: boolean;
    readonly workerSessionId?: string;
    readonly job: AgentCallJob | BotCallJob;
    /** The recipe's tools narrowed by a guard; the recipe adds nothing past them. */
    readonly tools?: readonly string[];
  },
): Promise<string> {
  const id = opts.workerSessionId || derivedSessionId(host.caller.sessionId, opts.job.uuid);
  const pinned = await workerPin(recipe, host);
  if (opts.job instanceof BotCallJob) stampContribution(opts.job, recipe, pinned.revision);
  const worker = await host.project.session(id);
  worker.root.agent.spec = new AskAgentSpec({
    name: recipe.spec.name,
    description: recipe.spec.description,
    instructions: recipe.spec.instructions || HARNESS_CONSTITUTION,
    readonly: opts.readonly,
    voidLegal: opts.voidLegal,
    ...lineage(opts.job, host.caller),
    keepAlive: false,
    reasoningEffort: recipe.spec.reasoningEffort,
    behaviorPinJson: pinned.pin,
    ...(opts.tools == null ? {} : { tools: opts.tools, toolsOnly: true }),
  });
  inheritWorkerRuntimeKv(worker.root, host);
  if (opts.job instanceof AgentCallJob) {
    const ref = opts.job.argString("model").trim();
    if (ref !== "") {
      const error = oneShotModelError(ref, host.kernel.plexus.root.connections);
      if (error !== "") {
        sealCall(opts.job, "bad_model", error);
        return id;
      }
      const parsed = parseModelRef(ref);
      if (parsed == null) {
        sealCall(opts.job, "bad_model", 'model must be "connection/model"');
        return id;
      }
      worker.root.applyKvs([
        { form: "kv-set", key: "connection", value: parsed.connection },
        { form: "kv-set", key: "model", value: parsed.model },
      ]);
    }
  }
  host.kernel.internSession(id, worker.plexus, worker);
  return id;
}

function loadCall(host: AgentRuntimeHost, callerSessionId: string, uuid: string): CallJob | undefined {
  const found = host.kernel.sessionPlexus(callerSessionId)?.loadEntity<CallJob>(uuid);
  return found instanceof CallJob ? found : undefined;
}

function validateTypedOutcome(call: CallJob, value: unknown, host: AgentRuntimeHost): unknown | null {
  const entry = host.kernel.catalog.catalogEntry(call.name);
  if (entry?.packMeta?.kind !== "bot-call") return null;
  const installed = host.kernel.catalog.pluginInstall.plugins.get(entry.packMeta.pluginName);
  const tool = installed == null ? undefined : botCallToolOf(installed, call.name);
  if (tool == null) return null;
  const parsed = tool.output.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function settleCallFromCallback(call: CallJob, job: AgentCallbackJob, host: AgentRuntimeHost): void {
  settleAcceptedCallback(call, job, (target, value) => validateTypedOutcome(target, value, host));
}

/**
 * Record how deep this call is and the cap in force, once, then refuse it when it is too deep.
 * The failure is the call's receipt, so the model reads why. Agent spawns and bot hops are
 * counted apart.
 */
function refuseDeep(job: CallJob, depth: number, limit: number, kind: "agent" | "bot"): boolean {
  job.stampDepth(depth, limit);
  const cap = job.depthLimit ?? 0;
  if (cap === 0 || job.depth <= cap) return false;
  const noun = kind === "agent" ? "agent depth (maxDepth)" : "bot depth (maxBotDepth)";
  sealCall(job, "depth_limit", `${noun} limit of ${cap} reached; this call would be ${job.depth} deep. Do the work yourself or return what you have.`);
  return true;
}

/** An agent call owns a disposable child, including when its recipe is named. */
export async function executeAgentCall(
  job: AgentCallJob,
  host: AgentRuntimeHost,
  /** Tools an agent guard narrowed a one-shot recipe call to. */
  tools?: readonly string[],
): Promise<void> {
  if (job.completed) return;
  if (job.name === AGENT_ASK || job.name === AGENT_SEND) {
    if (refuseDeep(job, host.caller.agent.spec.depth + 1, host.kernel.plexus.root.maxDepth, "agent")) return;
    const spec = job.argString("spec").trim();
    if (job.name === AGENT_SEND && spec === "") {
      sealCall(job, "spec_required", "spec required");
      return;
    }
    {
      const ref = job.argString("model").trim();
      if (ref !== "") {
        const pinned = oneShotModelError(ref, host.kernel.plexus.root.connections);
        if (pinned !== "") {
          sealCall(job, "bad_model", pinned);
          return;
        }
      }
    }
    let namedWorkerId: string;
    if (job.name === AGENT_ASK && spec === "") {
      if (job.workerSessionId) {
        namedWorkerId = job.workerSessionId;
      } else {
        const id = derivedSessionId(host.caller.sessionId, job.uuid);
        const worker = await host.project.session(id);
        const constitution = job.systemPrompt.trim();
        const faceName = (job.faceName ?? "").trim();
        const grant = inheritedToolGrant(host.caller, host.kernel.catalog, job);
        worker.root.agent.spec = new AskAgentSpec({
          name: faceName,
          readonly: job.readonly,
          ...lineage(job, host.caller),
          ...(constitution === "" ? {} : { instructions: asSystemPrompt(constitution) }),
          ...(job.reasoningEffort == null ? {} : { reasoningEffort: job.reasoningEffort }),
          tools: grant.tools,
          inheritCallerTools: grant.inheritCallerTools,
          toolsOnly: grant.toolsOnly,
        });
        inheritWorkerRuntimeKv(worker.root, host);
        host.kernel.internSession(id, worker.plexus, worker);
        namedWorkerId = id;
      }
    } else {
      const entry = host.kernel.catalog.catalogEntry(spec);
      if (entry != null && entry.packMeta?.kind === "bot-call") {
        sealCall(job, "host_tool", new AutonomousToolError(spec).message);
        return;
      }
      const namedCatalog = sessionCatalog(host.caller) ?? host.kernel.catalog;
      const namedRecipe = namedCatalog.recipe(spec);
      if (namedRecipe == null) {
        sealCall(job, "unknown_recipe", `unknown recipe ${spec}`);
        return;
      }
      if (job.responseSchema != null && job.name !== AGENT_ASK) {
        sealCall(job, "schema_requires_one_shot", SCHEMA_REQUIRES_ONE_SHOT_ASK);
        return;
      }
      const namedDenied = invokeDenied(namedCatalog.allRecipes(), host.caller.agent.spec.name, namedRecipe.spec.name);
      if (namedDenied != null) {
        sealCall(job, "denied", namedDenied);
        return;
      }
      namedWorkerId =
        job.workerSessionId ||
        (await resolveOneShotWorker(namedRecipe, host, {
          readonly: job.readonly,
          voidLegal: job.voidLegal,
          workerSessionId: job.workerSessionId,
          job,
          tools,
        }));
    }
    if (job.completed) return;
    const worker = await host.kernel.acquireSession(namedWorkerId);
    stampWorker(job, worker, host.caller.sessionId, () => {
      job.workerSessionId = namedWorkerId;
    });
    // The derived worker id needs no caller write first; the enqueue is the durable delivery.
    await host.kernel.broadcastAgentRequest(namedWorkerId, job.uuid, host.caller.sessionId, job.speech);
    const delivered = host.kernel.sessionPlexus(namedWorkerId) ?? worker;
    if (delivered != null) await host.kernel.flushSession(delivered);
    return;
  }
  sealCall(job, "unknown_recipe", "unknown recipe");
}

/** Deliver into the worker's document; the caller neither persists first nor waits on processing. */
export async function executeBotCall(job: BotCallJob, host: AgentRuntimeHost): Promise<void> {
  if (job.completed) return;
  const packEntry = host.kernel.catalog.catalogEntry(job.name);
  const meta = packEntry?.packMeta?.kind === "bot-call" ? packEntry.packMeta : undefined;
  if (isCallPaused(job, host.kernel.catalog)) return;
  if (refuseDeep(job, host.caller.agent.spec.botDepth + 1, host.kernel.plexus.root.maxBotDepth, "bot")) return;
  const catalog = sessionCatalog(host.caller) ?? host.kernel.catalog;
  const recipe = catalog.recipe(job.botName || job.contributionBotName || meta?.target || job.argString("spec").trim());
  if (recipe == null) {
    sealCall(
      job,
      "unknown_recipe",
      meta == null ? `unknown recipe ${job.botName || job.argString("spec").trim()}` : "unknown recipe",
    );
    return;
  }
  const denied = invokeDenied(catalog.allRecipes(), host.caller.agent.spec.name, recipe.spec.name);
  if (denied != null) {
    sealCall(job, "denied", denied);
    return;
  }
  const installed = meta == null ? undefined : host.kernel.catalog.pluginInstall.plugins.get(meta.pluginName);
  const tool = installed == null ? undefined : botCallToolOf(installed, job.name);
  const invocationScoped =
    installed?.definition.bots.some((bot) => bot.name === recipe.spec.name && bot.recipeScope === "invocation") ===
    true;
  if (tool?.lifetime != null) stampCallLifetime(job, tool.lifetime);
  if (job.responseSchema != null && !invocationScoped) {
    sealCall(job, "schema_requires_one_shot", SCHEMA_REQUIRES_ONE_SHOT_ASK);
    return;
  }
  const workerId =
    job.workerSessionId ||
    (invocationScoped
      ? await resolveOneShotWorker(recipe, host, {
          readonly: job.readonly,
          voidLegal: job.voidLegal,
          job,
        })
      : await (async () => {
          const resolved = await resolveWorker(recipe, host, job);
          stampContribution(job, recipe, resolved.revision);
          return resolved.id;
        })());
  if (job.completed) return;
  let prepared: unknown;
  if (job.acceptedAt != null && job.preparedDocument) {
    prepared = job.preparedInput;
  } else {
    const args = job.args ?? {};
    const ctx = pluginCallContextOf(host.caller, job);
    const lifetime = tool?.lifetime === "turn" ? "turn" : "call";
    const parsedInput = tool?.input.parse(args) ?? args;
    prepared =
      tool?.type === "bot-call"
        ? (tool.prepare?.(
            parsedInput,
            isModelOriginContext(ctx) &&
              ctx.completion instanceof CompletionExpectation &&
              ctx.invocation instanceof ToolCallJob
              ? {
                  ...ctx,
                  source: buildSourceCut(
                    host.caller,
                    ctx.completion,
                    ctx.invocation,
                    job.name,
                    job.args,
                    sourceCutCharLimit(lifetime),
                  ),
                }
              : ctx,
          ) ?? parsedInput)
        : parsedInput;
  }
  if (job.completed) return;
  if (isCallPaused(job, host.kernel.catalog)) return;
  const worker = host.kernel.sessionPlexus(workerId);
  if (worker == null) {
    sealCall(job, "worker_missing", `worker session ${workerId} missing`);
    return;
  }
  inheritWorkerRuntimeKv(worker.root, host);
  const message =
    meta == null
      ? prepared != null &&
        typeof prepared === "object" &&
        "message" in prepared &&
        typeof prepared.message === "string"
        ? prepared.message
        : ""
      : renderBotCallWorkerPrompt(job.name, prepared, job.uuid);
  // Delivery is the enqueue into the worker, keyed by this call; the
  // worker's callback row records it. Both halves land in one action.
  const delivered = runInAction(() => {
    if (!job.acceptPreparedInput(prepared, workerId)) return false;
    if (worker.root.agentCallbacks[job.uuid] == null && worker.root.findTurnByAgentRequestId(job.uuid) == null) {
      worker.root.enqueueAgentRequest(job.uuid, host.caller.sessionId, asUserPrompt(message));
    }
    return true;
  });
  if (!delivered) return;
  await host.kernel.flushSession(worker);
  markDelivered(job);
}

/** A worker's respond or void settles the caller's call, then releases the worker's loop. */
export async function settleAgentCallback(
  job: AgentCallbackJob,
  host: AgentRuntimeHost,
  abortWork: (node: Job) => void,
): Promise<void> {
  const requestId = job.argString("requestId");
  const callerId = host.caller.agentCallbacks[requestId];
  if (callerId == null) return;
  const call = loadCall(host, callerId, requestId);
  if (call == null) {
    job.outcomeSnap ??= { ok: false, text: "caller not attached" };
    return;
  }
  if (!call.completed) {
    let reject: string | null = null;
    if (!call.voidLegal) {
      if (job.name === AGENT_VOID) reject = ASK_NEEDS_RESPONSE;
      else {
        const args = job.args ?? {};
        if (
          !("value" in args && validateTypedOutcome(call, args.value, host) != null) &&
          job.argString("response").trim() === ""
        ) {
          reject = ASK_NEEDS_RESPONSE;
        }
      }
    }
    if (reject != null) {
      job.outcomeSnap = { ok: false, text: reject };
      return;
    }
    settleCallFromCallback(call, job, host);
    const callerPlexus = host.kernel.sessionPlexus(callerId);
    if (callerPlexus != null) await host.kernel.flushSession(callerPlexus);
  }
  host.caller.removeAgentCallback(requestId);
  job.outcomeSnap ??= { ok: true };
  forceStopLoop(
    host.caller,
    abortWork,
    job,
    (nested) => completeCallExceptionally(nested, host, "rejected"),
    host.kernel.catalog,
  );
}

export function notifyAgentCall(job: AgentNotifyJob, host: AgentRuntimeHost): void {
  const requestId = job.argString("requestId");
  const callerId = host.caller.agentCallbacks[requestId];
  if (callerId == null) return;
  const call = loadCall(host, callerId, requestId);
  if (call == null) return;
  if (!agentCallSupportsNotify(host.kernel.catalog, call.name)) return;
  call.notifications.push(new AgentCallNotification({ message: job.argString("message") }));
  job.outcomeSnap ??= { ok: true };
}

/** A message lands as an inbound turn on the target and opens no callback. */
export async function deliverAgentMessage(
  job: AgentMessageJob,
  host: AgentRuntimeHost,
  signal: AbortSignal,
): Promise<void> {
  const targetIdArg = job.argString("targetId");
  const targetName = job.argString("targetName");
  const agentScope = host.caller.agent.spec.recipeScope;
  const roster =
    agentScope === "project"
      ? host.project.root.botsRoster
      : agentScope === "global"
        ? host.kernel.plexus.root.botsRoster
        : host.caller.botsRoster;
  const byName = targetName === "" ? undefined : roster[targetName];
  const targetId = targetIdArg === "" ? byName : targetIdArg;
  if (targetId == null || targetId === "") {
    job.outcomeSnap = { ok: false, text: "undeliverable" };
    return;
  }
  const target = host.kernel.sessionPlexus(targetId);
  if (target == null) {
    job.outcomeSnap = { ok: false, text: "undeliverable" };
    return;
  }
  if (host.kernel.liveSession(targetId) == null) {
    if (target.root.agent.spec.recipeScope === "global") await host.kernel.globalSession(targetId);
    else await host.project.session(targetId);
  }
  // A message has no reply, so the request opens no callback.
  target.root.enqueueAgentRequest(
    job.uuid,
    host.caller.sessionId,
    asUserPrompt(`message from ${host.caller.sessionId}: ${job.argString("message")}`),
    { callback: false },
  );
  await host.kernel.flushSession(target);
  if (signal.aborted) return;
  job.outcomeSnap = { ok: true };
}
