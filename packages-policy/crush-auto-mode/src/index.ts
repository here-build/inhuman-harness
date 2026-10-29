import type { EnvCapability } from "@here.build/arrival";
import { authorize, checkToolPath, defaultPolicy as policy, withDeadline } from "@inhuman.tools/policy";

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

function floorOf(call: Call): "policyApprove" | "ask" | "deny" | "block" {
  if (call.kind === "bash") return policy.bash(call.command);
  return checkToolPath(call.kind, call.path, call.cwd === undefined ? undefined : { cwd: call.cwd });
}

export async function evaluateCall(call: Call, judge: Judge | null, deadlineMs?: number): Promise<Verdict> {
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
