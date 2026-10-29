/**
 * Thin frontmatter for `~/.inhuman/bots/*.md`. Unknown keys fail the file.
 * YAML maps to a BotDefinition; Zod admits that definition. A miss is not a
 * blank face — overlay skips and fail()s.
 */
import type { BotDefinition } from "@inhuman.tools/plugin-sdk";
import { stringify as stringifyYaml } from "yaml";

type MarkdownMcpGrant = {
  readonly server: string;
  readonly tools?: readonly string[];
  readonly account?: string;
  readonly session?: string;
};

export function formatBotMarkdown(
  bot: Omit<BotDefinition, "mcp"> & {
    readonly behavior?: Readonly<Record<string, unknown>> | null;
    readonly mcp?: readonly MarkdownMcpGrant[] | null;
  },
): string {
  const { instructions, behavior, mcp, ...head } = bot;
  const record = {
    ...head,
    ...(behavior == null ? {} : { behavior }),
    ...(mcp == null || mcp.length === 0 ? {} : { mcp: mcp.map(grantRecord) }),
  };
  return `---\n${stringifyYaml(record).trimEnd()}\n---\n\n${instructions}\n`;
}

function grantRecord(grant: MarkdownMcpGrant): Record<string, unknown> {
  const row: Record<string, unknown> = { server: grant.server };
  if (grant.tools != null) row.tools = [...grant.tools];
  if (grant.account != null) row.account = grant.account;
  if (grant.session != null) row.session = grant.session;
  return row;
}
