/**
 * OpenCode permission hook on Jev.
 * `{env:UNSET}` arrives as `""` and is not a key. `SAGE_API_KEY` is not read.
 */
import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import { authorize, type AckFlag } from "@inhuman.tools/policy";
import {
  acknowledgeFlagsOf,
  applyAcknowledgement,
  prepareCall,
  programOf,
  voteDocuments,
  type Decision,
  type PermissionCall,
  type PermissionHost,
} from "@inhuman.tools/policy-opencode";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export type JevOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly program?: string;
  /** A missing file denies. It does not fall through to the dist script. */
  readonly programPath?: string;
  readonly cwd?: string;
  readonly deadlineMs?: number;
  readonly acknowledgeFlags?: readonly AckFlag[];
  readonly jevApiKey?: string;
};

export async function evaluateCall(call: PermissionCall, options?: JevOptions): Promise<Decision> {
  return applyAcknowledgement(call, await decideCall(call, options), options);
}

async function decideCall(call: PermissionCall, options?: JevOptions): Promise<Decision> {
  const prepared = prepareCall(call, options?.cwd);
  if (prepared.kind !== "ask") return prepared.kind;
  const env = options?.env ?? process.env;
  const key = present(options?.jevApiKey) ?? present(env.TYPESAFE_API_KEY) ?? present(env.JEV_API_KEY);
  const source = programOf(options, env);
  return voteDocuments(
    prepared.documents,
    (document) =>
      authorize(document, {
        capability: jevDecideCapability,
        ...(key === undefined ? {} : { config: { apiKey: key } }),
        ...source,
      }),
    options?.deadlineMs,
  );
}

export async function register(ctx: PermissionHost, options?: JevOptions): Promise<void> {
  const record: Record<string, unknown> = {};
  const raw = ctx.options;
  if (options === undefined && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    Object.assign(record, raw);
  }
  const program = typeof record.program === "string" ? record.program : undefined;
  const programPath = typeof record.programPath === "string" ? record.programPath : undefined;
  const jevApiKey = typeof record.jevApiKey === "string" ? record.jevApiKey : undefined;
  const acknowledgeFlags = options === undefined ? acknowledgeFlagsOf(record) : [];
  const resolved: JevOptions = options ?? {
    ...(program === undefined ? {} : { program }),
    ...(programPath === undefined ? {} : { programPath }),
    ...(acknowledgeFlags.length === 0 ? {} : { acknowledgeFlags }),
    ...(jevApiKey === undefined ? {} : { jevApiKey }),
  };
  await ctx.permission.hook("evaluate", async (event) => {
    const verdict = await evaluateCall(event, resolved);
    if (verdict === "ask" && event.effect === "deny") return;
    if (verdict !== "skip") event.effect = verdict;
  });
}

const plugin = {
  id: "inhuman.policy-opencode-jev",
  async setup(ctx: PermissionHost) {
    await register(ctx);
  },
};

export default plugin;
