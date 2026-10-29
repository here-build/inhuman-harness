/**
 * R2: the resolved horizon of one tool job, stamped at admit. The kind comes
 * from catalog facts read once, so later catalog churn cannot reclassify
 * history; the projection reads the stamp and nothing else.
 */
import {
  AgentCallbackJob,
  AgentCallJob,
  AgentMessageJob,
  AgentNotifyJob,
  BotCallJob,
  ContextNeedToolJob,
  FileMutateToolJob,
  MCPToolJob,
  ProgrammaticJob,
  ToolCallJob,
  WebExtractToolJob,
  WebSearchToolJob,
} from "@inhuman.tools/harness-model";
import { z } from "zod";

import { ruleFor, type ResolvedPolicy } from "./resolve.js";
import { horizonSchema, leaveSchema, type ConcreteRule, type RetentionKind, type RuleInput } from "./schema.js";

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "fff_search"]);
const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_dir", "glob"]);
const COMM_TOOLS: ReadonlySet<string> = new Set(["update_metadata"]);
export const WRITE_ARG_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

export type RetainedJob = ToolCallJob | ProgrammaticJob;

export function kindOfJob(job: RetainedJob, entryClass?: string): RetentionKind {
  if (job instanceof ProgrammaticJob) return "tool.program";
  if (job instanceof MCPToolJob) return "tool.mcp";
  if (job instanceof WebSearchToolJob) return "tool.web.search";
  if (job instanceof WebExtractToolJob) return "tool.web.fetch";
  if (job instanceof FileMutateToolJob) return "tool.write";
  if (job instanceof AgentCallJob || job instanceof BotCallJob || job instanceof AgentMessageJob) return "tool.agent";
  if (job instanceof AgentCallbackJob || job instanceof AgentNotifyJob || job instanceof ContextNeedToolJob) {
    return "tool.comm";
  }
  if (job.name === "shell") return "tool.shell";
  if (SEARCH_TOOLS.has(job.name)) return "tool.search";
  if (READ_TOOLS.has(job.name) || entryClass === "read") return "tool.read";
  if (COMM_TOOLS.has(job.name)) return "tool.comm";
  return "tool.other";
}

/** `tools` keys that can name this job, most specific first. */
export function namesOfJob(job: RetainedJob): string[] {
  if (job instanceof ProgrammaticJob) return [job.toolName];
  if (job instanceof MCPToolJob) return [`mcp:${job.connectionKey}/${job.serverToolName}`, job.name];
  return [job.name];
}

const stampSchema = z.object({
  kind: z.string(),
  keep: z.array(horizonSchema),
  leave: leaveSchema,
  minChars: z.number().int().min(0),
  onError: z.object({ keep: z.array(horizonSchema), leave: leaveSchema }).nullable(),
  args: z
    .object({
      keep: z.array(horizonSchema),
      leave: leaveSchema,
      minChars: z.number().int().min(0),
    })
    .optional(),
});

export type JobStamp = {
  readonly kind: string;
  readonly rule: ConcreteRule;
  /** The rule for the call's own arguments (`write_file` / `edit_file` content). */
  readonly args?: Pick<ConcreteRule, "keep" | "leave" | "minChars">;
};

export function stampJobRetention(
  job: RetainedJob,
  policy: ResolvedPolicy,
  opts: { readonly entryClass?: string; readonly hint?: RuleInput } = {},
): void {
  const kind = kindOfJob(job, opts.entryClass);
  const names = namesOfJob(job);
  const rule = ruleFor(policy, { kind, names, ...(opts.hint === undefined ? {} : { hint: opts.hint }) });
  const argsRule =
    job instanceof ToolCallJob && WRITE_ARG_TOOLS.has(job.name)
      ? ruleFor(policy, { kind: "tool.args.write", names: [] })
      : undefined;
  job.retentionJson = JSON.stringify({
    kind,
    keep: rule.keep,
    leave: rule.leave,
    minChars: rule.minChars,
    onError: rule.onError,
    ...(argsRule === undefined
      ? {}
      : { args: { keep: argsRule.keep, leave: argsRule.leave, minChars: argsRule.minChars } }),
  });
}

const stamps = new Map<string, JobStamp | null>();

export function parseJobStamp(json: string): JobStamp | null {
  if (json === "") return null;
  const hit = stamps.get(json);
  if (hit !== undefined) return hit;
  let out: JobStamp | null = null;
  try {
    const parsed = stampSchema.safeParse(JSON.parse(json));
    if (parsed.success) {
      const { kind, args, ...rule } = parsed.data;
      out = { kind, rule, ...(args === undefined ? {} : { args }) };
    }
  } catch {
    out = null;
  }
  if (stamps.size > 512) stamps.clear();
  stamps.set(json, out);
  return out;
}
