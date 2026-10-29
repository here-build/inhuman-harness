/**
 * OpenClaw `before_tool_call` plugin. Structured output, plus the host decision runtime.
 * Sage and Jev are sibling packages. They import `operands` and `authorizeOperands`.
 * Code-mode `exec` is left to the host. `apply_patch` is judged per derived path, not by patch text.
 */
import {
  decideAnswer,
  decidePrompt,
  structuredOutputDecideCapability,
  type DecideRequest,
} from "@inhuman.tools/env-capability-decision-structured";
import {
  acknowledgeRequirement,
  authorize,
  blockReason,
  checkToolPath,
  defaultPolicy as policy,
  floorVerdictOf,
  mergeAcknowledge,
  parseAcknowledge,
  type AckFlag,
} from "@inhuman.tools/policy";

export type Verdict = "allow" | "deny";

export type Call =
  | { readonly kind: "bash"; readonly command: string }
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "read"; readonly path: string };

export type Block = { readonly block: true; readonly blockReason: string };

export type BeforeToolCallEvent = {
  readonly toolName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly toolKind?: string;
  readonly derivedPaths?: readonly unknown[];
};

export type HookCtx = {
  readonly agentId?: string;
  readonly abortSignal?: AbortSignal;
};

export type DecisionValue =
  { readonly value: "allow" | "deny" | null } | { readonly unavailable: true; readonly reason?: string };

export type OpenClawApi = {
  readonly pluginConfig?: unknown;
  readonly runtime?: {
    readonly decisions?: {
      evaluate(input: {
        readonly agentId?: string;
        readonly document: string;
        readonly signal?: AbortSignal;
        readonly timeoutMs: number;
      }): Promise<DecisionValue>;
    };
    readonly llm?: {
      complete(input: {
        readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
        readonly responseFormat?: Record<string, unknown>;
        readonly purpose?: string;
        readonly signal?: AbortSignal;
      }): Promise<{ readonly text: string }>;
    };
  };
  on(
    hook: "before_tool_call",
    handler: (event: BeforeToolCallEvent, ctx: HookCtx) => Promise<Block | undefined> | Block | undefined,
    options?: { readonly matcher?: readonly string[] },
  ): void;
};

export type Operands =
  | { readonly kind: "skip" }
  | { readonly kind: "invalid" }
  | { readonly kind: "calls"; readonly calls: readonly Call[] };

export const MATCHED_TOOLS = ["exec", "write", "edit", "apply_patch", "read"] as const;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function stringParam(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function blocked(reason: string): Block {
  return { block: true, blockReason: reason };
}

export function operands(event: BeforeToolCallEvent): Operands {
  switch (event.toolName) {
    case "exec": {
      if (event.toolKind === "code_mode_exec") return { kind: "skip" };
      const command = stringParam(event.params, "command");
      if (command === undefined) return { kind: "invalid" };
      return { kind: "calls", calls: [{ kind: "bash", command }] };
    }
    case "write":
    case "edit": {
      const file = stringParam(event.params, "path") ?? stringParam(event.params, "file_path");
      if (file === undefined) return { kind: "invalid" };
      return { kind: "calls", calls: [{ kind: "write", path: file }] };
    }
    case "read": {
      const file = stringParam(event.params, "path") ?? stringParam(event.params, "file_path");
      if (file === undefined) return { kind: "invalid" };
      return { kind: "calls", calls: [{ kind: "read", path: file }] };
    }
    case "apply_patch": {
      const entries = event.derivedPaths;
      if (!Array.isArray(entries) || entries.length === 0) return { kind: "invalid" };
      const patched: Call[] = [];
      for (const entry of entries) {
        if (typeof entry !== "string" || entry === "") return { kind: "invalid" };
        patched.push({ kind: "write", path: entry });
      }
      return { kind: "calls", calls: patched };
    }
    default:
      return { kind: "skip" };
  }
}

export function configRecord(api: OpenClawApi): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const rawConfig = api.pluginConfig;
  if (typeof rawConfig === "object" && rawConfig !== null && !Array.isArray(rawConfig)) {
    Object.assign(record, rawConfig);
  }
  return record;
}

export function authorizationEnv(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  const path = typeof record.authorizationPath === "string" ? present(record.authorizationPath) : undefined;
  const file = path ?? present(env.POLICY_AUTHORIZE);
  return file === undefined ? undefined : { POLICY_AUTHORIZE: file };
}

/** Flags from the plugin config: `acknowledge` (user) and `projectAcknowledge`. Invalid throws. */
export function acknowledgeFlagsOf(record: Readonly<Record<string, unknown>>): readonly AckFlag[] {
  return mergeAcknowledge(parseAcknowledge(record.acknowledge), parseAcknowledge(record.projectAcknowledge));
}

/** OpenClaw has no prompt path for a plugin, so a flagged call that would run is blocked. */
export function acknowledgeBlock(
  flags: readonly AckFlag[],
  toolName: string,
  calls: readonly Call[],
): Block | undefined {
  if (flags.length === 0) return undefined;
  for (const call of calls.length === 0 ? [undefined] : calls) {
    const verdict = call === undefined ? undefined : floorVerdictOf(call);
    const requirement = acknowledgeRequirement(flags, {
      tool: toolName,
      ...(verdict === undefined ? {} : { verdict }),
    });
    if (requirement !== null) return blocked(`${blockReason(requirement)}; confirm in OpenClaw and retry`);
  }
  return undefined;
}

export async function authorizeOperands(
  calls: readonly Call[],
  vote: (text: string) => Promise<Verdict>,
  acknowledge?: { readonly flags: readonly AckFlag[]; readonly toolName: string },
): Promise<Block | undefined> {
  const denied = await authorizeAll(calls, vote);
  if (denied !== undefined || acknowledge === undefined) return denied;
  return acknowledgeBlock(acknowledge.flags, acknowledge.toolName, calls);
}

async function authorizeAll(
  calls: readonly Call[],
  vote: (text: string) => Promise<Verdict>,
): Promise<Block | undefined> {
  for (const call of calls) {
    const disposition = call.kind === "bash" ? policy.bash(call.command) : checkToolPath(call.kind, call.path);
    if (disposition === "policyApprove") continue;
    if (disposition === "block") return blocked("blocked by policy floor");
    const text = call.kind === "bash" ? call.command : call.path;
    let verdict: Verdict;
    try {
      verdict = await vote(text);
    } catch {
      verdict = "deny";
    }
    if (verdict !== "allow") return blocked("not authorized");
  }
  return undefined;
}

const plugin = {
  id: "policy-openclaw",
  register(api: OpenClawApi) {
    api.on("before_tool_call", (event, ctx) => handle(event, api, ctx, process.env), {
      matcher: matcherFor(api),
    });
  },
};

export default plugin;

/**
 * Tool and mcp flags name tools outside `MATCHED_TOOLS`; with one configured every tool reaches the
 * handler, which lets only the gated five through the judge. Unparseable flags keep the default
 * matcher; `handle` reports them.
 */
export function matcherFor(api: OpenClawApi): readonly string[] | undefined {
  try {
    const flags = acknowledgeFlagsOf(configRecord(api));
    return flags.some((flag) => "tool" in flag.match || "mcp" in flag.match) ? undefined : MATCHED_TOOLS;
  } catch {
    return undefined;
  }
}

export async function handle(
  event: BeforeToolCallEvent,
  api: OpenClawApi,
  ctx: HookCtx = {},
  env: NodeJS.ProcessEnv = {},
): Promise<Block | undefined> {
  const record = configRecord(api);
  let flags: readonly AckFlag[];
  try {
    flags = acknowledgeFlagsOf(record);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "invalid acknowledge config");
  }
  const parsed = operands(event);
  if (parsed.kind === "skip") return acknowledgeBlock(flags, event.toolName, []);
  if (parsed.kind === "invalid") return blocked("missing command or path");
  const programEnv = authorizationEnv(record, env);
  return authorizeOperands(
    parsed.calls,
    async (text) => {
      const decisions = api.runtime?.decisions;
      if (decisions !== undefined) {
        const raw = await decisions.evaluate({
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          document: text,
          ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
          // The default 15s hook budget blocks the tool and does not abort this handler.
          timeoutMs: 10_000,
        });
        const roleOff = "unavailable" in raw && (raw.reason === "disabled" || raw.reason === "not-configured");
        if (!("unavailable" in raw) && (raw.value === "allow" || raw.value === "deny")) return raw.value;
        if (!roleOff) return "deny";
      }
      const llm = api.runtime?.llm;
      const verdict = await authorize(text, {
        capability: structuredOutputDecideCapability,
        ...(llm === undefined
          ? {}
          : {
              config: {
                complete: async (request: DecideRequest) => {
                  const prompt = decidePrompt(request);
                  const result = await llm.complete({
                    messages: [
                      { role: "system", content: prompt.system },
                      { role: "user", content: prompt.user },
                    ],
                    responseFormat: {
                      type: "json_schema",
                      json_schema: { name: "decision", strict: true, schema: prompt.schema },
                    },
                    purpose: "policy judge",
                    ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
                  });
                  return decideAnswer(result.text);
                },
              },
            }),
        ...(programEnv === undefined ? {} : { env: programEnv }),
      });
      return verdict === "allow" ? "allow" : "deny";
    },
    { flags, toolName: event.toolName },
  );
}
