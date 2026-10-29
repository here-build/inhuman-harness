/**
 * "What would happen to this call right now?" The same floor, grant and resolution code as a real
 * call, with no judge and no effect, so the answer cannot drift from the real path.
 */
import {
  activeAcks,
  clusterOf,
  collectAckFlags,
  coveringGrants,
  type GrantRow,
  type GrantSubject,
  grantOptionsFor,
  isShellHatch,
  layersOf,
  matchAckFlags,
  readRootList,
  resolveAcks,
  resolveCall,
  ruleStampFor,
  type CallSubject,
  type PermissionMode,
} from "@inhuman.tools/harness-model";
import { CLASSES, classesOf, join, cast, type ClassId, type FloorVerdict } from "@inhuman.tools/policy/floor";
import { tirithClass, tirithDisposition, tirithFailure } from "@inhuman.tools/policy-tirith";

import nodePath from "node:path";

import { floorVerdict, withRealRoots, type LicenseScope } from "./scope.js";

export type ExplainProbe =
  | { readonly kind: "shell"; readonly command: string; readonly cwd?: string }
  | { readonly kind: "path"; readonly cluster: "read" | "write"; readonly path: string }
  | { readonly kind: "mcp"; readonly server: string; readonly account?: string; readonly tool: string }
  | { readonly kind: "tool"; readonly name: string; readonly args?: Readonly<Record<string, unknown>> };

export type Tier = "block" | "soft-deny" | "ask" | "allow";

export type Explanation = {
  readonly tier: Tier;
  readonly classes: Array<{ readonly id: ClassId; readonly label: string }>;
  readonly votes: Array<{
    readonly tier: Tier;
    readonly class: ClassId;
    readonly ruleId: string;
    readonly lift?: string;
  }>;
  readonly resolver: {
    readonly kind: "allow" | "judge" | "human" | "deny";
    readonly layer: "dist" | "managed" | "user" | "project" | "session";
    readonly onDeny?: "human" | "deny";
    readonly onFail?: "human" | "deny";
  } | null;
  readonly grant: GrantRow | null;
  readonly grantable: GrantSubject[];
  /** Acknowledgement flags that cover the call in this mode and the stored ack that satisfies them. */
  readonly ack: {
    readonly flags: Array<{ readonly label: string; readonly why?: string; readonly layer: string }>;
    readonly satisfiedBy: GrantRow | null;
  } | null;
  readonly outcome: "runs" | "judge-ask" | "judge-soft-deny" | "prompts-you" | "denied" | "blocked";
  readonly reason: string;
};

const TIER: Readonly<Record<string, Tier>> = { block: "block", deny: "soft-deny", ask: "ask", policyApprove: "allow" };

function nameAndArgs(probe: ExplainProbe): { name: string; args: Record<string, unknown>; mcpName: string } {
  switch (probe.kind) {
    case "shell":
      return {
        name: "shell",
        args: { command: probe.command, ...(probe.cwd === undefined ? {} : { cwd: probe.cwd }) },
        mcpName: "shell",
      };
    case "path":
      return { name: probe.cluster === "read" ? "read_file" : "write_file", args: { path: probe.path }, mcpName: "" };
    case "mcp":
      return { name: `mcp__${probe.server}__${probe.tool}`, args: {}, mcpName: probe.tool };
    case "tool":
      return { name: probe.name, args: { ...probe.args }, mcpName: probe.name };
  }
}

export async function explainCall(
  scope: LicenseScope,
  probe: ExplainProbe,
  options: { readonly mode?: PermissionMode; readonly unattended?: boolean } = {},
): Promise<Explanation> {
  const root = scope.root;
  const { name, args, mcpName } = nameAndArgs(probe);
  const source = root.policyProgram.trim() === "" ? scope.distSource() : root.policyProgram;
  let verdict: FloorVerdict;
  const layers = layersOf({
    user: root.authorizationUserJson,
    project: root.authorizationProjectJson,
    session: root.authorizationOverlayJson,
  });
  const ruleMcp =
    probe.kind === "mcp"
      ? { server: probe.server, account: probe.account ?? probe.server, tool: probe.tool }
      : undefined;
  const rule =
    clusterOf(name) === "mcp"
      ? ruleStampFor(layers, { tool: name, ...(ruleMcp === undefined ? {} : { mcp: ruleMcp }) })
      : {};
  try {
    const policy = await scope.compiledPolicy(source, await withRealRoots(readRootList(root.readRoots).toSorted()));
    verdict = await floorVerdict(policy, name, args, root.path, mcpName, rule);
  } catch (error) {
    verdict = cast("block", "policy-fault", "host:policy-invalid");
    return finish(
      verdict,
      null,
      null,
      [],
      `the policy is invalid, so every call is blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (clusterOf(name) === "bash" && typeof args.command === "string") {
    try {
      const report = await scope.checkShell(args.command, {
        cwd: nodePath.resolve(root.path, typeof args.cwd === "string" ? args.cwd : "."),
      });
      verdict = join([
        verdict,
        cast(
          tirithDisposition(report),
          tirithClass(report),
          `tirith:${report.findings.map((f) => f.rule_id).join("+")}`,
        ),
      ]);
    } catch (error) {
      const report = tirithFailure(error);
      verdict = join([verdict, cast(tirithDisposition(report), tirithClass(report), "tirith:error")]);
    }
  }
  const tierVotes = verdict.votes.filter((vote) => vote.disposition === verdict.disposition);
  const classes = classesOf(verdict);
  const cluster = clusterOf(name);
  const mcp = ruleMcp;
  const hatch = typeof args.command === "string" && isShellHatch(args.command);
  const call = {
    tier: verdict.disposition,
    cluster,
    hatch,
    votes: tierVotes,
    mcp,
    toolName: name,
  } as const;
  const grant = verdict.disposition === "ask" ? (coveringGrants(scope.visibleGrants(), call)?.[0] ?? null) : null;
  const grantable = grantOptionsFor(call).map((option) => option.subject);
  const subject: CallSubject = {
    tool: name,
    units: tierVotes.flatMap((vote) => (vote.unit === undefined ? [] : [vote.unit])),
    paths: tierVotes.flatMap((vote) => (vote.path === undefined ? [] : [vote.path])),
    ...(mcp === undefined ? {} : { mcp }),
  };
  const resolution =
    verdict.disposition === "ask" || verdict.disposition === "deny"
      ? resolveCall(layers, {
          mode: options.mode ?? root.permissionMode,
          cluster,
          tier: verdict.disposition,
          classes,
          unattended: options.unattended ?? false,
          subject,
        })
      : null;
  const mode = options.mode ?? root.permissionMode;
  const ackCall = {
    classes,
    ...(mcp === undefined ? {} : { mcp }),
    tool: name,
    units: [...(verdict.seen ?? []), ...verdict.votes.flatMap((vote) => (vote.unit === undefined ? [] : [vote.unit]))],
  };
  const active =
    verdict.disposition === "block" ? [] : activeAcks(matchAckFlags(collectAckFlags(layers), ackCall), mode);
  const acks = resolveAcks(active, scope.visibleAcks(), ackCall);
  const ack =
    active.length === 0
      ? null
      : {
          flags: active.map((flag) => ({
            label: flag.label,
            ...(flag.why === undefined ? {} : { why: flag.why }),
            layer: flag.layer,
          })),
          satisfiedBy:
            acks.state === "satisfied"
              ? (scope.visibleAcks().find((row) => row.id === acks.ackedBy[0]) ?? null)
              : null,
        };
  return withAck(
    finish(verdict, resolution, grant, grantable, undefined, options.unattended ?? false),
    ack,
    options.unattended ?? false,
  );
}

/**
 * An unsatisfied flag stops a call that would run, and follows one that waits for a judge or a person.
 * `block` and denials are untouched: an acknowledgement never lifts anything.
 */
function withAck(base: Explanation, ack: Explanation["ack"], unattended: boolean): Explanation {
  if (ack === null || ack.satisfiedBy !== null) return { ...base, ack };
  const what = ack.flags.map((flag) => flag.label).join("; ");
  if (base.outcome === "blocked" || base.outcome === "denied") return { ...base, ack };
  if (unattended) {
    return {
      ...base,
      ack,
      outcome: "denied",
      reason: `${base.reason} It also needs your acknowledgement (${what}); this run is unattended, so it is denied as interaction_required and the run continues.`,
    };
  }
  if (base.outcome === "runs") {
    return {
      ...base,
      ack,
      outcome: "prompts-you",
      reason: `${base.reason} It is flagged to need your acknowledgement (${what}), so you are asked before it runs.`,
    };
  }
  return { ...base, ack, reason: `${base.reason} If it is allowed, you are still asked to acknowledge it (${what}).` };
}

function finish(
  verdict: FloorVerdict,
  resolution: ReturnType<typeof resolveCall> | null,
  grant: GrantRow | null,
  grantable: GrantSubject[],
  forced?: string,
  unattended = false,
): Explanation {
  const tier = TIER[verdict.disposition] ?? "ask";
  const classes = classesOf(verdict);
  const base = {
    tier,
    classes: classes.map((id) => ({ id, label: CLASSES[id].label })),
    votes: verdict.votes.map((vote) => ({
      tier: TIER[vote.disposition] ?? "ask",
      class: vote.class,
      ruleId: vote.ruleId,
      ...(vote.lift === undefined ? {} : { lift: vote.lift }),
    })),
    grant,
    grantable,
    ack: null,
  };
  const what = classes.map((id) => CLASSES[id].label.toLowerCase()).join(", ");
  if (verdict.disposition === "block") {
    return {
      ...base,
      resolver: null,
      outcome: "blocked",
      reason: forced ?? `Blocked (${what}). Nothing lifts a block: no mode, grant, judge or answer.`,
    };
  }
  if (resolution === null) {
    return { ...base, resolver: null, outcome: "runs", reason: "The floor allows it." };
  }
  const { resolver, layer, interaction } = resolution;
  const cell = {
    kind: resolver.kind,
    layer,
    ...(resolver.kind === "judge" ? { onDeny: resolver.onDeny, onFail: resolver.onFail } : {}),
  } as const;
  const tierName = tier === "soft-deny" ? "Soft-deny" : "Ask";
  if (grant !== null) {
    return {
      ...base,
      resolver: cell,
      outcome: "runs",
      reason: `${tierName} (${what}), covered by a stored grant: ${grant.label}.`,
    };
  }
  switch (resolver.kind) {
    case "allow":
      return {
        ...base,
        resolver: cell,
        outcome: "runs",
        reason: `${tierName} (${what}); the ${layer} table allows it in this mode.`,
      };
    case "deny":
      return {
        ...base,
        resolver: cell,
        outcome: "denied",
        reason:
          interaction.resolver || (unattended && interaction.onDeny)
            ? `${tierName} (${what}) needs a person, and this run is unattended: denied as interaction_required.`
            : `${tierName} (${what}); the ${layer} table denies it.`,
      };
    case "human":
      return {
        ...base,
        resolver: cell,
        outcome: "prompts-you",
        reason: `${tierName} (${what}): you are asked${tier === "soft-deny" ? " every time; nothing is remembered" : ""}.`,
      };
    case "judge":
      return {
        ...base,
        resolver: cell,
        outcome: tier === "soft-deny" ? "judge-soft-deny" : "judge-ask",
        reason:
          tier === "soft-deny"
            ? `Soft-deny (${what}): the judge decides whether you explicitly asked for exactly this; a "no" ${resolver.onDeny === "human" ? "asks you" : "denies it"}. Grants do not apply.`
            : `Ask (${what}): the judge decides; a "no" ${resolver.onDeny === "human" ? "asks you" : "denies it"}.`,
      };
  }
}
