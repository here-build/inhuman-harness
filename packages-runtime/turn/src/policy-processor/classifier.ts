/**
 * Remainder-classifier handle. Auto ask (floor ask + hatch). Cache is
 * remainder skip. Empty connection or model gates the classifier, not
 * identity — `dotprompt/run` requires both, and a run plan with one
 * missing retries the invariant forever.
 * `start` owns the run-plan reaction; minting does not begin I/O.
 * Eligibility lives on the scope key set — this handle re-runs when the
 * plan inputs change. Timer ticks are events (backoff). Floor `block`
 * never mints these. Cluster ports share this handle. Classifier
 * prompt files load on first require, not at import.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  disposeRunContext,
  execState,
  jsToScheme,
  makeCallCtx,
  parse,
  toJS,
  type RunContext,
  type SchemeValue,
} from "@here.build/arrival";
import { applyCallback } from "@here.build/arrival/host-internals";
import { ASymbol } from "@here.build/arrival/reflect-internals";
import { loaderFromResolver } from "@here.build/arrival-modules";
import { DefaultedMap } from "@here.build/collections";
import { promptIsolatedCapability } from "@inhuman.tools/env-capability-module-prompt";
import {
  fileQuestion,
  isJsonSchemaUnsupported,
  JUDGE_FAILS_FINAL,
  MCPToolJob,
  type ToolCallJob,
  clusterOf,
  ruleStampFor,
  workspacePath,
} from "@inhuman.tools/harness-model";
import { classifierResources, policyEnvCapability } from "@inhuman.tools/policy/floor";
import { parseTirithEvidence, tirithCoverage } from "@inhuman.tools/policy-tirith";
import { action, comparer, type IReactionDisposer, observable, reaction, runInAction } from "mobx";

import { classifierArgs } from "./cluster.js";
import { evidenceCuts, evidenceIdentity } from "./evidence.js";
import type { BypassSections } from "./bypass.js";
import type { LicenseScope } from "./scope.js";
import {
  buildSoftDenySections,
  identityTokens,
  parseSoftDenyVote,
  type SoftDenyCheck,
  type SoftDenyOutcome,
  type SoftDenySections,
} from "./soft-deny.js";

function trace(name: string, message: string): void {
  const debug = process.env.DEBUG;
  if (debug == null) return;
  const parts = debug.trim() === "" ? ["*"] : debug.split(/[\s,]+/).filter((part) => part !== "");
  const on = parts.some((part) => {
    if (part.startsWith("-")) return false;
    if (part === "*" || part === name) return true;
    if (part.endsWith("*")) return name.startsWith(part.slice(0, -1));
    return name.startsWith(`${part}:`);
  });
  if (!on) return;
  process.stderr.write(`${name} ${message}\n`);
}

/**
 * Every remainder attempt is deadline-bounded. The first is short because the
 * first vote is what the human is waiting on — a miss must open the approval
 * window fast. Retries get longer: a slow-but-live model may still deliver a
 * late allow, and the loop never gives up (overnight runs rely on that). But no
 * attempt may run unbounded — with `scope.cap` a stuck classifier squatting a slot
 * starves every job behind it, which is the hang.
 *
 * Below the stall timer on purpose: a live stream that trickles a token every
 * few minutes resets the stall timer forever, so the wall clock is the only
 * bound that fires.
 */
export const FIRST_ATTEMPT_MS = 12_000;
export const RETRY_ATTEMPT_MS = 5 * 60_000;

type ClassifierVote =
  { readonly decision: "allow" | "deny"; readonly reason?: string; readonly round?: 1 | 2 } | { readonly fail: string };

function voteOf(value: unknown): ClassifierVote {
  switch (typeof value) {
    case "string":
      switch (value) {
        case "allow":
        case "deny":
          return { decision: value };
        default:
          return value.trim() === "" ? { fail: "classifier did not vote" } : { fail: value };
      }
    case "object": {
      if (value === null || Array.isArray(value)) return { fail: "classifier did not vote" };
      const rec = value as Record<string, unknown>;
      const decision = rec.decision ?? rec[":decision"];
      switch (decision) {
        case "allow":
        case "deny":
          return { decision };
        default:
          return { fail: "classifier did not vote" };
      }
    }
    default:
      return { fail: "classifier did not vote" };
  }
}

async function applyClassifier(
  runCtx: RunContext,
  fn: Parameters<typeof applyCallback>[0],
  args: unknown[],
): Promise<unknown> {
  const boxed = applyCallback(
    fn,
    args.map((value) => jsToScheme(runCtx, value) as SchemeValue),
    makeCallCtx(runCtx),
  );
  const signal = runCtx.signal;
  if (signal === undefined || signal.aborted) return toJS(await boxed);
  const gate = new AbortController();
  const winner = AbortSignal.any([signal, gate.signal]);
  const abort = new Promise<never>((_resolve, reject) => {
    winner.addEventListener(
      "abort",
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("classifier aborted"));
      },
      { once: true },
    );
  });
  try {
    return toJS(await Promise.race([Promise.resolve(boxed), abort]));
  } finally {
    gate.abort();
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const classifierCache = new DefaultedMap((p: string): string => {
  switch (p) {
    case "classifier-bash.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-bash.prompt"), "utf8");
    case "classifier-read.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-read.prompt"), "utf8");
    case "classifier-write.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-write.prompt"), "utf8");
    case "classifier-write-outside.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-write-outside.prompt"), "utf8");
    case "classifier-write-workspace.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-write-workspace.prompt"), "utf8");
    case "classifier-write-risky.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-write-risky.prompt"), "utf8");
    case "classifier-mcp.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-mcp.prompt"), "utf8");
    case "classifier-bash-incomplete.prompt":
      return readFileSync(path.join(here, "../../policy/classifier-bash-incomplete.prompt"), "utf8");
    case "soft-deny-round1.prompt":
      return readFileSync(path.join(here, "../../policy/soft-deny-round1.prompt"), "utf8");
    case "soft-deny-round2.prompt":
      return readFileSync(path.join(here, "../../policy/soft-deny-round2.prompt"), "utf8");
    case "bypass-detect.prompt":
      return readFileSync(path.join(here, "../../policy/bypass-detect.prompt"), "utf8");
    default:
      throw new Error(`no such file: ${p}`);
  }
});

export const classifierFiles = loaderFromResolver((p) => classifierCache.get(p));

export type ClassifierRouteOpts = {
  /** Kernel last-choice. Session mint is a snapshot; this overlay is live. */
  readonly fallback?: Readonly<Record<string, string>>;
  /** Connection `settings.model` when the judge wire is named but `judgeModel` is empty. */
  readonly configuredModel?: (connectionId: string) => string;
};

export function classifierRoute(
  kvs: Readonly<Record<string, string>>,
  opts?: ClassifierRouteOpts,
): {
  readonly connection: string;
  readonly model: string;
  readonly key: string;
} {
  const fallback = opts?.fallback ?? {};
  const connection = (kvs.judgeConnection || fallback.judgeConnection || kvs.connection || "").trim();
  const judgeModel = (kvs.judgeModel || fallback.judgeModel || "").trim();
  const configured = connection !== "" && opts?.configuredModel != null ? opts.configuredModel(connection).trim() : "";
  const model = (judgeModel || configured || kvs.model || "").trim();
  return { connection, model, key: `${connection}\n${model}` };
}

type ClassifierPlan =
  | { readonly kind: "cache"; readonly decision: "allow" | "deny"; readonly attempt: number }
  | {
      readonly kind: "literal";
      readonly decision: "allow" | "deny";
      readonly identity: string;
      readonly attempt: number;
    }
  | { readonly kind: "verdict"; readonly decision: "allow" | "deny"; readonly reason: string; readonly attempt: number }
  | { readonly kind: "noprogram"; readonly attempt: number }
  | { readonly kind: "halt"; readonly attempt: number }
  | { readonly kind: "noconnect"; readonly attempt: number }
  | { readonly kind: "empty"; readonly attempt: number }
  | { readonly kind: "unread"; readonly source: string; readonly attempt: number }
  | {
      readonly kind: "run";
      readonly source: string;
      readonly connection: string;
      readonly model: string;
      readonly attempt: number;
      readonly identity: string;
      readonly privileged: string;
      readonly priorTurn: string;
      readonly quarantined: string;
      readonly policy: string;
      readonly margin: number;
      /** Set for the soft-deny judge: the host drives its rounds and verifies the vote. */
      readonly soft?: SoftDenyPlan;
    };

type SoftDenyPlan = {
  readonly sections: SoftDenySections;
  readonly check: SoftDenyCheck;
  readonly rounds: 1 | 2;
  readonly unattended: boolean;
  readonly hasAgentAnswer: boolean;
  readonly callTier: string;
  readonly callClasses: string;
  readonly callRules: string;
};

type ProgramRead = { readonly state: "forms"; readonly forms: readonly SchemeValue[] } | { readonly state: "broken" };

const programReads = observable.map<string, ProgramRead>({}, { deep: false });
const programReadsStarted = new Set<string>();

function startProgramRead(source: string): void {
  if (programReadsStarted.has(source)) return;
  programReadsStarted.add(source);
  void parse(source).then(
    (forms) => runInAction(() => programReads.set(source, { state: "forms", forms })),
    () => runInAction(() => programReads.set(source, { state: "broken" })),
  );
}

/** One symbol. The reader has already dropped comments. A string `"allow"` is not this. */
function literalOf(forms: readonly SchemeValue[]): "allow" | "deny" | undefined {
  const form = forms.length === 1 ? forms[0] : undefined;
  if (!(form instanceof ASymbol)) return undefined;
  return form.__name__ === "allow" || form.__name__ === "deny" ? form.__name__ : undefined;
}

/** The owner's `describe` for an MCP call, from the session's layers (a project file's words are not included). */
function ownerDescription(job: ToolCallJob): string | undefined {
  if (job.authCluster !== "mcp") return undefined;
  return ruleStampFor(job.authorizationLayers, job.callSubject).describe;
}

function remainderPlan(scope: LicenseScope, job: ToolCallJob, attempt: number): ClassifierPlan {
  const source = scope.root.judgeAskProgram;
  const route = classifierRoute(scope.root.kvs, {
    fallback: scope.judgeFallbackKvs,
    configuredModel: scope.judgeConfiguredModel,
  });
  const cuts = evidenceCuts(job);
  const identity = evidenceIdentity(cuts);
  const cached = scope.remainderHit(job, identity);
  if (cached !== null) return { kind: "cache", decision: cached, attempt };
  const soft = job.judgeKind === "soft-deny";
  const resolver = job.resolution?.resolver;
  const params = resolver?.kind === "judge" ? resolver.params : {};
  // No user words, no explicit request: nothing to ask a model.
  if (soft && (cuts.userMessages ?? []).length === 0) {
    return { kind: "verdict", decision: "deny", reason: "no user message asks for this", attempt };
  }
  const read = programReads.get(source);
  if (read === undefined) return { kind: "unread", source, attempt };
  if (read.state === "forms") {
    const decision = literalOf(read.forms);
    // A literal program is the ask judge's shortcut. It is never a soft-deny license: the host must
    // see the user's words, so only a literal deny applies here.
    if (decision !== undefined && (!soft || decision === "deny"))
      return { kind: "literal", decision, identity, attempt };
    if (decision !== undefined) return { kind: "noprogram", attempt };
    // No forms is the empty result exec returns. A top-level define is #<void>, not empty.
    if (read.forms.length === 0) return { kind: "empty", attempt };
  }
  if (scope.schemaHaltKeys.has(route.key)) return { kind: "halt", attempt };
  if (route.connection === "" || route.model === "") return { kind: "noconnect", attempt };
  if (source.trim() === "") return { kind: "empty", attempt };
  const base = {
    kind: "run" as const,
    source,
    connection: route.connection,
    model: route.model,
    attempt,
    identity,
    privileged: cuts.privileged,
    priorTurn: cuts.priorTurn,
    quarantined: cuts.quarantined,
    policy: cuts.policy ?? "",
    margin: params.margin ?? 0,
  };
  if (!soft) return base;
  const layer = job.resolution?.layer;
  const rounds = (params.rounds ?? 2) as 1 | 2;
  const unattended = job.unattended;
  const userMessages = cuts.userMessages ?? [];
  const agentAnswer = cuts.agentAnswer ?? "";
  const votes = job.policyVotes as unknown as Parameters<typeof identityTokens>[0]["votes"];
  const cluster = clusterOf(job.name);
  const sections = buildSoftDenySections({
    classes: job.policyClasses as Parameters<typeof buildSoftDenySections>[0]["classes"],
    votes,
    userMessages,
    agentAnswer,
    allowAgentAnswer: rounds === 2 && !unattended,
    tool: job.name,
    cluster,
    args: job.args,
    describe: ownerDescription(job),
  });
  const tokens = identityTokens({
    cluster,
    tool: job.name,
    args: job.args as Readonly<Record<string, unknown>> | null,
    votes,
    serverToolName: job instanceof MCPToolJob ? job.serverToolName : undefined,
  });
  return {
    ...base,
    soft: {
      sections,
      rounds,
      unattended,
      hasAgentAnswer: sections.agentAnswerJson !== "",
      callTier: "soft-deny",
      callClasses: job.policyClasses.join(","),
      callRules: votes.map((vote) => vote.ruleId).join(","),
      check: {
        userMessages,
        agentAnswer,
        identityTokens: tokens,
        // Only a layer the human wrote may turn the quote check off.
        requireQuote: !(
          params.requireQuote === false &&
          (layer === "user" || layer === "session" || layer === "managed")
        ),
        margin: params.margin ?? 0,
      },
    },
  };
}

/**
 * One bypass-check attempt: the program's `bypass/judge` sink, applied once, under the per-attempt
 * deadline. Throws on any failure (no connection, no sink, timeout, a crash); the caller decides what
 * a failed check means. The parent job is the denied call that triggered the check, which is still open.
 */
export async function runBypassJudge(
  scope: LicenseScope,
  job: ToolCallJob,
  sections: BypassSections,
): Promise<unknown> {
  const source = scope.root.judgeAskProgram;
  const route = classifierRoute(scope.root.kvs, {
    fallback: scope.judgeFallbackKvs,
    configuredModel: scope.judgeConfiguredModel,
  });
  if (route.connection === "" || route.model === "") throw new Error("no model connection");
  if (scope.schemaHaltKeys.has(route.key)) throw new Error("json_schema unsupported");
  if (source.trim() === "") throw new Error("auto-mode classifier program is empty");
  const attemptMs = scope.judgeDeadlineMs(0);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error(`bypass check timed out after ${attemptMs}ms`)), attemptMs);
  deadline.unref();
  try {
    const cuts = evidenceCuts(job);
    const state = await execState(source, {
      capabilities: [policyEnvCapability, promptIsolatedCapability],
      signal: abort.signal,
      config: {
        privileged: cuts.privileged,
        taskJson: sections.taskJson,
        restrictionsJson: sections.restrictionsJson,
        callsJson: sections.callsJson,
        hintsJson: sections.hintsJson,
        notesJson: sections.notesJson,
        loader: classifierFiles,
        job,
        connectionId: route.connection,
        completionModel: route.model,
        complete: scope.complete,
      },
    });
    try {
      const fn = classifierResources(state.runCtx).bypass;
      if (fn === undefined) throw new Error("no bypass/judge sink in the classifier program");
      return await applyClassifier(state.runCtx, fn, []);
    } finally {
      await disposeRunContext(state.runCtx);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (isJsonSchemaUnsupported(text)) scope.schemaHaltKeys.add(route.key);
    throw error;
  } finally {
    clearTimeout(deadline);
    if (!abort.signal.aborted) abort.abort();
  }
}

export class ClassifierHandle {
  @observable accessor attempt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attemptAbort: AbortController | undefined;
  #stop: IReactionDisposer | undefined;
  #seq = 0;

  constructor(
    readonly job: ToolCallJob,
    readonly scope: LicenseScope,
  ) {}

  async #classifierApplyArgs(): Promise<unknown[] | undefined> {
    const args = classifierArgs(this.job.name, this.job.args);
    if (args === undefined) return undefined;
    const cluster = clusterOf(this.job.name);
    if (cluster === "write") {
      const question = fileQuestion(this.job.name, this.job.args ?? undefined);
      if (question == null) return undefined;
      const source =
        this.scope.root.policyProgram.trim() === "" ? this.scope.distSource() : this.scope.root.policyProgram;
      const policy = await this.scope.compiledPolicy(source);
      // A floor deny names its remainder kind; an ordinary in-tree ask is judged on the task.
      const kind =
        policy.writeKind(workspacePath(this.scope.root.path, question)) ??
        (this.job.policyResult === "ask" ? "workspace" : "outside");
      return [...args, kind];
    }
    if (cluster === "mcp") {
      const describe = ownerDescription(this.job);
      if (describe === undefined) return args;
      // The program appends the second string under the operation: a labelled owner note, JSON-encoded.
      return [args[0], `${String(args[1])}\nOWNER NOTE (written by the policy owner, not the agent): ${JSON.stringify(describe)}`];
    }
    if (cluster === "bash") {
      const report = parseTirithEvidence(this.job.policyEvidenceJson);
      if (report != null && tirithCoverage(report) === "incomplete") return [...args, "incomplete"];
    }
    return args;
  }

  @action
  start(): void {
    if (this.#stop !== undefined || this.scope.closed) return;
    this.#stop = reaction(
      (): ClassifierPlan => remainderPlan(this.scope, this.job, this.attempt),
      async (plan) => {
        this.#clearTimer();
        const seq = ++this.#seq;
        const jobId = this.job.toolCallId || this.job.name;
        trace(
          "harness:judge",
          `plan ${plan.kind} job=${jobId} tool=${this.job.name} attempt=${plan.attempt}${plan.kind === "run" ? ` model=${plan.model}` : ""}`,
        );
        switch (plan.kind) {
          case "cache":
            runInAction(() => {
              if (this.job.classifierResult !== null) return;
              this.job.classifierResult = plan.decision;
              if (plan.decision === "deny" && this.job.judgeKind === "soft-deny") {
                this.job.judgeReason = "already denied this turn";
              }
            });
            return;
          case "verdict":
            runInAction(() => {
              if (this.job.classifierResult !== null) return;
              this.job.classifierResult = plan.decision;
              this.job.judgeReason = plan.reason;
            });
            return;
          case "noprogram":
            this.writeFailSticky(
              "auto-mode classifier program has no soft-deny sink (soft-deny/<cluster>); a person decides",
            );
            return;
          case "literal":
            runInAction(() => {
              if (this.job.classifierResult !== null) return;
              this.job.classifierResult = plan.decision;
              this.scope.remainderStore(this.job, plan.identity, plan.decision);
            });
            return;
          case "halt":
            this.writeFailSticky("json_schema unsupported: auto mode needs a model that supports structured output");
            return;
          case "noconnect":
            this.writeFail("no model connection");
            return;
          case "empty":
            // An empty program can never vote. Abstain so the call reaches the human
            // cover (and the diagnostic is shown) instead of waiting forever.
            this.writeFailSticky(
              "auto-mode classifier program is empty or unreadable (check autoModeClassifier in config.json)",
            );
            return;
          case "unread":
            startProgramRead(plan.source);
            return;
          case "run":
            break;
        }
        const started = Date.now();
        const attemptMs = this.scope.judgeDeadlineMs(plan.attempt);
        this.#attemptAbort = new AbortController();
        const attemptAbort = this.#attemptAbort;
        const deadline = setTimeout(() => {
          attemptAbort.abort(new Error(`classifier timed out after ${attemptMs}ms`));
        }, attemptMs);
        deadline.unref();
        try {
          let vote: ClassifierVote = { fail: "classifier did not vote" };
          let state;
          try {
            state = await execState(plan.source, {
              capabilities: [policyEnvCapability, promptIsolatedCapability],
              signal: attemptAbort.signal,
              config: {
                privileged: plan.privileged,
                priorTurn: plan.priorTurn,
                quarantined: plan.quarantined,
                policy: plan.policy,
                riskMargin: plan.margin,
                ...(plan.soft === undefined
                  ? {}
                  : {
                      floorJson: plan.soft.sections.floorJson,
                      userJson: plan.soft.sections.userJson,
                      callJson: plan.soft.sections.callJson,
                      agentAnswerJson: plan.soft.sections.agentAnswerJson,
                      callTier: plan.soft.callTier,
                      callClasses: plan.soft.callClasses,
                      callRules: plan.soft.callRules,
                    }),
                loader: classifierFiles,
                job: this.job,
                connectionId: plan.connection,
                completionModel: plan.model,
                complete: this.scope.complete,
              },
            });
          } catch (error) {
            vote = { fail: error instanceof Error ? error.message : String(error) };
          }
          if (state !== undefined) {
            try {
              const cluster = clusterOf(this.job.name);
              if (plan.soft !== undefined) {
                vote = await this.#softDeny(state.runCtx, cluster, plan.soft);
              } else {
                const fn = classifierResources(state.runCtx)[cluster];
                if (fn === undefined) {
                  vote = { fail: `no classifier/${cluster}` };
                } else {
                  const args = await this.#classifierApplyArgs();
                  vote =
                    args === undefined
                      ? { fail: "classifier did not vote" }
                      : voteOf(await applyClassifier(state.runCtx, fn, args));
                }
              }
            } finally {
              await disposeRunContext(state.runCtx);
            }
          }
          if (seq !== this.#seq) {
            trace("harness:judge", `stale job=${jobId} ms=${Date.now() - started}`);
            return;
          }
          runInAction(() => {
            if (this.job.classifierResult !== null) return;
            if ("fail" in vote) {
              trace("harness:judge", `fail job=${jobId} ms=${Date.now() - started} ${vote.fail}`);
              if (isJsonSchemaUnsupported(vote.fail)) {
                this.scope.schemaHaltKeys.add(`${plan.connection}\n${plan.model}`);
                this.writeFailSticky(vote.fail);
                return;
              }
              this.writeFail(vote.fail);
              return;
            }
            trace("harness:judge", `vote ${vote.decision} job=${jobId} ms=${Date.now() - started}`);
            this.job.classifierResult = vote.decision;
            if (vote.reason !== undefined) this.job.judgeReason = vote.reason;
            if (vote.round !== undefined) this.job.softDenyRound = vote.round;
            this.scope.remainderStore(this.job, plan.identity, vote.decision);
          });
        } catch (error) {
          if (seq !== this.#seq) return;
          trace(
            "harness:judge",
            `throw job=${jobId} ms=${Date.now() - started} ${error instanceof Error ? error.message : String(error)}`,
          );
          runInAction(() => {
            const text = error instanceof Error ? error.message : String(error);
            if (isJsonSchemaUnsupported(text)) {
              this.scope.schemaHaltKeys.add(`${plan.connection}\n${plan.model}`);
              this.writeFailSticky(text);
              return;
            }
            this.writeFail(text);
          });
        } finally {
          clearTimeout(deadline);
          if (!attemptAbort.signal.aborted) attemptAbort.abort();
          if (this.#attemptAbort === attemptAbort) this.#attemptAbort = undefined;
        }
      },
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  dispose(): void {
    this.#seq += 1;
    this.#clearTimer();
    this.#attemptAbort?.abort();
    this.#attemptAbort = undefined;
    this.#stop?.();
    this.#stop = undefined;
  }

  /**
   * The soft-deny rounds. The program's sink is applied with the round; the host parses and verifies
   * each vote (quote, identity of the action, risk x authorization). Round 2 runs only when round 1
   * asked for the agent's last answer, the cell allows two rounds, one exists, and a person is watching.
   */
  async #softDeny(
    runCtx: RunContext,
    cluster: ReturnType<typeof clusterOf>,
    plan: SoftDenyPlan,
  ): Promise<ClassifierVote> {
    const fn = classifierResources(runCtx).softDeny[cluster];
    if (fn === undefined) return { fail: `no soft-deny/${cluster}` };
    const first = parseSoftDenyVote(await this.#applySoft(runCtx, fn, 1), 1, plan.check);
    const settle = (outcome: SoftDenyOutcome, round: 1 | 2): ClassifierVote => {
      if (outcome.kind === "fail") return { fail: outcome.reason };
      if (outcome.kind === "need-agent-answer") return { decision: "deny", reason: outcome.reason, round };
      return { decision: outcome.decision, reason: outcome.reason, round: outcome.round };
    };
    if (first.kind !== "need-agent-answer") return settle(first, 1);
    if (plan.rounds === 1 || plan.unattended || !plan.hasAgentAnswer) {
      return {
        decision: "deny",
        reason: plan.hasAgentAnswer ? first.reason : "confirmation with no proposal to refer to",
        round: 1,
      };
    }
    return settle(parseSoftDenyVote(await this.#applySoft(runCtx, fn, 2), 2, plan.check), 2);
  }

  async #applySoft(runCtx: RunContext, fn: Parameters<typeof applyCallback>[0], round: 1 | 2): Promise<unknown> {
    return await applyClassifier(runCtx, fn, [round]);
  }

  @action
  writeFail(text: string): void {
    if (this.job.classifierResult !== null) return;
    if (text.trim() !== "") this.job.classifierAbstain = text;
    this.job.judgeFails += 1;
    if (this.scope.closed) return;
    this.#clearTimer();
    const n = this.attempt + 1;
    this.#timer = setTimeout(
      action("judgeBackoff", () => {
        this.#timer = undefined;
        this.attempt = n;
      }),
      this.scope.backoffMs(n),
    );
  }

  @action
  writeFailSticky(text: string): void {
    if (this.job.classifierResult !== null) return;
    if (text.trim() !== "") this.job.classifierAbstain = text;
    this.job.judgeFails = JUDGE_FAILS_FINAL;
    this.#clearTimer();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
