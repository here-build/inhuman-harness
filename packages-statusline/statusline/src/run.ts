/**
 * Statusline left slot, off-document. `config.json` `statusline`:
 *
 *   omitted / "git"   branch, then a quiet clause of checkout states
 *   ""                cwd only
 *   anything else     a shell command; its first stdout line paints
 *
 * STATUS CLAUSE. Words, comma-separated, after U+001F (`STATUSLINE_NOTE_SEP`).
 * Order: the operation, then `detached`, then `conflicts` or `uncommitted`,
 * then `N local commit(s)`, then `N remote commit(s)`. A clean branch level
 * with its upstream has no clause. The branch string is the name.
 *
 * `N local commits` is ahead and `N remote commits` is behind (`# branch.ab`).
 * One is `commit`. A zero side is omitted. No upstream omits both; it does
 * not claim zero. Both stay off a detached head.
 *
 * The operation is the git directory. Porcelain v2 has no operation header.
 * `rebasing N/M` is rebase-merge `msgnum`/`end`, or rebase-apply `next`/`last`
 * when that directory is not an am. `applying N/M` is `rebase-apply/applying`.
 * `merging <branch>` is MERGE_HEAD; the branch is MERGE_MSG when the line is
 * git's own `Merge branch` or `Merge tag`, and otherwise the word is
 * `merging`. `cherry-picking <oid>` and `reverting <oid>` are the
 * 7-character ids. `bisecting` is BISECT_LOG and can sit beside another
 * operation. A missing fraction or oid drops that piece, not the word.
 * A rebase `head-name` of `refs/heads/*` replaces the detached oid and drops
 * `detached`. `bisecting` drops `detached` too: the oid is the commit under
 * test. Rebase wins over MERGE_HEAD.
 *
 * `conflicts` is a porcelain `u` row and replaces `uncommitted`.
 * `uncommitted` is any other staged, unstaged, or untracked row, including
 * a staged rename or delete. An ignored `!` row is neither.
 *
 * The probe stops when a conflict row has been seen, git exits, or the
 * deadline. Absence of a conflict is end of output, not the first row.
 * A finished scan with no work row is clean. A cut with no work row says
 * `status unknown` and still reports the operation and the commit counts
 * when those are known. A cut that already saw a work row says
 * `uncommitted` or `conflicts`. No branch, or a non-zero git exit, paints
 * nothing, unless the rebase directory still names the branch.
 *
 * The user's own config, so no policy floor and no job on the tape.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { DEFAULT_STATUSLINE, STATUSLINE_NOTE_SEP } from "./constants.js";
import { gitDirOf } from "./git.js";

const STATUSLINE_TIMEOUT_MS = 1000;
const GIT_STATUS = ["status", "--porcelain=v2", "--branch", "--ignore-submodules=untracked"];

type ReadEnd = "eof" | "enough" | "cut";

/**
 * Stdout until `enough`, exit, or the deadline; the group is then killed.
 * `eof` is exit 0. `enough` is the predicate. `cut` is the deadline (text
 * kept), or abort, spawn error, or a non-zero exit (text dropped). Own
 * process group: a shell's grandchildren would hold the pipe past its death.
 */
function readUntil(
  file: string,
  args: readonly string[],
  cwd: string,
  enough: (text: string) => boolean,
  signal?: AbortSignal,
): Promise<{ text: string; end: ReadEnd }> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const settle = (value: string, end: ReadEnd): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      try {
        if (child.pid != null) process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
      resolve({ text: value, end });
    };
    const fail = (): void => settle("", "cut");
    const timer = setTimeout(() => settle(text, "cut"), STATUSLINE_TIMEOUT_MS);
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted === true) fail();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
      if (enough(text)) settle(text, "enough");
    });
    child.on("error", fail);
    child.on("close", (code) => settle(code === 0 ? text : "", code === 0 ? "eof" : "cut"));
  });
}

const INDEX_MARK = "MADRCT";

type Dirt = {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
};

function noteDirt(dirt: Dirt, line: string): void {
  if (line.startsWith("? ")) {
    dirt.untracked = true;
    return;
  }
  if (line.startsWith("u ")) {
    dirt.conflict = true;
    return;
  }
  if ((!line.startsWith("1 ") && !line.startsWith("2 ")) || line.length < 5 || line.charAt(4) !== " ") return;
  if (INDEX_MARK.includes(line.charAt(2))) dirt.staged = true;
  if (INDEX_MARK.includes(line.charAt(3))) dirt.unstaged = true;
}

/** See preamble, STATUS CLAUSE. A conflict line counts once it ends in a newline. */
function conflictSeen(): (text: string) => boolean {
  let parsed = 0;
  let seen = false;
  return (text) => {
    if (seen) return true;
    const lines = text.slice(parsed).split(/\r?\n/);
    const tail = lines.pop() ?? "";
    parsed = text.length - tail.length;
    seen = lines.some((raw) => raw.trimEnd().startsWith("u "));
    return seen;
  };
}

function header(line: string, key: string): string | null {
  const prefix = `# ${key} `;
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

export type CheckoutOp =
  | { readonly kind: "rebase"; readonly branch: string; readonly step: number; readonly total: number }
  | { readonly kind: "merge"; readonly subject: string }
  | { readonly kind: "cherry-pick"; readonly oid: string }
  | { readonly kind: "revert"; readonly oid: string }
  | { readonly kind: "am"; readonly step: number; readonly total: number };

export type Checkout = {
  readonly op: CheckoutOp | null;
  readonly bisecting: boolean;
};

const NO_CHECKOUT: Checkout = { op: null, bisecting: false };

/** Porcelain v2 `--branch`, plus the git directory. See preamble, STATUS CLAUSE. */
export function formatGitStatus(
  text: string,
  scan: "complete" | "cut" = "complete",
  checkout: Checkout = NO_CHECKOUT,
): string {
  let oid = "";
  let head = "";
  let ahead = 0;
  let behind = 0;
  const dirt: Dirt = { staged: false, unstaged: false, untracked: false, conflict: false };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const oidH = header(line, "branch.oid");
    if (oidH !== null) {
      oid = oidH;
      continue;
    }
    const headH = header(line, "branch.head");
    if (headH !== null) {
      head = headH;
      continue;
    }
    const ab = header(line, "branch.ab");
    if (ab !== null) {
      const match = /^\+(\d+)\s+-(\d+)$/.exec(ab);
      const aheadText = match?.[1];
      const behindText = match?.[2];
      if (aheadText != null && behindText != null) {
        ahead = Number(aheadText);
        behind = Number(behindText);
      }
      continue;
    }
    noteDirt(dirt, line);
  }
  const porcelainDetached = head === "(detached)";
  const rebaseBranch = checkout.op?.kind === "rebase" ? checkout.op.branch : "";
  const name = rebaseBranch !== "" ? rebaseBranch : porcelainDetached ? shortOid(oid) : head;
  if (name === "") return "";
  const parts: string[] = [];
  if (checkout.op != null) parts.push(opPhrase(checkout.op));
  if (checkout.bisecting) parts.push("bisecting");
  if (porcelainDetached && rebaseBranch === "" && !checkout.bisecting) parts.push("detached");
  const dirty = dirt.staged || dirt.unstaged || dirt.untracked;
  if (scan === "cut" && !dirt.conflict && !dirty) parts.push("status unknown");
  else if (dirt.conflict) parts.push("conflicts");
  else if (dirty) parts.push("uncommitted");
  if (!porcelainDetached) {
    if (ahead > 0) parts.push(commitCount(ahead, "local"));
    if (behind > 0) parts.push(commitCount(behind, "remote"));
  }
  const note = parts.join(", ");
  return note === "" ? name : `${name}${STATUSLINE_NOTE_SEP}${note}`;
}

/** See preamble, STATUS CLAUSE. */
export function readCheckout(gitDir: string): Checkout {
  const bisecting = exists(join(gitDir, "BISECT_LOG"));
  const mergeBackend = join(gitDir, "rebase-merge");
  const applyBackend = join(gitDir, "rebase-apply");
  if (isDir(mergeBackend)) {
    return {
      op: {
        kind: "rebase",
        branch: branchRef(readFirstLine(join(mergeBackend, "head-name"))),
        step: nat(readFirstLine(join(mergeBackend, "msgnum"))),
        total: nat(readFirstLine(join(mergeBackend, "end"))),
      },
      bisecting,
    };
  }
  if (isDir(applyBackend)) {
    const step = nat(readFirstLine(join(applyBackend, "next")));
    const total = nat(readFirstLine(join(applyBackend, "last")));
    if (exists(join(applyBackend, "applying"))) return { op: { kind: "am", step, total }, bisecting };
    return {
      op: { kind: "rebase", branch: branchRef(readFirstLine(join(applyBackend, "head-name"))), step, total },
      bisecting,
    };
  }
  if (exists(join(gitDir, "MERGE_HEAD"))) {
    return { op: { kind: "merge", subject: mergeSubject(readFirstLine(join(gitDir, "MERGE_MSG"))) }, bisecting };
  }
  if (exists(join(gitDir, "CHERRY_PICK_HEAD"))) {
    return {
      op: { kind: "cherry-pick", oid: shortOid(readFirstLine(join(gitDir, "CHERRY_PICK_HEAD")) ?? "") },
      bisecting,
    };
  }
  if (exists(join(gitDir, "REVERT_HEAD"))) {
    return { op: { kind: "revert", oid: shortOid(readFirstLine(join(gitDir, "REVERT_HEAD")) ?? "") }, bisecting };
  }
  return { op: null, bisecting };
}

function opPhrase(op: CheckoutOp): string {
  switch (op.kind) {
    case "merge":
      return op.subject === "" ? "merging" : `merging ${op.subject}`;
    case "rebase":
      return fraction("rebasing", op.step, op.total);
    case "cherry-pick":
      return op.oid === "" ? "cherry-picking" : `cherry-picking ${op.oid}`;
    case "revert":
      return op.oid === "" ? "reverting" : `reverting ${op.oid}`;
    case "am":
      return fraction("applying", op.step, op.total);
  }
}

function fraction(word: string, step: number, total: number): string {
  return step > 0 && total > 0 ? `${word} ${step}/${total}` : word;
}

function commitCount(count: number, side: "local" | "remote"): string {
  return `${count} ${side} ${count === 1 ? "commit" : "commits"}`;
}

function shortOid(oid: string): string {
  return /^[0-9a-f]{7,}$/i.test(oid) ? oid.slice(0, 7) : "";
}

function branchRef(line: string | null): string {
  const prefix = "refs/heads/";
  if (!line?.startsWith(prefix)) return "";
  return line.slice(prefix.length);
}

function mergeSubject(line: string | null): string {
  if (line == null) return "";
  const branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(line);
  if (branch?.[1] != null && branch[1] !== "") return branch[1];
  const tag = /^Merge tag '([^']+)'/.exec(line);
  if (tag?.[1] != null && tag[1] !== "") return `tag ${tag[1]}`;
  return "";
}

function nat(line: string | null): number {
  if (line == null || !/^\d+$/.test(line)) return 0;
  return Number(line);
}

function readFirstLine(path: string): string | null {
  try {
    const line = readFileSync(path, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function gitDirFrom(cwd: string): string | null {
  let dir = resolvePath(cwd);
  for (;;) {
    const found = gitDirOf(dir);
    if (found != null) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export async function runStatusline(spec: string, cwd: string, signal?: AbortSignal): Promise<string> {
  const command = spec.trim();
  if (command === "") return "";
  if (command === DEFAULT_STATUSLINE) {
    const gitDir = gitDirFrom(cwd);
    const checkout = gitDir == null ? NO_CHECKOUT : readCheckout(gitDir);
    const read = await readUntil("git", GIT_STATUS, cwd, conflictSeen(), signal);
    return formatGitStatus(read.text, read.end === "cut" ? "cut" : "complete", checkout);
  }
  const read = await readUntil("/bin/sh", ["-c", command], cwd, (text) => /\S.*\n/.test(text), signal);
  if (read.end === "cut") return "";
  return firstLine(read.text);
}
