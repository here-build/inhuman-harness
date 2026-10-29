/**
 * Project and user instruction files.
 *
 * Discovery follows the shape the other harnesses converged on, with one
 * explicit rule for the case they each resolve differently: a directory that
 * has both `AGENTS.md` and `CLAUDE.md` contributes both, agents first. A
 * directory contributes at most one file per family, so `AGENTS.override.md`
 * replaces `AGENTS.md` there and `.claude/CLAUDE.md` replaces `CLAUDE.md`.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const BYTE_CAP = 32 * 1024;

const AGENTS_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

export type InstructionSource = {
  readonly path: string;
  readonly text: string;
};

/** User files, then project files from the git root down to `cwd`. */
export function discoverInstructions(cwd: string): readonly InstructionSource[] {
  const here = canonical(cwd);
  const root = gitRoot(here) ?? here;
  const sources: InstructionSource[] = [];
  let used = 0;
  const take = (path: string): void => {
    if (used >= BYTE_CAP) return;
    const text = readInstruction(path);
    if (text == null) return;
    const room = BYTE_CAP - used;
    const body = Buffer.byteLength(text) > room ? truncate(text, room) : text;
    if (body.trim() === "") return;
    sources.push({ path, text: body });
    used += Buffer.byteLength(body);
  };

  const home = homedir();
  for (const name of AGENTS_NAMES) {
    const path = join(home, ".inhuman", name);
    if (!existsAsFile(path)) continue;
    take(path);
    break;
  }
  const userClaude = join(home, ".claude", "CLAUDE.md");
  if (existsAsFile(userClaude)) take(userClaude);

  for (const dir of walkDown(root, here)) {
    take(firstExisting(dir, AGENTS_NAMES));
    take(firstExisting(dir, [join(".claude", "CLAUDE.md"), "CLAUDE.md"]));
    const local = join(dir, "CLAUDE.local.md");
    if (existsAsFile(local)) take(local);
  }
  return sources;
}

function firstExisting(dir: string, names: readonly string[]): string {
  for (const name of names) {
    const path = join(dir, name);
    if (existsAsFile(path)) return path;
  }
  return "";
}

function readInstruction(path: string): string | null {
  if (path === "" || !existsAsFile(path)) return null;
  try {
    return readFileSync(path, "utf8")
      .replace(/^\uFEFF/, "")
      .trim();
  } catch {
    return null;
  }
}

function truncate(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  const sliced = buffer
    .subarray(0, bytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "")
    .trimEnd();
  return `${sliced}\n…[truncated]`;
}

/** Directories from `root` down to `cwd`, root first. `cwd` outside `root` stands alone. */
function walkDown(root: string, cwd: string): readonly string[] {
  const fromRoot = relative(root, cwd);
  const inside = fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.startsWith("/"));
  const dirs: string[] = [];
  let dir = cwd;
  while (dir !== root) {
    dirs.push(dir);
    if (!inside) break;
    dir = dirname(dir);
  }
  if (inside) dirs.push(root);
  dirs.reverse();
  return dirs;
}

function canonical(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function gitRoot(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    if (existsAsFile(join(dir, ".git")) || isDirectory(join(dir, ".git"))) return canonical(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
