/**
 * Gentlemen's drawers first, then courtesy vendor dirs. Project walks
 * cwd to git root. One level. Farm symlink is not the Claude drawer.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 1024;
const GITDIR_LINE = /^gitdir:\s*(\S.*)$/m;
const PROJECT_DRAWERS = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".codex/skills",
  ".github/skills",
  ".gemini/skills",
  ".grok/skills",
  ".opencode/skills",
  ".pi/skills",
] as const;
const USER_DRAWERS = [
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

export type DiscoveredSkill = {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly invoke: string;
};

export function discoverProjectSkills(
  projectPath: string,
  home?: string | null,
  reserved: ReadonlySet<string> = new Set(),
): DiscoveredSkill[] {
  if (projectPath === "") return [];
  const seen = new Set<string>();
  const texts = new Map<string, Set<string>>();
  const project: DiscoveredSkill[] = [];
  for (const dir of walkToRepoRoot(projectPath)) {
    for (const drawer of PROJECT_DRAWERS) {
      scanDrawer(join(dir, ...drawer.split("/")), dir, project, seen, texts);
    }
  }
  const user: DiscoveredSkill[] = [];
  const userHome = home === undefined ? userSkillsHome() : home;
  if (userHome != null && userHome !== "") {
    for (const drawer of USER_DRAWERS) {
      scanDrawer(join(userHome, ...drawer.split("/")), userHome, user, seen, texts);
    }
  }
  return qualify([...project, ...user], reserved);
}

export type SkillExpansion = {
  /** What was typed. Unchanged when the slash is not a skill. */
  readonly prompt: string;
  /** Model injection when it differs from `prompt`. Null otherwise. */
  readonly derived: string | null;
};

export function expandSkillPrompt(
  text: string,
  skills: readonly { readonly name: string; readonly location: string; readonly invoke?: string }[],
  reserved: ReadonlySet<string>,
): SkillExpansion {
  const trimmed = text.trim();
  const hit = skillSlash(trimmed, skills, reserved);
  if (hit == null) return { prompt: trimmed, derived: null };
  let source;
  try {
    source = readFileSync(hit.skill.location, "utf8");
  } catch {
    return { prompt: trimmed, derived: null };
  }
  const parsed = parseSkillMarkdown(source, hit.skill.name);
  if (parsed == null) return { prompt: trimmed, derived: null };
  const body = parsed.body.trim();
  if (body === "") return { prompt: trimmed, derived: null };
  const injection = skillInjection(hit.skill.name, hit.skill.location, body, hit.rest);
  if (injection === trimmed) return { prompt: trimmed, derived: null };
  return { prompt: trimmed, derived: injection };
}

function skillInjection(name: string, location: string, body: string, rest: string): string {
  const block = `<skill name="${name}" location="${location}">\n${body}\n</skill>`;
  return rest === "" ? block : `${block}\n\n${rest}`;
}

/** Closed under Vitest unless `INHUMAN_HOME` points at a fixture. */
function userSkillsHome(): string | null {
  const override = process.env.INHUMAN_HOME?.trim();
  if (override !== undefined && override !== "") return override;
  if (process.env.VITEST) return null;
  return homedir();
}

function walkToRepoRoot(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    if (gitDirOf(dir) != null) return out;
    const parent = dirname(dir);
    if (parent === dir) return [resolve(start)];
    dir = parent;
  }
}

/** A `.git` directory, or a file whose `gitdir:` line resolves. A stray file does not count. */
function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return dot;
    if (!st.isFile()) return null;
    const match = GITDIR_LINE.exec(readFileSync(dot, "utf8"));
    const line = match?.[1];
    if (line == null) return null;
    return resolve(root, line.trim());
  } catch {
    return null;
  }
}

function scanDrawer(
  root: string,
  origin: string,
  out: DiscoveredSkill[],
  seen: Set<string>,
  texts: Map<string, Set<string>>,
): void {
  if (pointsAtClaude(root, origin) || pointsAtClaude(dirname(root), origin)) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (!NAME.test(name) || name.length > 64) continue;
    const location = join(root, name, "SKILL.md");
    let real;
    try {
      real = realpathSync(location);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    const parsed = parseSkillFile(location, name);
    if (parsed == null) continue;
    const bag = texts.get(name) ?? new Set<string>();
    if (bag.has(parsed.text)) continue;
    seen.add(real);
    bag.add(parsed.text);
    texts.set(name, bag);
    out.push({ name: parsed.name, description: parsed.description, location, invoke: parsed.name });
  }
}

function qualify(rows: DiscoveredSkill[], reserved: ReadonlySet<string>): DiscoveredSkill[] {
  const used = new Set<string>();
  const seenName = new Set<string>();
  const out: DiscoveredSkill[] = [];
  for (const row of rows) {
    const first = !seenName.has(row.name);
    seenName.add(row.name);
    const invoke =
      first && !reserved.has(row.name)
        ? row.name
        : first
          ? uniqueInvoke(`skill:${row.name}`, used)
          : uniqueInvoke(qualifyInvoke(row), used);
    used.add(invoke);
    used.add(row.name);
    out.push({ ...row, invoke });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function qualifyInvoke(row: DiscoveredSkill): string {
  const location = row.location.replaceAll("\\", "/");
  if (location.includes("/.config/agents/skills/")) return `config:${row.name}`;
  if (location.includes("/.config/opencode/skills/")) return `opencode:${row.name}`;
  if (location.includes("/.pi/agent/skills/")) return `pi:${row.name}`;
  if (location.includes("/.claude/skills/")) return `claude:${row.name}`;
  if (location.includes("/.agents/skills/")) return `agents:${row.name}`;
  if (location.includes("/.cursor/skills/")) return `cursor:${row.name}`;
  if (location.includes("/.codex/skills/")) return `codex:${row.name}`;
  if (location.includes("/.github/skills/")) return `github:${row.name}`;
  if (location.includes("/.copilot/skills/")) return `copilot:${row.name}`;
  if (location.includes("/.gemini/skills/")) return `gemini:${row.name}`;
  if (location.includes("/.grok/skills/")) return `grok:${row.name}`;
  if (location.includes("/.opencode/skills/")) return `opencode:${row.name}`;
  if (location.includes("/.pi/skills/")) return `pi:${row.name}`;
  return row.name;
}

function uniqueInvoke(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  for (;;) {
    const next = `${base}-${i}`;
    if (!used.has(next)) return next;
    i += 1;
  }
}

function skillSlash(
  text: string,
  skills: readonly { readonly name: string; readonly location: string; readonly invoke?: string }[],
  reserved: ReadonlySet<string>,
): { skill: { name: string; location: string }; rest: string } | null {
  const first = (text.split("\n")[0] ?? "").trim();
  const token = first.split(/\s/)[0] ?? "";
  if (!token.startsWith("/") || token.length < 2) return null;
  if (token.includes("/", 1) || token.includes("\\")) return null;
  const verb = token.slice(1);
  if (reserved.has(verb)) return null;
  const prefixed = verb.startsWith("skill:") ? verb.slice("skill:".length) : null;
  if (prefixed != null && !NAME.test(prefixed)) return null;
  const skill =
    prefixed != null
      ? skills.find((row) => row.name === prefixed)
      : (skills.find((row) => (row.invoke ?? row.name) === verb) ??
        skills.find((row) => row.name === verb && !reserved.has(row.name)));
  if (skill == null) return null;
  const rest = text.slice(text.indexOf(verb) + verb.length).trim();
  return { skill, rest };
}

function pointsAtClaude(path: string, projectPath: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = realpathSync(path);
    const claude = join(projectPath, ".claude");
    const claudeReal = existsSync(claude) ? realpathSync(claude) : resolve(claude);
    return target === claudeReal || target.startsWith(claudeReal + sep);
  } catch {
    return false;
  }
}

function parseSkillFile(location: string, dirName: string): { name: string; description: string; text: string } | null {
  let source;
  try {
    source = readFileSync(location, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSkillMarkdown(source, dirName);
  if (parsed == null) return null;
  return { name: parsed.name, description: parsed.description, text: parsed.text };
}

function parseSkillMarkdown(
  source: string,
  dirName: string,
): { name: string; description: string; body: string; text: string } | null {
  const text = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match == null) return null;
  const bag = frontmatterRecord(match[1]);
  if (bag == null) return null;
  const parsedName = typeof bag.name === "string" ? bag.name : "";
  const name = parsedName === "" ? dirName : parsedName;
  const description = typeof bag.description === "string" ? bag.description : "";
  if (name !== dirName || !NAME.test(name) || name.length > 64) return null;
  if (description === "" || description.length > DESCRIPTION_MAX) return null;
  return { name, description, body: text.slice(match[0].length), text };
}

function frontmatterRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(text) ?? {};
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const bag: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(parsed)) bag[key] = item;
  return bag;
}
