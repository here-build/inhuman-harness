/**
 * Skill folders and bot markdown written from Settings.
 * Names cannot leave the root they were given.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { asSystemPrompt } from "@inhuman.tools/harness-commons";
import type { ReasoningEffort } from "@inhuman.tools/plugin-sdk";
import { discoverProjectSkills, type DiscoveredSkill } from "@inhuman.tools/project-skills";
import { parse as parseYaml, stringify } from "yaml";

import { botDefinitionSchema, type BotMcpGrant } from "@/extensions/schemas";

import { RpcInvalidParams } from "../../contract.js";
import { formatBotMarkdown } from "../bots/parse-bot-markdown.js";

/** Same gate as project-skills: tests do not touch the real home. */
export function skillsHome(): string | null {
  const override = process.env.INHUMAN_HOME?.trim();
  if (override !== undefined && override !== "") return override;
  if (process.env.VITEST) return null;
  return homedir();
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BOT_NAME = /^[\da-z][\w.-]*$/i;

export type SkillFile = DiscoveredSkill & { readonly scope: "project" | "home" };

const HOME_DRAWERS = [
  ".agents/skills",
  ".config/agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".copilot/skills",
  ".gemini/skills",
  ".grok/skills",
  ".config/opencode/skills",
  ".pi/agent/skills",
] as const;

export function listSkillFiles(project: string | null, home: string | null): SkillFile[] {
  const start = project ?? home;
  if (start == null || start === "") return [];
  return discoverProjectSkills(start, home).map((row) => ({
    ...row,
    scope: underHome(row.location, home) ? "home" : "project",
  }));
}

function underHome(location: string, home: string | null): boolean {
  if (home == null || home === "") return false;
  return HOME_DRAWERS.some((drawer) => {
    const root = join(home, ...drawer.split("/"));
    return location.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export function writeSkillFile(root: string, name: string, description: string, body: string): string {
  const dir = containedDir(root, skillFolder(name));
  mkdirSync(dir, { recursive: true });
  const file = join(realpathSync(dir), "SKILL.md");
  const head = stringify({ name, description }).trimEnd();
  writeFileSync(file, `---\n${head}\n---\n\n${body.replace(/\s+$/, "")}\n`);
  return file;
}

/** Markdown under the frontmatter. The list row does not carry this. */
export function skillBody(location: string): string {
  const text = readFileSync(location, "utf8").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return text.replace(/\s+$/, "");
  const close = text.indexOf("\n---", 3);
  if (close === -1) return text.replace(/\s+$/, "");
  return text
    .slice(close + 4)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

export function removeSkillFile(root: string, name: string): void {
  if (!SKILL_NAME.test(name) || name.length > 64) throw new RpcInvalidParams("invalid skill name");
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);
  const dir = join(base, ".agents", "skills", name);
  if (!existsSync(dir)) return;
  const placed = realpathSync(dir);
  if (placed !== base && !placed.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new RpcInvalidParams("path escaped its root");
  }
  rmSync(placed, { recursive: true, force: true });
}

export type BotAuthoring = {
  readonly invokes: readonly string[];
  readonly reasoningEffort: ReasoningEffort | null;
  readonly modelPreferences: readonly string[];
  readonly behavior: Readonly<Record<string, unknown>> | null;
  readonly mcp: readonly BotMcpGrant[];
};

/** Admitted fields a later save must keep when the caller omits them. Null when the file is missing or will not admit. */
export function readBotAuthoring(dir: string, name: string): BotAuthoring | null {
  let stem: string;
  try {
    stem = botStem(name);
  } catch {
    return null;
  }
  const file = join(dir, `${stem}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return null;
  const close = text.indexOf("\n---", 3);
  if (close === -1) return null;
  let bag: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(text.slice(3, close).replace(/^\n/, ""));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    bag = {};
    for (const [key, value] of Object.entries(parsed)) bag[key] = value;
  } catch {
    return null;
  }
  const named = bag.name;
  if (typeof named === "string" && named.trim() !== "" && named.trim() !== stem) return null;
  const admitted = botDefinitionSchema.safeParse({
    ...bag,
    name: stem,
    instructions: text.slice(close + 4).replace(/^\n/, ""),
  });
  if (!admitted.success) return null;
  const behavior = admitted.data.behavior;
  return {
    invokes: admitted.data.invokes,
    reasoningEffort: admitted.data.reasoningEffort ?? null,
    modelPreferences: admitted.data.modelPreferences,
    behavior: behavior == null ? null : recordOf(behavior),
    mcp: admitted.data.mcp,
  };
}

export function writeBotFile(
  dir: string,
  bot: {
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
    readonly recipeScope: "session" | "project" | "global";
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly keepAlive: boolean;
    readonly invokes?: readonly string[];
    readonly reasoningEffort?: ReasoningEffort | null;
    readonly modelPreferences?: readonly string[];
    readonly behavior?: Readonly<Record<string, unknown>> | null;
    readonly mcp?: readonly BotMcpGrant[] | null;
  },
): string {
  const file = join(containedDir(dir, "."), `${botStem(bot.name)}.md`);
  const recipeScope = bot.recipeScope === "project" ? "workspace" : bot.recipeScope;
  writeFileSync(
    file,
    formatBotMarkdown({
      name: bot.name,
      recipeScope,
      instructions: asSystemPrompt(bot.instructions),
      description: bot.description,
      tools: bot.tools,
      skills: bot.skills,
      keepAlive: bot.keepAlive,
      ...(bot.invokes == null ? {} : { invokes: bot.invokes }),
      ...(bot.reasoningEffort == null ? {} : { reasoningEffort: bot.reasoningEffort }),
      ...(bot.modelPreferences == null ? {} : { modelPreferences: bot.modelPreferences }),
      ...(bot.behavior == null ? {} : { behavior: bot.behavior }),
      ...(bot.mcp == null || bot.mcp.length === 0 ? {} : { mcp: bot.mcp }),
    }),
  );
  return file;
}

export function removeBotFile(dir: string, name: string): void {
  rmSync(join(containedDir(dir, "."), `${botStem(name)}.md`), { force: true });
}

function recordOf(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

function skillFolder(name: string): string {
  if (!SKILL_NAME.test(name) || name.length > 64) {
    throw new RpcInvalidParams("invalid skill name");
  }
  return join(".agents", "skills", name);
}

function botStem(name: string): string {
  if (!BOT_NAME.test(name) || name.includes("..")) throw new RpcInvalidParams("invalid bot name");
  return name;
}

/** `rel` stays inside `root` after the directory is created. */
function containedDir(root: string, rel: string): string {
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);
  const dir = join(base, rel);
  mkdirSync(dir, { recursive: true });
  const placed = realpathSync(dir);
  if (placed !== base && !placed.startsWith(base.endsWith(sep) ? base : base + sep)) {
    throw new RpcInvalidParams("path escaped its root");
  }
  return placed;
}
