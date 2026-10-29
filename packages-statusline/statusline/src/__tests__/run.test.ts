import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { DEFAULT_STATUSLINE, formatPlain, STATUSLINE_NOTE_SEP, statusNote } from "../constants.js";
import { gitCommonDir, gitDirOf, gitWatchPaths, isGitShellCommand, watchGit } from "../git.js";
import { formatGitStatus, readCheckout, runStatusline } from "../run.js";

describe("statusline", () => {
  const slot = (name: string, note = ""): string => (note === "" ? name : `${name}${STATUSLINE_NOTE_SEP}${note}`);

  it("git shell commands and gitWatchPaths; runStatusline paints the first line", async () => {
    expect({
      status: isGitShellCommand("git status"),
      fetch: isGitShellCommand("GIT_OPTIONAL_LOCKS=0 git fetch"),
      abs: isGitShellCommand("/usr/bin/git commit -m x"),
      glue: isGitShellCommand("cd src && git checkout -b x"),
      timeout: isGitShellCommand("timeout 5 git pull"),
      ls: isGitShellCommand("ls"),
      echo: isGitShellCommand("echo git"),
    }).toEqual({
      status: true,
      fetch: true,
      abs: true,
      glue: true,
      timeout: true,
      ls: false,
      echo: false,
    });

    const root = await mkdtemp(join(tmpdir(), "harness-git-watch-"));
    expect(gitDirOf(root)).toBeNull();
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    const gitDir = gitDirOf(root);
    expect(gitDir).toBe(join(root, ".git"));
    expect(gitCommonDir(gitDir!)).toBe(gitDir);
    const paths = gitWatchPaths(root);
    const linked = await mkdtemp(join(tmpdir(), "harness-git-wt-"));
    await writeFile(join(linked, ".git"), `gitdir: ${join(gitDir!, "worktrees", "x")}\n`);
    expect({
      head: paths.includes(join(gitDir!, "HEAD")),
      refs: paths.includes(join(gitDir!, "refs", "heads")),
      remotes: paths.includes(join(gitDir!, "refs", "remotes")),
      fetch: paths.includes(join(gitDir!, "FETCH_HEAD")),
      index: paths.includes(join(gitDir!, "index")),
      objects: paths.some((path) => /(?:^|[\\/])objects(?:[\\/]|$)/.test(path)),
      rebase: paths.includes(join(gitDir!, "rebase-merge", "msgnum")),
      apply: paths.includes(join(gitDir!, "rebase-apply", "next")),
      bisect: paths.includes(join(gitDir!, "BISECT_LOG")),
      linked: gitDirOf(linked),
    }).toEqual({
      head: true,
      refs: true,
      remotes: true,
      fetch: true,
      index: true,
      objects: false,
      rebase: true,
      apply: true,
      bisect: true,
      linked: join(gitDir!, "worktrees", "x"),
    });

    const workspace = await mkdtemp(join(tmpdir(), "harness-statusline-p-"));
    const started = Date.now();
    expect({
      painted: await runStatusline("echo hello", workspace),
      first: await runStatusline("printf '\\n  a \\nb\\n'", workspace),
      early: await runStatusline("echo first; sleep 5", workspace),
      fail: await runStatusline("exit 3", workspace),
      off: await runStatusline("  ", workspace),
      hung: await runStatusline("sleep 5", workspace),
      bounded: Date.now() - started < 3_000,
    }).toEqual({ painted: "hello", first: "a", early: "first", fail: "", off: "", hung: "", bounded: true });
  });

  it("formatGitStatus CHARACTERIZE porcelain v2→string; built-in git paints branch/ahead/dirty/detached", async () => {
    const head = "# branch.oid abcdef0123456789\n# branch.head main\n";
    expect({
      main: formatGitStatus(head),
      dirty: formatGitStatus(`${head}? x\n`),
      level: formatGitStatus(`${head}# branch.ab +0 -0\n`),
      ahead: formatGitStatus(`${head}# branch.ab +2 -0\n`),
      aheadOne: formatGitStatus(`${head}# branch.ab +1 -0\n`),
      behind: formatGitStatus(`${head}# branch.ab +0 -3\n`),
      behindOne: formatGitStatus(`${head}# branch.ab +0 -1\n`),
      behindDirty: formatGitStatus(`${head}# branch.ab +0 -3\n? x\n`),
      diverged: formatGitStatus(`${head}# branch.ab +1 -4\n1 .M N... x\n`),
      divergedClean: formatGitStatus(`${head}# branch.ab +1 -4\n`),
      staged: formatGitStatus(`${head}1 M. N... x\n`),
      both: formatGitStatus(`${head}1 MM N... x\n`),
      order: formatGitStatus(`${head}? y\n1 A. N... x\n`),
      conflict: formatGitStatus(`${head}u UU N... x\n`),
      conflictAhead: formatGitStatus(`${head}# branch.ab +1 -0\nu UU N... x\n? y\n`),
      ignored: formatGitStatus(`${head}! node_modules\n`),
      rename: formatGitStatus(`${head}2 R. N... 100644 100644 100644 ab ab ab dest\torig\n`),
      detached: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n"),
      detachedDirty: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n? x\n"),
      detachedAhead: formatGitStatus(
        "# branch.oid abcdef0123456789\n# branch.head (detached)\n# branch.ab +3 -1\n? x\n",
      ),
      detachedConflict: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\nu UU N... x\n"),
      headless: formatGitStatus("1 .M N... 100644 100644 100644 ab ab src/x.png\n"),
      fatal: formatGitStatus("fatal: not a git repository (or any of the parent directories): .git\n"),
      cut: formatGitStatus(`${head}? x\n1 M. N... x\n`, "cut"),
      cutConflict: formatGitStatus(`${head}u UU N... x\n`, "cut"),
      cutHeader: formatGitStatus(head, "cut"),
      cutDiverged: formatGitStatus(`${head}# branch.ab +1 -4\n`, "cut"),
      detachedCut: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n", "cut"),
      cutEmpty: formatGitStatus("", "cut"),
      rebasing: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n", "complete", {
        op: { kind: "rebase", branch: "reb", step: 2, total: 6 },
        bisecting: false,
      }),
      rebasingDetached: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n? x\n", "complete", {
        op: { kind: "rebase", branch: "", step: 2, total: 2 },
        bisecting: false,
      }),
      rebasingPlain: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n", "complete", {
        op: { kind: "rebase", branch: "reb", step: 0, total: 0 },
        bisecting: false,
      }),
      mergingConflict: formatGitStatus(`${head}# branch.ab +1 -0\nu UU N... x\n`, "complete", {
        op: { kind: "merge", subject: "side" },
        bisecting: false,
      }),
      mergingBisect: formatGitStatus(head, "complete", {
        op: { kind: "merge", subject: "" },
        bisecting: true,
      }),
      bisect: formatGitStatus("# branch.oid abcdef0123456789\n# branch.head (detached)\n", "complete", {
        op: null,
        bisecting: true,
      }),
      cherry: formatGitStatus(`${head}# branch.ab +0 -4\n`, "complete", {
        op: { kind: "cherry-pick", oid: "85efdc5" },
        bisecting: false,
      }),
      revertCut: formatGitStatus(head, "cut", {
        op: { kind: "revert", oid: "" },
        bisecting: false,
      }),
      applying: formatGitStatus(head, "complete", {
        op: { kind: "am", step: 1, total: 2 },
        bisecting: false,
      }),
    }).toEqual({
      main: "main",
      dirty: slot("main", "uncommitted"),
      level: "main",
      ahead: slot("main", "2 local commits"),
      aheadOne: slot("main", "1 local commit"),
      behind: slot("main", "3 remote commits"),
      behindOne: slot("main", "1 remote commit"),
      behindDirty: slot("main", "uncommitted, 3 remote commits"),
      diverged: slot("main", "uncommitted, 1 local commit, 4 remote commits"),
      divergedClean: slot("main", "1 local commit, 4 remote commits"),
      staged: slot("main", "uncommitted"),
      both: slot("main", "uncommitted"),
      order: slot("main", "uncommitted"),
      conflict: slot("main", "conflicts"),
      conflictAhead: slot("main", "conflicts, 1 local commit"),
      ignored: "main",
      rename: slot("main", "uncommitted"),
      detached: slot("abcdef0", "detached"),
      detachedDirty: slot("abcdef0", "detached, uncommitted"),
      detachedAhead: slot("abcdef0", "detached, uncommitted"),
      detachedConflict: slot("abcdef0", "detached, conflicts"),
      headless: "",
      fatal: "",
      cut: slot("main", "uncommitted"),
      cutConflict: slot("main", "conflicts"),
      cutHeader: slot("main", "status unknown"),
      cutDiverged: slot("main", "status unknown, 1 local commit, 4 remote commits"),
      detachedCut: slot("abcdef0", "detached, status unknown"),
      cutEmpty: "",
      rebasing: slot("reb", "rebasing 2/6"),
      rebasingDetached: slot("abcdef0", "rebasing 2/2, detached, uncommitted"),
      rebasingPlain: slot("reb", "rebasing"),
      mergingConflict: slot("main", "merging side, conflicts, 1 local commit"),
      mergingBisect: slot("main", "merging, bisecting"),
      bisect: slot("abcdef0", "bisecting"),
      cherry: slot("main", "cherry-picking 85efdc5, 4 remote commits"),
      revertCut: slot("main", "reverting, status unknown"),
      applying: slot("main", "applying 1/2"),
    });

    const workspace = await mkdtemp(join(tmpdir(), "harness-statusline-gp-"));
    onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
    const none = await runStatusline(DEFAULT_STATUSLINE, workspace);
    git("init", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-m", "init");
    const clean = await runStatusline(DEFAULT_STATUSLINE, workspace);
    git("remote", "add", "origin", workspace);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("branch", "--set-upstream-to=origin/main");
    git("commit", "--allow-empty", "-m", "two");
    const ahead = await runStatusline(DEFAULT_STATUSLINE, workspace);
    await writeFile(join(workspace, "tracked"), "a");
    git("add", "tracked");
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(join(workspace, `f${i}`), "")));
    const dirty = await runStatusline(DEFAULT_STATUSLINE, workspace);
    git("checkout", "--detach");
    const oid = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim().slice(0, 7);
    const detached = await runStatusline(DEFAULT_STATUSLINE, workspace);
    expect({ none, clean, ahead, dirty, detached }).toEqual({
      none: "",
      clean: "main",
      ahead: slot("main", "1 local commit"),
      dirty: slot("main", "uncommitted, 1 local commit"),
      detached: `${oid}${STATUSLINE_NOTE_SEP}detached, uncommitted`,
    });
  });

  it("readCheckout reads the git directory; runStatusline paints a merge and a rebase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-statusline-co-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const file = async (rel: string, body: string): Promise<void> => {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), body);
    };
    const clear = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
    };

    await file("MERGE_HEAD", "abc\n");
    await file("MERGE_MSG", "Merge branch 'side' into main\n\n# Conflicts:\n");
    expect(readCheckout(dir)).toEqual({ op: { kind: "merge", subject: "side" }, bisecting: false });
    await file("MERGE_MSG", "Merge remote-tracking branch 'origin/main'\n");
    expect(readCheckout(dir).op).toEqual({ kind: "merge", subject: "origin/main" });
    await file("MERGE_MSG", "Merge tag 'v1'\n");
    expect(readCheckout(dir).op).toEqual({ kind: "merge", subject: "tag v1" });
    await file("MERGE_MSG", "Ship the thing\n");
    expect(readCheckout(dir).op).toEqual({ kind: "merge", subject: "" });
    await file("BISECT_LOG", "# bad\n");
    expect(readCheckout(dir).bisecting).toBe(true);

    await clear();
    await file("rebase-merge/msgnum", "2\n");
    await file("rebase-merge/end", "6\n");
    await file("rebase-merge/head-name", "refs/heads/feat/qd-runtime\n");
    await file("MERGE_HEAD", "abc\n");
    expect(readCheckout(dir)).toEqual({
      op: { kind: "rebase", branch: "feat/qd-runtime", step: 2, total: 6 },
      bisecting: false,
    });
    await file("rebase-merge/head-name", "detached HEAD\n");
    expect(readCheckout(dir).op).toEqual({ kind: "rebase", branch: "", step: 2, total: 6 });

    await clear();
    await file("rebase-apply/next", "1\n");
    await file("rebase-apply/last", "2\n");
    await file("rebase-apply/applying", "");
    expect(readCheckout(dir).op).toEqual({ kind: "am", step: 1, total: 2 });

    await clear();
    await file("rebase-apply/next", "3\n");
    await file("rebase-apply/last", "4\n");
    await file("rebase-apply/head-name", "refs/heads/app\n");
    expect(readCheckout(dir).op).toEqual({ kind: "rebase", branch: "app", step: 3, total: 4 });

    await clear();
    await file("CHERRY_PICK_HEAD", "85efdc51c4a86d17367c27d1e5e11e294056f4aa\n");
    expect(readCheckout(dir).op).toEqual({ kind: "cherry-pick", oid: "85efdc5" });

    await clear();
    await file("REVERT_HEAD", "96340a5cbb13b1cc1ca51bd373a8a81d5567909b\n");
    await file("BISECT_LOG", "git bisect start\n");
    expect(readCheckout(dir)).toEqual({ op: { kind: "revert", oid: "96340a5" }, bisecting: true });

    const ops = await mkdtemp(join(tmpdir(), "harness-statusline-op-"));
    onTestFinished(() => rm(ops, { recursive: true, force: true }));
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: ops, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-m", "base");
    git("checkout", "-b", "side");
    await writeFile(join(ops, "s"), "s");
    git("add", "s");
    git("commit", "-m", "side");
    git("checkout", "main");
    git("merge", "--no-commit", "--no-ff", "side");
    const sub = join(ops, "nested");
    await mkdir(sub);
    const merging = await runStatusline(DEFAULT_STATUSLINE, ops);
    const nested = await runStatusline(DEFAULT_STATUSLINE, sub);
    git("merge", "--abort");
    git("checkout", "-b", "reb");
    git("commit", "--allow-empty", "-m", "c");
    try {
      execFileSync("git", ["rebase", "--exec", "false", "HEAD~1"], { cwd: ops, stdio: "ignore" });
    } catch {
      // `false` stops the rebase. The directory is the state under test.
    }
    const rebasing = await runStatusline(DEFAULT_STATUSLINE, ops);
    expect({ merging, nested, rebasing }).toEqual({
      merging: slot("main", "merging side, uncommitted"),
      nested: slot("main", "merging side, uncommitted"),
      rebasing: slot("reb", "rebasing 2/2"),
    });
  });

  it("formatPlain swaps the note separator for a printable one", () => {
    expect({
      default: formatPlain(`main${STATUSLINE_NOTE_SEP}uncommitted`),
      custom: formatPlain(`main${STATUSLINE_NOTE_SEP}uncommitted`, " | "),
      bare: formatPlain("main"),
    }).toEqual({ default: "main · uncommitted", custom: "main | uncommitted", bare: "main" });
  });
  it("statusNote keeps only the clause", () => {
    expect({
      note: statusNote(`main${STATUSLINE_NOTE_SEP}uncommitted, 2 local commits`),
      clean: statusNote("main"),
      empty: statusNote(""),
    }).toEqual({ note: "uncommitted, 2 local commits", clean: "", empty: "" });
  });
  it("watchGit hears every commit, not just the first", async () => {
    const repo = await mkdtemp(join(tmpdir(), "statusline-watch-"));
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q", "-b", "main");
    let heard = 0;
    const stop = watchGit(repo, () => (heard += 1), 20);
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const fired: boolean[] = [];
      for (const n of [1, 2, 3]) {
        await settle();
        const before = heard;
        await writeFile(join(repo, "f"), String(n));
        git("add", "f");
        git("commit", "-q", "-m", String(n));
        await settle();
        fired.push(heard > before);
      }
      expect(fired).toEqual([true, true, true]);
    } finally {
      stop();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
