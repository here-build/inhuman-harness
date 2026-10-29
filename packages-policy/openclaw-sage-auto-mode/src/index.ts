/**
 * OpenClaw `before_tool_call` plugin on Sage.
 * A set `sageApiKey`, including an empty string, does not fall through to `SAGE_API_KEY`.
 * This package does not call `api.runtime.decisions`.
 */
import { sageDecideCapability } from "@inhuman.tools/env-capability-decision-sage";
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
  id: "policy-openclaw-sage",
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
  if (Object.hasOwn(record, "sageApiKey")) {
    const value = record.sageApiKey;
    key = typeof value === "string" ? present(value) : undefined;
  } else {
    key = present(env.SAGE_API_KEY);
  }
  return authorizeOperands(
    parsed.calls,
    async (text) => {
      const verdict = await authorize(text, {
        capability: sageDecideCapability,
        ...(key === undefined ? {} : { config: { apiKey: key } }),
        ...(programEnv === undefined ? {} : { env: programEnv }),
      });
      return verdict === "allow" ? "allow" : "deny";
    },
    { flags, toolName: event.toolName },
  );
}
