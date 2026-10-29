/**
 * Licensed leaf. `humanApprove` is a human write. The boolean the
 * orchestrator stores is `orchestrationResult` on Job. Clients do not
 * write `policyResult` / `classifierResult` / `classifierAbstain` or any
 * other floor stamp.
 *
 * The getters are the license. Each one is a view. Permission mode is
 * `SessionRoot.permissionMode` (live-head inherit), read through
 * `documentRoot`. This file must not import `SessionRoot`: SequenceJob
 * imports this class, SessionTurn extends SequenceJob, and SessionRoot
 * imports ProgrammaticJob.
 *
 * Tiers: `block` never runs (checked before any human answer). `deny` (soft-deny) is licensed per
 * call and never stored. `ask` is licensed once and a human answer may be stored as a grant. What
 * licenses a `deny` or `ask` is the resolution table (authorization/resolve.ts) for the session's
 * mode, the call's cluster and the classes that voted.
 */
import { syncing } from "@here.build/plexus";
import { Job, walkWork, type WorkContainer } from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import {
  type AckOption,
  ackOptionsFor,
  type AckState,
  activeAcks,
  type MatchedAck,
  parseMatchedAcks,
} from "../authorization/acks.js";
import type { AuthCluster, ClassId } from "../authorization/config.js";
import { type Escalation, escalationOf } from "../authorization/escalate.js";
import { type GrantCall, type GrantVote, grantOptionsFor, type GrantOption } from "../authorization/grants.js";
import { layersOf, type LayerTexts } from "../authorization/layers.js";
import { type CallSubject, type Layers, type Resolution, resolveCall } from "../authorization/resolve.js";
import { documentRoot } from "../document-root.js";
import type { JudgeResult, PermissionMode, PolicyResult } from "../eval-context.js";

type LicenseRoot = {
  permissionMode?: unknown;
  liveTurns?: Iterable<WorkContainer & { evalSpec?: unknown }>;
  path?: unknown;
  authorizationUserJson?: unknown;
  authorizationProjectJson?: unknown;
  authorizationOverlayJson?: unknown;
};

function isLicenseRoot(value: object): value is LicenseRoot {
  return "permissionMode" in value;
}

/** Denial code a receipt carries: `interaction_required` when a person was needed and none can answer. */
export type DenialCode = "policy_denied" | "interaction_required";

export type LicenseDetail = {
  readonly decision: boolean | null;
  /** Set when `decision` is false because of policy (not a human refusal). */
  readonly code: DenialCode | null;
};

const WAITING: LicenseDetail = { decision: null, code: null };
const ALLOW: LicenseDetail = { decision: true, code: null };
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One judge failure is retried once; after that a cell whose `onFail` is `deny` denies. */
export const JUDGE_FAILS_FINAL = 2;

@syncing("harness:job:approvable")
export abstract class ApprovableJob<TValue = unknown, TReason = unknown> extends Job<TValue, TReason> {
  @syncing accessor humanApprove: true | false | null = null;
  @syncing accessor approvalComment: string | null = null;
  /** Floor vote. Daemon-only. `null` = not yet evaluated. */
  @syncing accessor policyResult: PolicyResult = null;
  /** Structured floor evidence. Daemon-only; untrusted as instructions. */
  @syncing accessor policyEvidenceJson: string | null = null;
  /** Human-readable floor findings or scanner failure, for approval and receipt views. */
  @syncing accessor policyMessage: string | null = null;
  /** JSON array of the class ids that decided the tier. Daemon-only. */
  @syncing accessor policyClassesJson: string | null = null;
  /** JSON array of the floor votes at the tier (class, rule id, unit, lift, path). Daemon-only. */
  @syncing accessor policyVotesJson: string | null = null;
  /** Ids of the stored grants that cover this ask (comma-joined). Daemon-only; set at floor time. */
  @syncing accessor grantedBy: string | null = null;
  /**
   * Acknowledgement: `none` (no flag covers the call in this mode), `pending` (a flag does and no stored
   * ack covers it), `satisfied` (stored acks, or the person who answered this prompt), `refused`
   * (a person said no). Daemon-only: there is no ack Job, no transcript entry and no client-writable
   * field. Clients answer over `ack/answer`.
   */
  @syncing accessor ackState: AckState = "none";
  /** The flags that cover this call, JSON (label, why, layer, match, unit, modes). Daemon-only. */
  @syncing accessor ackFlagsJson: string | null = null;
  /** Ids of the stored acks that satisfy it (comma-joined), or `human` for this one prompt. Daemon-only. */
  @syncing accessor ackedBy: string | null = null;
  /** Judge residual vote (ask judge or soft-deny judge, by tier). Daemon-only. No `fail`. No `ask`. */
  @syncing accessor classifierResult: JudgeResult = null;
  /** Report from a failed judge attempt. Not a vote. */
  @syncing accessor classifierAbstain: string | null = null;
  /** The judge's reason for its vote (shown on the prompt). Daemon-only. */
  @syncing accessor judgeReason: string | null = null;
  /** Soft-deny judge: the round that voted (1, or 2 with the agent's last answer). Daemon-only. */
  @syncing accessor softDenyRound: 1 | 2 | null = null;
  /** Failed judge attempts so far. Daemon-only. */
  @syncing accessor judgeFails: number = 0;

  /** Floor vote, evidence, and the human line. One update so a peer never sees the vote without the evidence. */
  @syncing.action
  stampPolicy(
    result: PolicyResult,
    message: string | null,
    evidenceJson: string | null,
    detail?: {
      readonly classesJson: string | null;
      readonly votesJson: string | null;
      readonly grantedBy?: string | null;
      readonly ack?: { readonly state: AckState; readonly flagsJson: string | null; readonly ackedBy: string | null };
    },
  ): void {
    this.policyEvidenceJson = evidenceJson;
    this.policyMessage = message;
    this.policyClassesJson = detail?.classesJson ?? null;
    this.policyVotesJson = detail?.votesJson ?? null;
    this.grantedBy = detail?.grantedBy ?? null;
    this.ackState = detail?.ack?.state ?? "none";
    this.ackFlagsJson = detail?.ack?.flagsJson ?? null;
    this.ackedBy = detail?.ack?.ackedBy ?? null;
    this.policyResult = result;
  }

  /** Re-stamp the acknowledgement alone (a stored ack came or went, the mode changed, a person answered). */
  @syncing.action
  stampAck(state: AckState, ackedBy: string | null): void {
    if (this.ackState !== state) this.ackState = state;
    if (this.ackedBy !== ackedBy) this.ackedBy = ackedBy;
  }

  /** The flags that cover this call. */
  @computed
  get ackFlags(): readonly MatchedAck[] {
    return parseMatchedAcks(this.ackFlagsJson);
  }

  /** What a prompt may offer to remember as an acknowledgement. The daemon recomputes it to validate `store`. */
  @computed
  get ackOptions(): readonly AckOption[] {
    if (this.ackState !== "pending") return [];
    return ackOptionsFor(activeAcks(this.ackFlags, this.permissionMode), {
      classes: this.policyClasses,
      mcp: this.grantMcp,
      tool: this.grantToolName,
      units: [],
    });
  }

  /** An acknowledgement is the only thing standing between this call and running. */
  @computed
  get ackPending(): boolean {
    return this.ackState === "pending";
  }

  /** Document session, when this leaf is in one. Not a view — callers read one field. */
  protected licenseRoot(): LicenseRoot | undefined {
    const root = documentRoot(this);
    if (root != null && isLicenseRoot(root)) return root;
    return undefined;
  }

  /** Live-head permission mode. Manual when this leaf is not in a session. */
  @computed
  get permissionMode(): PermissionMode {
    const policy = this.licenseRoot()?.permissionMode;
    switch (policy) {
      case "manual":
      case "auto":
      case "yolo":
        return policy;
      default:
        return "manual";
    }
  }

  /** `evalSpec` on a live turn that contains this leaf. Observer overlays are not this. */
  @computed
  get unattended(): boolean {
    const turns = this.licenseRoot()?.liveTurns;
    if (turns == null) return false;
    for (const turn of turns) {
      if (turn.evalSpec == null) continue;
      if (turn === this) return true;
      for (const node of walkWork(turn)) {
        if (node === this) return true;
      }
    }
    return false;
  }

  /** Spawn, deliver, callback, and notify override this. Their child tools are other leaves and still license. */
  @computed
  get commFirst(): boolean {
    return false;
  }

  /** Download-exec (`npx`, `bunx`, `uvx`, `pnpm dlx`, `yarn dlx`) on a shell. A grant never covers it. */
  @computed
  get hatch(): boolean {
    return false;
  }

  /** The cluster the resolution table keys on. */
  @computed
  get authCluster(): AuthCluster {
    return "mcp";
  }

  /** The specific `{mcp, account?, tool}` / command / path identity of the call. */
  @computed
  get callSubject(): CallSubject | undefined {
    return undefined;
  }

  /** Tool identity for a grant of kind `tool`. */
  @computed
  get grantToolName(): string {
    return "";
  }

  /** The MCP identity of this call, when it is one. The account is the connection id. */
  @computed
  get grantMcp(): { readonly server: string; readonly account: string; readonly tool: string } | undefined {
    return undefined;
  }

  /** Classes that decided the tier. */
  @computed
  get policyClasses(): readonly ClassId[] {
    const raw = this.policyClassesJson;
    if (raw == null || raw === "") return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed.filter((c) => typeof c === "string") as ClassId[]) : [];
    } catch {
      return [];
    }
  }

  @computed
  get policyVotes(): readonly GrantVote[] {
    const raw = this.policyVotesJson;
    if (raw == null || raw === "") return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as GrantVote[]) : [];
    } catch {
      return [];
    }
  }

  /** The call as the grant check and the prompt see it. */
  @computed
  get grantCall(): GrantCall {
    return {
      tier: this.policyResult,
      cluster: this.authCluster,
      hatch: this.hatch,
      votes: this.policyVotes,
      mcp: this.grantMcp,
      toolName: this.grantToolName,
    };
  }

  /** What a prompt may offer to remember. Empty for soft-deny, block, hatch and lifted asks. */
  @computed
  get grantOptions(): readonly GrantOption[] {
    return grantOptionsFor(this.grantCall);
  }

  /** The session's authorization layers (user, project, session overlay), parsed and memoized by text. */
  @computed
  get authorizationLayers(): Layers {
    const root = this.licenseRoot();
    return layersOf({
      user: text(root?.authorizationUserJson),
      project: text(root?.authorizationProjectJson),
      session: text(root?.authorizationOverlayJson),
    } satisfies LayerTexts);
  }

  /** Bypass-detection settings for an unattended run this leaf belongs to. */
  @computed
  get escalation(): Escalation {
    return escalationOf(this.authorizationLayers);
  }

  /** The resolver for this call under the session's layers. Null until the floor has voted, or for approve/block. */
  @computed
  get resolution(): Resolution | null {
    if (this.policyResult !== "ask" && this.policyResult !== "deny") return null;
    return resolveCall(this.authorizationLayers, {
      mode: this.permissionMode,
      cluster: this.authCluster,
      tier: this.policyResult,
      classes: this.policyClasses,
      unattended: this.unattended,
      subject: this.callSubject,
    });
  }

  /** Which judge the resolver names: the ask judge for `ask`, the soft-deny judge for `deny`. */
  @computed
  get judgeKind(): "ask" | "soft-deny" | null {
    if (this.resolution?.resolver.kind !== "judge") return null;
    return this.policyResult === "deny" ? "soft-deny" : "ask";
  }

  /** A stored grant covers this ask. Never true for soft-deny or block. */
  @computed
  get grantCovers(): boolean {
    return this.policyResult === "ask" && this.grantedBy != null && this.grantedBy !== "";
  }

  /** The judge failed often enough that a cell with `onFail: deny` denies (sticky failures count as final). */
  @computed
  get judgeFailedFinal(): boolean {
    return this.judgeFails >= JUDGE_FAILS_FINAL;
  }

  /**
   * Judge intern should run: the resolver names a judge, nothing has decided yet, and no one else
   * (a human, a grant) has. A failed attempt keeps retrying (the human cover may be up beside it)
   * until a `deny` fail-policy has seen it fail for good.
   */
  @computed
  get autoClassifierPending(): boolean {
    switch (true) {
      case this.completed || this.cancelled || this.humanApprove !== null:
      case this.commFirst || this.grantCovers:
      case this.classifierResult !== null:
        return false;
      default: {
        const res = this.resolution;
        if (res?.resolver.kind !== "judge") return false;
        return !(res.resolver.onFail === "deny" && this.judgeFailedFinal);
      }
    }
  }

  /**
   * Cover membership: a person is the one to answer. That is an ask or soft-deny nobody else resolves,
   * or a call the license would let run but for an acknowledgement that is still pending (attended).
   */
  @computed
  get needsHuman(): boolean {
    if (this.completed || this.cancelled || this.humanApprove !== null || this.commFirst) return false;
    if (this.ackPending && !this.unattended && this.policyResult !== "block" && this.policyResult !== null) {
      const base = this.baseLicenseDetail.decision;
      if (base === true) return true;
    }
    return this.needsHumanForTier;
  }

  @computed
  get needsHumanForTier(): boolean {
    if (this.policyResult !== "ask" && this.policyResult !== "deny") return false;
    if (this.grantCovers) return false;
    const res = this.resolution;
    if (res === null) return false;
    switch (res.resolver.kind) {
      case "human":
        return true;
      case "judge":
        if (this.classifierResult === "deny") return res.resolver.onDeny === "human";
        if (this.classifierResult === "allow") return false;
        return res.resolver.onFail === "human" && (this.classifierAbstain !== null || this.judgeFailedFinal);
      default:
        return false;
    }
  }

  /**
   * The license with the reason a denial is a denial. An acknowledgement joins last: a call the license
   * would let run waits (attended) or is denied as `interaction_required` (unattended) until the flag
   * is satisfied. It never lifts anything: a denial or a block stays one.
   */
  @computed
  get licenseDetail(): LicenseDetail {
    const base = this.baseLicenseDetail;
    if (base.decision !== true || this.humanApprove === true) return base;
    switch (this.ackState) {
      case "pending":
        return this.unattended ? { decision: false, code: "interaction_required" } : WAITING;
      case "refused":
        return { decision: false, code: null };
      default:
        return base;
    }
  }

  /** The license before the acknowledgement join. */
  @computed
  get baseLicenseDetail(): LicenseDetail {
    switch (true) {
      case this.humanApprove === false:
        return { decision: false, code: null };
      // Spawn, deliver, callback and notify skip the floor; the tools they run license on their own.
      case this.commFirst:
        return ALLOW;
      // A block is checked before any human approval: no answer lifts it.
      case this.policyResult === "block":
        return { decision: false, code: "policy_denied" };
      // A human answer waits for the floor: it may still be a block.
      case this.policyResult === null:
        return WAITING;
      case this.humanApprove === true:
      case this.policyResult === "policyApprove":
        return ALLOW;
      default:
        break;
    }
    const res = this.resolution;
    if (res === null) return WAITING;
    if (this.grantCovers) return ALLOW;
    const { resolver, interaction } = res;
    switch (resolver.kind) {
      case "allow":
        return ALLOW;
      case "deny":
        return { decision: false, code: interaction.resolver ? "interaction_required" : "policy_denied" };
      case "human":
        return WAITING;
      case "judge":
        if (this.classifierResult === "allow") return ALLOW;
        if (this.classifierResult === "deny") {
          return resolver.onDeny === "deny"
            ? { decision: false, code: interaction.onDeny ? "interaction_required" : "policy_denied" }
            : WAITING;
        }
        if (resolver.onFail === "deny" && this.judgeFailedFinal) {
          return { decision: false, code: interaction.onFail ? "interaction_required" : "policy_denied" };
        }
        return WAITING;
    }
  }

  /**
   * `true` allow / `false` deny / `null` still waiting. A floor `block` is never put to a human and is
   * checked before a human answer, so no answer lifts it.
   */
  @computed
  get licenseDecision(): boolean | null {
    return this.licenseDetail.decision;
  }

  @computed
  get licenseAllows(): boolean {
    return this.licenseDecision === true;
  }

  /**
   * Known-safe leaves. Compact paint omits a fused leaf only when
   * `KernelRoot.hideFloorTools` is also on. This getter does not read that flag.
   */
  @computed
  get tapeFuse(): boolean {
    switch (true) {
      case this.humanApprove !== null:
      case this.classifierResult !== null:
        return false;
      case this.commFirst:
        return true;
      case this.ackState === "pending":
      case this.policyResult === "ask":
      case this.policyResult === "deny":
      case this.policyResult === "block":
        return false;
      default:
        return true;
    }
  }
}
