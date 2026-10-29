/**
 * OpenClaw `before_tool_call` plugin on Jev.
 * A set `jevApiKey`, including an empty string, does not fall through to the environment.
 * This package does not call `api.runtime.decisions`. `SAGE_API_KEY` is not read.
 */
import { jevDecideCapability } from "@inhuman.tools/env-capability-decision-jev";
import { authorize } from "@inhuman.tools/policy";
import {
  acknowledgeBlock,
  acknowledgeFlagsOf,
  matcherFor,
  authorizationEnv,
  authorizeOperands,
  blocked,
  configRecord,
  operands,
  type BeforeToolCallEvent,
  type Block,
  type HookCtx,
  type OpenClawApi,
} from "@inhuman.tools/policy-openclaw";

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

const plugin = {
  id: "policy-openclaw-jev",
  register(api: OpenClawApi) {
    api.on("before_tool_call", (event, ctx) => handle(event, api, ctx, process.env), {
      matcher: matcherFor(api),
    });
  },
};

export default plugin;

export async function handle(
  event: BeforeToolCallEvent,
  api: OpenClawApi,
  _ctx: HookCtx = {},
  env: NodeJS.ProcessEnv = {},
): Promise<Block | undefined> {
  const record = configRecord(api);
  let flags: ReturnType<typeof acknowledgeFlagsOf>;
  try {
    flags = acknowledgeFlagsOf(record);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "invalid acknowledge config");
  }
  const parsed = operands(event);
  if (parsed.kind === "skip") return acknowledgeBlock(flags, event.toolName, []);
  if (parsed.kind === "invalid") return blocked("missing command or path");
  const programEnv = authorizationEnv(record, env);
  let key: string | undefined;
  if (Object.hasOwn(record, "jevApiKey")) {
    const value = record.jevApiKey;
    key = typeof value === "string" ? present(value) : undefined;
  } else {
    key = present(env.TYPESAFE_API_KEY) ?? present(env.JEV_API_KEY);
  }
  return authorizeOperands(
    parsed.calls,
    async (text) => {
      const verdict = await authorize(text, {
        capability: jevDecideCapability,
        ...(key === undefined ? {} : { config: { apiKey: key } }),
        ...(programEnv === undefined ? {} : { env: programEnv }),
      });
      return verdict === "allow" ? "allow" : "deny";
    },
    { flags, toolName: event.toolName },
  );
}
