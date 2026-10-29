import type { EnvCapability } from "@here.build/arrival";
import {
  structuredOutputDecideCapability,
  type DecideComplete,
} from "@inhuman.tools/env-capability-decision-structured";
import {
  acknowledgeRequirement,
  authorize,
  checkToolPath,
  defaultPolicy as policy,
  floorVerdictOf,
  requestAcknowledgement,
  withDeadline,
  type AckFlag,
  type Acknowledger,
} from "@inhuman.tools/policy";

export type Verdict = "allow" | "deny";

/** `cwd` anchors a relative or absolute `path` the way the harness does; absent is the process cwd. */
export type Call =
  | { readonly kind: "bash"; readonly command: string }
  | { readonly kind: "write"; readonly path: string; readonly cwd?: string }
  | { readonly kind: "read"; readonly path: string; readonly cwd?: string };

export type JudgeDocument = Call & { readonly floor: "ask" | "deny" };

export type Judge = (document: JudgeDocument) => Verdict | null | Promise<Verdict | null>;

export type ProgramSource = {
  readonly program?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export function textOf(document: JudgeDocument): string {
  return document.kind === "bash" ? document.command : document.path;
}

/** Shared door. Sage and Jev packages pass their own capability. */
export function judgeWith(
  capability: EnvCapability,
  config?: Readonly<Record<string, unknown>>,
  source?: ProgramSource,
): Judge {
  return async (document) =>
    authorize(textOf(document), {
      capability,
      ...(config === undefined ? {} : { config }),
      ...(source?.program === undefined ? {} : { program: source.program }),
      ...(source?.env === undefined ? {} : { env: source.env }),
    });
}

export function structuredJudge(complete: DecideComplete, source?: ProgramSource): Judge {
  return judgeWith(structuredOutputDecideCapability, { complete }, source);
}

function floorOf(call: Call): "policyApprove" | "ask" | "deny" | "block" {
  if (call.kind === "bash") return policy.bash(call.command);
  return checkToolPath(call.kind, call.path, call.cwd === undefined ? undefined : { cwd: call.cwd });
}

export type EvaluateOptions = {
  readonly deadlineMs?: number;
  /** `needsAcknowledgement` flags. The embedding owns the config; modes are ignored in adapters. */
  readonly acknowledgeFlags?: readonly AckFlag[];
  /** The embedding's prompt. Absent, a flagged call that would run is denied: "needs acknowledgement: <label>". */
  readonly acknowledge?: Acknowledger;
};

export type Outcome = { readonly verdict: Verdict; readonly reason?: string };

export async function evaluateCall(
  call: Call,
  judge: Judge | null,
  deadlineOrOptions?: number | EvaluateOptions,
): Promise<Verdict> {
  return (await evaluateCallWithReason(call, judge, deadlineOrOptions)).verdict;
}

/** Like `evaluateCall`, with the reason of an acknowledgement denial. */
export async function evaluateCallWithReason(
  call: Call,
  judge: Judge | null,
  deadlineOrOptions?: number | EvaluateOptions,
): Promise<Outcome> {
  const options: EvaluateOptions =
    typeof deadlineOrOptions === "number" ? { deadlineMs: deadlineOrOptions } : (deadlineOrOptions ?? {});
  if ((await decide(call, judge, options.deadlineMs)) === "deny") return { verdict: "deny" };
  const flags = options.acknowledgeFlags ?? [];
  if (flags.length === 0) return { verdict: "allow" };
  const requirement = acknowledgeRequirement(flags, {
    tool: call.kind === "bash" ? "bash" : call.kind,
    verdict: floorVerdictOf(call),
  });
  if (requirement === null) return { verdict: "allow" };
  const reason = await requestAcknowledgement(
    requirement,
    call.kind,
    textOf({ ...call, floor: "ask" }),
    options.acknowledge,
  );
  return reason === undefined ? { verdict: "allow" } : { verdict: "deny", reason };
}

async function decide(call: Call, judge: Judge | null, deadlineMs?: number): Promise<Verdict> {
  const floor = floorOf(call);
  if (floor === "policyApprove") return "allow";
  if (floor === "block" || judge === null) return "deny";
  try {
    const vote = await withDeadline(Promise.resolve(judge({ ...call, floor })), deadlineMs);
    return vote === "allow" ? "allow" : "deny";
  } catch {
    return "deny";
  }
}
