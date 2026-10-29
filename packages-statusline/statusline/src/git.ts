/**
 * Statusline git clock. Branch / tip / fetch live in `.git` files; dirty is
 * the worktree and still needs porcelain. Watch the files, then re-run.
 *
 *   HEAD              ref: refs/heads/<branch>  |  raw oid (detached)
 *   refs/heads/*      tip of that branch
 *   packed-refs       packed tips
 *   FETCH_HEAD        last fetch
 *   refs/remotes/*    tracking tips (ahead/behind vs HEAD)
 *   index             staged (not index.lock)
 *   COMMIT_EDITMSG    a commit just landed
 *   config            upstream
 *   ORIG_HEAD / MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD
 *   rebase-merge/msgnum, rebase-apply/next, BISECT_LOG   operation progress
 *
 * `.git` may be a `gitdir:` file (linked worktree). `commondir` is the shared
 * repo. Ignore `objects/`, `*.lock`, watchman cookies — status must not loop.
 */
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

const GITDIR_LINE = /^gitdir:\s*(\S.*)$/m;
const WRAPPERS = /^(timeout|time|env|nice|nohup|ionice)$/i;

export function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return dot;
    if (!st.isFile()) return null;
    const match = GITDIR_LINE.exec(readFileSync(dot, "utf8"));
    if (match == null) return null;
    return resolve(root, match[1]!.trim());
  } catch {
    return null;
  }
}

export function gitCommonDir(gitDir: string): string {
  try {
    const raw = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (raw !== "") return resolve(gitDir, raw);
  } catch {
    /* main worktree has no commondir */
  }
  return gitDir;
}

const TOP = [
  "HEAD",
  "index",
  "packed-refs",
  "FETCH_HEAD",
  "COMMIT_EDITMSG",
  "config",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
] as const;

const NESTED = ["rebase-merge/msgnum", "rebase-apply/next"] as const;

export function gitWatchPaths(root: string): string[] {
  const gitDir = gitDirOf(root);
  if (gitDir == null) return [];
  const dirs = new Set([gitDir, gitCommonDir(gitDir)]);
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of TOP) paths.push(join(dir, name));
    for (const name of NESTED) paths.push(join(dir, name));
    paths.push(join(dir, "refs", "heads"), join(dir, "refs", "remotes"));
  }
  return paths;
}

export function isGitShellCommand(command: string): boolean {
  for (const part of command.split(/\s*(?:&&|\|\||;)\s*/)) {
    if (/(?:^|[\\/])git(?:\.exe)?$/i.test(argv0(part))) return true;
  }
  return false;
}

function argv0(part: string): string {
  const rest = part.trim().replace(/^(?:[A-Z_]\w*=\S*\s+)+/i, "");
  const bits = rest.split(/\s+/).filter((bit) => bit !== "");
  let i = 0;
  while (i < bits.length && WRAPPERS.test(bits[i]!)) {
    i += 1;
    if (i < bits.length && /^\d/.test(bits[i]!)) i += 1;
  }
  return bits[i] ?? "";
}

const WATCHED_NAMES = new Set<string>([...TOP, "rebase-merge", "rebase-apply"]);

/**
 * Calls `onChange` (debounced) when the git state of `root` moves. Watches the
 * git directories, not the files: git renames a new `index` / `HEAD` over the
 * old one, and a watch on the file itself goes deaf after the first commit.
 * Returns a stop function. A missing repo or an unwatchable directory is a no-op.
 */
export function watchGit(root: string, onChange: () => void, debounceMs = 120): () => void {
  const gitDir = gitDirOf(root);
  if (gitDir == null) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const fire = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) onChange();
    }, debounceMs);
    timer.unref();
  };
  const watchers = new Map<string, FSWatcher>();
  const add = (dir: string, recursive: boolean, keep: (name: string) => boolean): void => {
    if (stopped || watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { persistent: false, recursive }, (_event, name) => {
        if (name == null || keep(String(name))) fire();
      });
      // A rebase directory is removed when the rebase ends; it may come back.
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
    } catch {
      // absent or unwatchable: nothing to hear
    }
  };
  const progress = (dir: string): void => {
    add(join(dir, "rebase-merge"), false, (name) => name === "msgnum");
    add(join(dir, "rebase-apply"), false, (name) => name === "next");
  };
  for (const dir of new Set([gitDir, gitCommonDir(gitDir)])) {
    add(dir, false, (name) => {
      if (name === "rebase-merge" || name === "rebase-apply") progress(dir);
      return WATCHED_NAMES.has(name);
    });
    progress(dir);
    add(join(dir, "refs"), true, (name) => !name.endsWith(".lock"));
  }
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
