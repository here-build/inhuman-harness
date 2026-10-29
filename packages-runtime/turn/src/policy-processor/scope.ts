/**
 * Session-global license intern. Cap, compiled Policy, and handles are
 * not per-call. Eligibility computeds name the live key sets; kick
 * reactions `get`+`start` those handles. `license` only waits LICENSE WHEN.
 *
 * The floor stamps a tier, the classes that voted, and the votes. What licenses a soft-deny or an
 * ask is the resolution table (harness-model authorization/resolve.ts), read by the job. The grant
 * check (a stored human "yes" to an ask, by family) runs here at floor time, because it needs a
 * clock and the floor votes. A grant never covers a soft-deny, a block, a hatch or a lifted ask.
 */

import nodePath from "node:path";

import { DefaultedMap, DefaultedWeakMap } from "@here.build/collections";
import type { PromptComplete } from "@inhuman.tools/env-capability-module-prompt";
import {
  type AckCall,
  type AckState,
  ACKED_ONCE,
  activeAcks,
  classifyMcpToolName,
  clusterOf,
  collectAckFlags,
  coveringGrants,
  fileQuestion,
  type GrantRow,
  MCPToolJob,
  matchAckFlags,
  owningTurnId,
  parseGrantRows,
  readRootList,
  resolveAcks,
  type RuleStamp,
  ruleStampFor,
  rowKind,
  type SessionRoot,
  type SessionTurn,
  type ToolCallJob,
  userEpoch,
  visibleRows,
  workspacePath,
} from "@inhuman.tools/harness-model";
import {
  APPROVE,
  bindPolicy,
  cast,
  classesOf,
  join,
  reasonableDefaultsSource,
  whichOnPath,
  type ClassId,
  type FloorVerdict,
  type Policy,
  type Which,
} from "@inhuman.tools/policy/floor";
import {
  checkTirith,
  tirithClass,
  tirithDisposition,
  tirithFailure,
  tirithMessage,
  type ShellChecker,
  type TirithReport,
} from "@inhuman.tools/policy-tirith";
import { action, comparer, computed, type IReactionDisposer, observable, reaction, runInAction } from "mobx";

import type { RunLedger } from "./bypass.js";
import { FIRST_ATTEMPT_MS, ClassifierHandle, RETRY_ATTEMPT_MS } from "./classifier.js";
import { evidencePayloadKey } from "./evidence.js";
import type { RunStop } from "./unattended-guard.js";
import { realpathDeepest, resolvedWorkspacePath } from "./real-path.js";
import { withReadRoots, withSelfProtection } from "./self-protect.js";

/**
 * Lexical verdict joined with the verdict for where the path really leads (symlinks), stricter wins:
 * a link inside the root to a blocked file is judged as the blocked file.
 */
async function fileVerdict(judge: Policy["explainRead"], rootPath: string, raw: string): Promise<FloorVerdict> {
  const lexical = judge(workspacePath(rootPath, raw));
  const resolved = await resolvedWorkspacePath(rootPath, raw).catch(() => undefined);
  return resolved === undefined ? lexical : join([lexical, judge(resolved)]);
}

/**
 * A root the human named, and the folder it really is: the floor judges both spellings of a path
 * (a link may lead out of the workspace), so both must be roots or `/tmp/x` would never match
 * `/private/tmp/x`.
 */
export async function withRealRoots(roots: readonly string[]): Promise<string[]> {
  const out = new Set<string>(roots);
  for (const root of roots) {
    const real = await realpathDeepest(root).catch(() => undefined);
    if (real !== undefined) out.add(real);
  }
  return [...out].toSorted();
}

/** The class of a verdict the host stamps itself (no rule voted): MCP and unknown tools, by name. */
function hostClass(toolName: string): ClassId {
  return classifyMcpToolName(toolName).verdict === "stem" ? "mcp-lookup" : "mcp-action";
}

/**
 * The tier a rule of the owner gives an MCP call. The class stays the name-based look-up or action, so
 * the resolution table and the grant rules read it as before; only the tier moves. `ask` is the default.
 */
function ruleVerdict(rule: RuleStamp | undefined, mcpName: string): FloorVerdict | undefined {
  const id = `host:mcp-rule:${rule?.tier}`;
  switch (rule?.tier) {
    case undefined:
    case "ask":
      return undefined;
    case "allow":
      return APPROVE;
    case "soft-deny":
      return cast("deny", hostClass(mcpName), id);
    case "block":
      return cast("block", hostClass(mcpName), id);
  }
}

function mcpNameOf(job: ToolCallJob): string {
  return job instanceof MCPToolJob ? job.serverToolName : job.name;
}

/**
 * The floor's verdict for one call: the compiled policy for shell and file tools, the host's own
 * stamps for the rest (web_search approves, web_extract asks as network egress, MCP and unknown
 * tools ask as a look-up or an action by name). The same function answers `policy/explain`.
 */
export async function floorVerdict(
  policy: Policy,
  name: string,
  args: Readonly<Record<string, unknown>> | null,
  rootPath: string,
  mcpName: string,
  rule?: RuleStamp,
): Promise<FloorVerdict> {
  let verdict: FloorVerdict | undefined;
  if (args != null) {
    switch (clusterOf(name)) {
      case "read":
        verdict = await fileVerdict(policy.explainRead, rootPath, fileQuestion(name, args) ?? ".");
        break;
      case "write": {
        const question = fileQuestion(name, args);
        if (question != null) verdict = await fileVerdict(policy.explainWrite, rootPath, question);
        break;
      }
      case "bash":
        if (typeof args.command === "string" && args.command !== "") {
          const cwd = typeof args.cwd === "string" && args.cwd !== "" ? workspacePath(rootPath, args.cwd) : undefined;
          verdict = policy.explainBash(args.command, cwd);
        }
        // Extra-root cwd is remainder (read miss).
        if (typeof args.cwd === "string" && args.cwd !== "" && args.cwd !== ".") {
          verdict = join([
            verdict ?? cast("ask", "unmodelled", "host:no-command"),
            await fileVerdict(policy.explainRead, rootPath, args.cwd),
          ]);
        }
        break;
      case "mcp":
        // web_search sends a query; web_extract fetches an arbitrary URL, which is an exfiltration channel.
        if (name === "web_search") verdict = APPROVE;
        else if (name === "web_extract") verdict = cast("ask", "network-egress", "host:web_extract");
        break;
    }
  }
  if (verdict !== undefined) return verdict;
  if (clusterOf(name) !== "mcp") return cast("ask", "unmodelled", "host:no-question");
  return (
    ruleVerdict(rule, mcpName) ?? cast("ask", hostClass(mcpName), `host:mcp-name:${classifyMcpToolName(mcpName).verdict}`)
  );
}

class FloorHandle {
  #gen = 0;
  #stop: IReactionDisposer | undefined;
  #abort: AbortController | undefined;

  constructor(
    readonly job: ToolCallJob,
    readonly scope: LicenseScope,
  ) {}

  @action
  start(): void {
    if (this.#stop !== undefined || this.job.policyResult !== null || this.scope.closed) return;
    this.#stop = reaction(
      () => ({
        source: this.scope.root.policyProgram,
        args: this.job.args,
        name: this.job.name,
        rootPath: this.scope.root.path,
        roots: readRootList(this.scope.root.readRoots).toSorted(),
        // The owner's rule for this MCP call; a changed rule re-votes the floor.
        rule: this.job.authCluster === "mcp" ? ruleStampFor(this.job.authorizationLayers, this.job.callSubject) : {},
      }),
      (input) => {
        this.#abort?.abort();
        const gen = ++this.#gen;
        const abort = new AbortController();
        this.#abort = abort;
        this.scope.beginFloor(this.job);
        void this.#produce(gen, input, abort.signal);
      },
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  dispose(): void {
    this.#gen += 1;
    this.#stop?.();
    this.#stop = undefined;
    this.#abort?.abort();
    this.scope.endFloor(this.job);
  }

  /** Tier, classes and votes land in one action, so no peer sees a vote without its class. */
  #stamp(verdict: FloorVerdict, message: string | null, evidenceJson: string | null): void {
    const classes = classesOf(verdict);
    const votes = verdict.votes.filter((vote) => vote.disposition === verdict.disposition);
    this.job.stampPolicy(verdict.disposition, message, evidenceJson, {
      classesJson: JSON.stringify(classes),
      votesJson: JSON.stringify(votes),
      grantedBy: this.scope.grantsFor(this.job, verdict),
      ack: this.scope.acksFor(this.job, verdict),
    });
  }

  async #produce(
    gen: number,
    input: {
      source: string;
      args: Readonly<Record<string, unknown>> | null;
      name: string;
      rootPath: string;
      roots: readonly string[];
      rule: RuleStamp;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const { source } = input;
    const current = () =>
      this.#gen === gen &&
      !signal.aborted &&
      !this.scope.closed &&
      !this.job.cancelled &&
      !this.job.completed &&
      this.scope.waiting.has(this.job) &&
      this.scope.root.policyProgram === source &&
      comparer.structural(this.job.args, input.args) &&
      this.job.name === input.name &&
      this.scope.root.path === input.rootPath;
    try {
      if (source.trim() === "") return;
      let policy: Policy;
      try {
        policy = await this.scope.compiledPolicy(source, await withRealRoots(input.roots));
      } catch (error_) {
        // An operator policy that does not compile must not quietly demote the session to
        // the (possibly looser) dist floor, and "ask" would let a stored grant run
        // everything. Fail closed (block) and say why.
        if (!current()) return;
        const reason = error_ instanceof Error ? error_.message : String(error_);
        const text = `policy program is invalid; every tool call is blocked until it is fixed: ${reason}`;
        this.#stamp(cast("block", "policy-fault", "host:policy-invalid"), text, null);
        this.#report(text);
        return;
      }
      if (!current()) return;
      const args = this.job.args;
      let verdict = await floorVerdict(
        policy,
        input.name,
        args,
        input.rootPath,
        mcpNameOf(this.job),
        input.rule,
      );
      let tirith: TirithReport | undefined;
      if (this.scope.mcpPersistDenies?.(this.job) === true) {
        verdict = cast(
          "deny",
          clusterOf(input.name) === "mcp" ? hostClass(mcpNameOf(this.job)) : "mcp-action",
          "host:tool-blocklist",
        );
      } else if (verdict.disposition === "ask" && this.scope.mcpPersistAllows?.(this.job) === true) {
        verdict = APPROVE;
      }
      if (clusterOf(input.name) === "bash" && typeof args?.command === "string" && args.command !== "") {
        try {
          tirith = await this.scope.checkShell(args.command, {
            cwd: nodePath.resolve(input.rootPath, typeof args.cwd === "string" ? args.cwd : "."),
            signal,
          });
        } catch (error_) {
          tirith = tirithFailure(error_);
        }
        const rules = tirith.findings.map((finding) => finding.rule_id).join("+");
        verdict = join([
          verdict,
          cast(tirithDisposition(tirith), tirithClass(tirith), `tirith:${tirith.action === "error" ? "error" : rules}`),
        ]);
      }
      if (!current() || this.job.policyResult !== null) return;
      this.#stamp(
        verdict,
        tirith === undefined ? null : tirithMessage(tirith),
        tirith === undefined ? null : JSON.stringify({ tirith }),
      );
      this.#report(null);
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : String(error);
        // Fail closed and visible: a thrown check is a block, not an ask (a stored grant
        // would run an ask) and not a call parked forever with no prompt.
        if (this.job.policyResult === null) {
          this.#stamp(cast("block", "policy-fault", "host:check-threw"), `policy check failed: ${message}`, null);
        }
        this.#report(message);
      }
    } finally {
      if (this.#gen === gen) {
        runInAction(() => {
          this.scope.endFloor(this.job);
          if (this.job.policyResult === null && source.trim() !== "") {
            this.scope.blockFloor(this.job, source);
          }
        });
      }
    }
  }

  #report(text: string | null): void {
    try {
      this.scope.onPolicyError?.(text);
    } catch {
      /* awareness is presence, not the vote */
    }
  }
}

export class LicenseScope {
  @observable accessor closed = false;
  @observable accessor cap = 2;
  backoffMs = function (n: number): number {
    const seconds = Math.min(5 * 60, Math.max(1, n * Math.log(n)));
    return seconds * 1000;
  };
  /** Per-attempt classifier deadline. Attempt 0 is short — the first vote is what the
   *  human is waiting on. Retries get longer rope, but never unbounded. */
  judgeDeadlineMs = function (attempt: number): number {
    return attempt === 0 ? FIRST_ATTEMPT_MS : RETRY_ATTEMPT_MS;
  };
  onPolicyError: ((text: string | null) => void) | undefined;
  /** Session intern port. Remainder `dotprompt/run` calls this with a homed round. */
  complete: PromptComplete | undefined;
  /** Kernel `kv.json` last-choice. Session mint does not re-seed these. */
  judgeFallbackKvs: Readonly<Record<string, string>> = {};
  /** Connection `settings.model` for a named judge wire. */
  judgeConfiguredModel: ((connectionId: string) => string) | undefined;
  /** Host persist hit. May turn MCP `ask` into allow; never lifts deny/block. */
  mcpPersistAllows: ((job: ToolCallJob) => boolean) | undefined;
  /** Host hide hit. Turns MCP remainder into deny. Does not lift deny/block. */
  mcpPersistDenies: ((job: ToolCallJob) => boolean) | undefined;
  /** Stored grants of project, bot and global scope (the kernel's `grants.json`). Session rows ride the root. */
  persistentGrants: () => readonly GrantRow[] = () => [];
  /** The bot this session is, for bot-scope grants. */
  botName: () => string | undefined = () => undefined;
  now: () => number = () => Date.now();
  /** Unattended-run denial ledgers, one per eval turn. */
  readonly ledgers = new WeakMap<SessionTurn, RunLedger>();
  /** The host stops the run's UI side: notify a person. The turn is already sealed and cancelling. */
  onRunStopped: ((stop: RunStop) => void) | undefined;
  /** A non-stopping notice about an unattended run ("hit repeated denials"). */
  onRunNotice: ((notice: { readonly turn: SessionTurn; readonly text: string }) => void) | undefined;
  which: Which = whichOnPath;
  checkShell: ShellChecker = checkTirith;
  /** Last `judgeAskProgram` seen; mismatch drops `#remainderVotes`. */
  #remainderProgram = "";
  /** Process-local remainder skip. Dropped when `judgeAskProgram` changes. */
  readonly #remainderVotes = new Map<
    string,
    { identity: string; decision: "allow" | "deny"; epoch?: number; turn?: string }
  >();
  /** Connection+model pairs that cannot send json_schema. Cleared only by using a different pair. */
  readonly schemaHaltKeys = observable.set<string>();
  readonly waiting = observable.set<ToolCallJob>();
  readonly inFlight = observable.set<ToolCallJob>();
  readonly blockedFloor = observable.map<ToolCallJob, string>();

  readonly #policies = new DefaultedMap((key: string): Promise<Policy> => {
    const [source, ...roots] = JSON.parse(key) as string[];
    const hit = Promise.resolve().then(() =>
      bindPolicy(withReadRoots(withSelfProtection(JSON.parse(source!)), roots), this.which),
    );
    void hit.catch(() => {
      this.#policies.delete(key);
    });
    return hit;
  });
  readonly #floors = new DefaultedWeakMap((job: ToolCallJob) => new FloorHandle(job, this));
  readonly #judges = new DefaultedWeakMap((job: ToolCallJob) => new ClassifierHandle(job, this));
  readonly #floorJobs = new Set<ToolCallJob>();
  readonly #judgeJobs = new Set<ToolCallJob>();

  readonly #disposers: IReactionDisposer[] = [];

  constructor(readonly root: SessionRoot) {
    this.#disposers.push(
      reaction(
        () => {
          const keys = this.liveFloorKeys;
          const toStart = keys
            .filter((job) => !this.inFlight.has(job))
            .slice(0, Math.max(0, this.cap - this.inFlight.size));
          return { keys, toStart };
        },
        ({ keys, toStart }, prev) => {
          const live = new Set(keys);
          for (const job of prev?.keys ?? []) {
            if (live.has(job) || !this.#floors.has(job)) continue;
            this.#floors.get(job).dispose();
            this.#floors.delete(job);
            this.#floorJobs.delete(job);
          }
          for (const job of toStart) {
            this.#floorJobs.add(job);
            this.#floors.get(job).start();
          }
        },
        { equals: comparer.structural, fireImmediately: true },
      ),
      // A mode change or a session-scope store/revoke changes what an acknowledgement still needs.
      reaction(
        () => [this.root.permissionMode, this.root.grantsJson, this.root.authorizationUserJson] as const,
        () => this.reconcileGrants(),
        { equals: comparer.structural },
      ),
      reaction(
        () => this.pending,
        (keys, prev) => {
          const live = new Set(keys);
          for (const job of prev ?? []) {
            if (live.has(job) || !this.#judges.has(job)) continue;
            this.#judges.get(job).dispose();
            this.#judges.delete(job);
            this.#judgeJobs.delete(job);
          }
          for (const job of keys) {
            this.#judgeJobs.add(job);
            this.#judges.get(job).start();
          }
        },
        { equals: comparer.shallow, fireImmediately: true },
      ),
    );
  }

  @computed
  get liveFloorKeys(): ToolCallJob[] {
    if (this.closed) return [];
    const source = this.root.policyProgram;
    if (source.trim() === "") return [];
    return [...this.waiting].filter(
      (job) => !job.cancelled && !job.completed && job.policyResult === null && this.blockedFloor.get(job) !== source,
    );
  }

  /** Leaves whose resolver names a judge and nothing has decided yet. Any mode: the table says. */
  @computed
  get pending(): ToolCallJob[] {
    if (this.closed) return [];
    return [...this.waiting].filter((job) => !job.orchestrated && job.autoClassifierPending);
  }

  distSource(): string {
    return reasonableDefaultsSource;
  }

  compiledPolicy(source: string, roots: readonly string[] = []): Promise<Policy> {
    return this.#policies.get(JSON.stringify([source, ...roots]));
  }

  #visible(): GrantRow[] {
    const rows = [...parseGrantRows(this.root.grantsJson), ...this.persistentGrants()];
    return visibleRows(
      rows,
      { sessionId: this.root.sessionId, projectPath: this.root.path, bot: this.botName() },
      this.now(),
    );
  }

  /** The grant rows this session may use right now: its own, its project's, its bot's, the global ones. */
  visibleGrants(): GrantRow[] {
    return this.#visible().filter((row) => rowKind(row) === "grant");
  }

  /** The stored acknowledgements this session may use right now (same scopes and TTL as grants). */
  visibleAcks(): GrantRow[] {
    return this.#visible().filter((row) => rowKind(row) === "ack");
  }

  /**
   * Which acknowledgement flags cover this call and whether a stored ack satisfies them. The flags are
   * a union of every layer; `block` is never acknowledged (it never runs). Nothing here licenses a call.
   */
  acksFor(
    job: ToolCallJob,
    verdict: FloorVerdict,
  ): { state: AckState; flagsJson: string | null; ackedBy: string | null } {
    if (verdict.disposition === "block") return { state: "none", flagsJson: null, ackedBy: null };
    const units = new Map<string, NonNullable<AckCall["units"][number]>>();
    for (const unit of verdict.seen ?? []) units.set(JSON.stringify(unit), unit);
    for (const vote of verdict.votes) if (vote.unit !== undefined) units.set(JSON.stringify(vote.unit), vote.unit);
    const call: AckCall = {
      classes: classesOf(verdict),
      mcp: job.grantMcp,
      tool: job.grantToolName,
      units: [...units.values()],
    };
    const matched = matchAckFlags(collectAckFlags(job.authorizationLayers), call);
    if (matched.length === 0) return { state: "none", flagsJson: null, ackedBy: null };
    const resolution = resolveAcks(activeAcks(matched, job.permissionMode), this.visibleAcks(), call);
    return {
      state: resolution.state,
      flagsJson: JSON.stringify(matched),
      ackedBy: resolution.ackedBy.length === 0 ? null : resolution.ackedBy.join(","),
    };
  }

  /** Ids (comma-joined) of the stored grants that cover this ask, or null. Only an ask is ever covered. */
  grantsFor(job: ToolCallJob, verdict: FloorVerdict): string | null {
    if (verdict.disposition !== "ask") return null;
    const covering = coveringGrants(this.visibleGrants(), {
      tier: verdict.disposition,
      cluster: job.authCluster,
      hatch: job.hatch,
      votes: verdict.votes,
      mcp: job.grantMcp,
      toolName: job.grantToolName,
    });
    return covering === null ? null : covering.map((row) => row.id).join(",");
  }

  /**
   * Recompute which grant covers each leaf that is still waiting for a license. A revoked or expired
   * grant stops covering an unlicensed ask; a new grant starts to. A leaf that already ran is left alone.
   */
  @action
  reconcileGrants(): void {
    for (const job of this.waiting) {
      if (job.completed || job.cancelled || job.humanApprove !== null) continue;
      if (job.policyResult === "ask") {
        const verdict: FloorVerdict = {
          disposition: "ask",
          votes: job.policyVotes as unknown as FloorVerdict["votes"],
        };
        const next = this.grantsFor(job, verdict);
        if (next !== job.grantedBy) job.grantedBy = next;
      }
      this.#reconcileAck(job);
    }
  }

  /** A stored ack came or went, or the mode changed: where does the call stand now? */
  #reconcileAck(job: ToolCallJob): void {
    if (job.policyResult === null || job.policyResult === "block") return;
    if (job.ackFlagsJson === null || job.ackState === "refused" || job.ackedBy === ACKED_ONCE) return;
    const call: AckCall = { classes: job.policyClasses, mcp: job.grantMcp, tool: job.grantToolName, units: [] };
    const resolution = resolveAcks(activeAcks(job.ackFlags, job.permissionMode), this.visibleAcks(), call);
    job.stampAck(resolution.state, resolution.ackedBy.length === 0 ? null : resolution.ackedBy.join(","));
  }

  #syncRemainderProgram(): void {
    const source = this.root.judgeAskProgram;
    if (source === this.#remainderProgram) return;
    this.#remainderVotes.clear();
    this.#remainderProgram = source;
  }

  remainderHit(job: ToolCallJob, identity: string): "allow" | "deny" | null {
    this.#syncRemainderProgram();
    const key = evidencePayloadKey(job);
    if (key == null) return null;
    const cached = this.#remainderVotes.get(key);
    if (cached === undefined || cached.identity !== identity) return null;
    if (cached.decision === "allow") {
      return cached.epoch === userEpoch(this.root) ? "allow" : null;
    }
    const turnId = owningTurnId(job);
    return turnId != null && cached.turn === turnId ? "deny" : null;
  }

  /**
   * A soft-deny allow is licensed for exactly one call and is never stored. A deny may be reused for
   * the same payload, tier, classes and evidence within the turn (a looping agent cannot re-buy it).
   */
  remainderStore(job: ToolCallJob, identity: string, decision: "allow" | "deny"): void {
    if (decision === "allow" && job.policyResult === "deny") return;
    this.#syncRemainderProgram();
    const key = evidencePayloadKey(job);
    if (key == null) return;
    const turnId = owningTurnId(job);
    if (turnId == null) return;
    this.#remainderVotes.set(
      key,
      decision === "allow" ? { identity, decision, epoch: userEpoch(this.root) } : { identity, decision, turn: turnId },
    );
  }

  @action
  admit(job: ToolCallJob): void {
    this.waiting.add(job);
  }

  @action
  release(job: ToolCallJob): void {
    this.waiting.delete(job);
    this.blockedFloor.delete(job);
  }

  @action
  beginFloor(job: ToolCallJob): void {
    this.inFlight.add(job);
  }

  @action
  endFloor(job: ToolCallJob): void {
    this.inFlight.delete(job);
  }

  @action
  blockFloor(job: ToolCallJob, source: string): void {
    this.blockedFloor.set(job, source);
  }

  @action
  close(): void {
    this.closed = true;
    for (const stop of this.#disposers) stop();
    this.#disposers.length = 0;
    for (const job of this.#judgeJobs) {
      if (!this.#judges.has(job)) continue;
      this.#judges.get(job).dispose();
      this.#judges.delete(job);
    }
    this.#judgeJobs.clear();
    for (const job of this.#floorJobs) {
      if (!this.#floors.has(job)) continue;
      this.#floors.get(job).dispose();
      this.#floors.delete(job);
    }
    this.#floorJobs.clear();
    scopes.delete(this.root);
  }
}

export const scopes = new DefaultedWeakMap<SessionRoot, LicenseScope>((root) => new LicenseScope(root));
