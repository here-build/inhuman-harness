import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  FileMutateToolJob,
  SessionPlexus,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  shellTailOf,
} from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { DIST_TOOLS, MAX_FILE_WRITE_BYTES, shellTool } from "@/builtin-tools";
import { McpConnectionToolCatalogHost } from "@/runtime";
import { bindSessionCatalog } from "@/tool-catalog";
import { ToolCallHandler, executeSystemTool } from "@/tool-runtime";

import { runTool } from "../../../toolkit/executor.js";
import { KernelToolCatalog } from "../../../toolkit/tool-table.js";

function parseArgs(name: string, raw: unknown): unknown {
  const tool = name === "shell" ? shellTool : DIST_TOOLS.find((row) => row.name === name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  return tool.input.parse(raw);
}

function invocation(name: string, args: unknown, id = "call_1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function snapOf(job: SystemToolJob): { ok?: boolean; text?: string; value?: unknown } {
  return JSON.parse(job.receiptJson ?? "null") as { ok?: boolean; text?: string; value?: unknown };
}

function pwdOf(job: SystemToolJob): string | undefined {
  const snap = snapOf(job);
  return snap.ok === true ? String((snap.value as { stdout?: string } | undefined)?.stdout ?? "").trim() : snap.text;
}

const catalog = new KernelToolCatalog();

describe("toolkit tools", () => {
  let root = "";
  let outside = "";

  beforeEach(() => {
    resetLocalIDs();
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "ht-root-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "ht-out-")));
    writeFileSync(path.join(root, "note.txt"), "alpha\nbeta\nalpha\n");
    writeFileSync(path.join(outside, "secret.txt"), "not yours");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const run = (name: string, args: Record<string, unknown>) => runTool(name, args, { root, catalog });

  function homeJobs(sessionId: string, jobs: SystemToolJob[]): SessionPlexus {
    const plexus = SessionPlexus.create(sessionId, root);
    onTestFinished(() => plexus.destroy());
    bindSessionCatalog(plexus.root, catalog);
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: jobs,
      queue: [],
    });
    for (const job of jobs) turn.pushChild(job);
    plexus.root.head = turn;
    return plexus;
  }

  it("catalog class is closed; missing is absent; projection rows have no execute", () => {
    const classes = Object.fromEntries(catalog.catalogEntries().map((entry) => [entry.wireName, entry.class]));
    const missing = catalog.catalogEntry("not_in_catalog");
    const mail = new ConnectionSpec({ driver: new DriverSpec({ abilityClaim: ["mcp"] }), name: "mail" });
    mail.live = {
      tools: [{ serverToolName: "search", parameters: { type: "object", properties: {} }, class: "effect" }],
    };
    using host = new McpConnectionToolCatalogHost(catalog, { mail });
    expect({
      classes,
      missing,
      execute: {
        scheme_repl: catalog.catalogEntry("scheme_repl")?.execute,
        scheme_watch: catalog.catalogEntry("scheme_watch")?.execute,
        web_search: catalog.catalogEntry("web_search")?.execute,
        web_extract: catalog.catalogEntry("web_extract")?.execute,
        agent__respond: catalog.catalogEntry("agent__respond")?.execute,
        agent__void: catalog.catalogEntry("agent__void")?.execute,
        agent__notify: catalog.catalogEntry("agent__notify")?.execute,
        agent__message: catalog.catalogEntry("agent__message")?.execute,
        agent__send: catalog.catalogEntry("agent__send")?.execute,
        agent__ask: catalog.catalogEntry("agent__ask")?.execute,
        task__validate: catalog.catalogEntry("task__validate"),
        mcp_host: host.connectionEntries[0]?.execute,
        mcp_catalog: catalog.catalogEntry("mcp__mail__search")?.execute,
      },
    }).toEqual({
      classes: {
        read_file: "read",
        list_dir: "read",
        grep: "read",
        glob: "read",
        fff_search: "read",
        job_stop: "meta",
        write_file: "write",
        edit_file: "write",
        shell: "effect",
        update_metadata: "meta",
        context_need: "meta",
        context_recall: "read",
        scheme_repl: "effect",
        scheme_watch: "effect",
        web_search: "effect",
        web_extract: "effect",
        agent__respond: "effect",
        agent__void: "effect",
        agent__notify: "effect",
        agent__message: "effect",
        agent__send: "effect",
        agent__ask: "effect",
      },
      missing: undefined,
      execute: {
        scheme_repl: undefined,
        scheme_watch: undefined,
        web_search: undefined,
        web_extract: undefined,
        agent__respond: undefined,
        agent__void: undefined,
        agent__notify: undefined,
        agent__message: undefined,
        agent__send: undefined,
        agent__ask: undefined,
        task__validate: undefined,
        mcp_host: undefined,
        mcp_catalog: undefined,
      },
    });
  });

  it.each([
    {
      name: "read lexical relative",
      act: () => run("read_file", { path: "../../etc/passwd" }),
      door: /escapes the project root/,
    },
    {
      name: "read lexical absolute",
      act: () => run("read_file", { path: path.join(outside, "secret.txt") }),
      door: /escapes the project root/,
    },
    {
      name: "write lexical relative",
      act: () => run("write_file", { path: "../evil.txt", content: "x" }),
      door: /escapes the project root/,
    },
    {
      name: "write lexical absolute",
      act: () => run("write_file", { path: path.join(outside, "evil.txt"), content: "x" }),
      door: /escapes the project root/,
    },
    {
      name: "read innocent symlink",
      setup: () => symlinkSync(path.join(outside, "secret.txt"), path.join(root, "innocent.txt")),
      act: () => run("read_file", { path: "innocent.txt" }),
      door: /escapes the project root/,
    },
    {
      name: "write innocent symlink",
      setup: () => symlinkSync(outside, path.join(root, "escape"), "dir"),
      act: () => run("write_file", { path: "escape/evil.txt", content: "x" }),
      door: /escapes the project root/,
      leak: () => expect(existsSync(path.join(outside, "evil.txt"))).toBe(false),
    },
    {
      name: "write through leaf symlink to an outside file",
      setup: () => symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt")),
      act: () => run("write_file", { path: "link.txt", content: "PWNED", overwriteExisting: true }),
      door: /escapes the project root/,
      leak: () => expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("not yours"),
    },
    {
      name: "edit through leaf symlink to an outside file",
      setup: () => symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt")),
      act: () => run("edit_file", { path: "link.txt", old_string: "not", new_string: "PWNED" }),
      door: /escapes the project root/,
      leak: () => expect(readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("not yours"),
    },
    {
      name: "write through dangling leaf symlink",
      setup: () => symlinkSync(path.join(outside, "new.txt"), path.join(root, "dangling.txt")),
      act: () => run("write_file", { path: "dangling.txt", content: "x" }),
      door: /dangling symlink/,
      leak: () => expect(existsSync(path.join(outside, "new.txt"))).toBe(false),
    },
    {
      name: "write through in-root leaf symlink to an in-root file",
      setup: () => symlinkSync(path.join(root, "note.txt"), path.join(root, "alias.txt")),
      act: async () => {
        const written = await run("write_file", { path: "alias.txt", content: "fresh", overwriteExisting: true });
        return { ok: written.ok, note: readFileSync(path.join(root, "note.txt"), "utf8") };
      },
      allowed: { ok: true, note: "fresh" },
    },
    {
      name: "shell cwd escape",
      act: () => run("shell", { command: "pwd", cwd: outside }),
      door: /escapes the project root/,
    },
    {
      name: "glob cwd escape",
      act: () => run("glob", { pattern: "*", cwd: outside }),
      door: /escapes the project root/,
    },
    {
      name: "project root is not a file",
      act: () => run("write_file", { path: ".", content: "x" }),
      door: /is the project root itself/,
    },
    {
      name: "glob cwd relative in-root",
      setup: () => {
        mkdirSync(path.join(root, "src"));
        writeFileSync(path.join(root, "README.md"), "root");
        writeFileSync(path.join(root, "src", "README.md"), "src");
      },
      act: async () => {
        const scoped = await run("glob", { pattern: "**/README.md", cwd: "src" });
        return { ok: scoped.ok, text: scoped.text };
      },
      allowed: { ok: true, text: "src/README.md" },
    },
    {
      name: "glob cwd absolute root",
      setup: () => {
        mkdirSync(path.join(root, "src"));
        writeFileSync(path.join(root, "README.md"), "root");
        writeFileSync(path.join(root, "src", "README.md"), "src");
      },
      act: async () => {
        const abs = await run("glob", { pattern: "**/README.md", cwd: root });
        return { ok: abs.ok, paths: abs.text?.split("\n").toSorted() };
      },
      allowed: { ok: true, paths: ["README.md", "src/README.md"] },
    },
    {
      name: "glob path alias in-root",
      setup: () => {
        mkdirSync(path.join(root, "src"));
        writeFileSync(path.join(root, "README.md"), "root");
        writeFileSync(path.join(root, "src", "README.md"), "src");
      },
      act: async () => {
        const aliased = await run("glob", { pattern: "**/README.md", path: "src" });
        return { ok: aliased.ok, text: aliased.text };
      },
      allowed: { ok: true, text: "src/README.md" },
    },
    {
      name: "shell cwd in-root",
      setup: () => mkdirSync(path.join(root, "scripts")),
      act: async () => {
        const inRoot = await run("shell", { command: "pwd", cwd: "./scripts" });
        return {
          ok: inRoot.ok,
          cwd: String((inRoot.value as { stdout?: string } | undefined)?.stdout ?? "").trim(),
        };
      },
      allowed: () => ({ ok: true, cwd: realpathSync(path.join(root, "scripts")) }),
    },
  ])("path confinement — $name", async ({ setup, act, door, leak, allowed }) => {
    setup?.();
    if (door !== undefined) {
      await expect(act()).rejects.toThrow(door);
      leak?.();
      return;
    }
    expect(await act()).toEqual(typeof allowed === "function" ? allowed() : allowed);
  });

  it("list_dir / glob / fff_search / grep return value arrays, markers kept out of the list", async () => {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "README.md"), "root\n");
    writeFileSync(path.join(root, "src", "README.md"), "src\n");

    const listed = await run("list_dir", { path: "." });
    expect(listed.ok).toBe(true);
    expect(Array.isArray(listed.value)).toBe(true);
    expect((listed.value as string[]).includes("README.md")).toBe(true);
    expect((listed.value as string[]).includes("src/")).toBe(true);
    // no truncation marker leaks into the list
    expect((listed.value as string[]).some((entry) => entry.startsWith("…["))).toBe(false);

    const globbed = await run("glob", { pattern: "**/*.md" });
    expect(globbed.ok).toBe(true);
    expect((globbed.value as string[]).toSorted()).toEqual(["README.md", "src/README.md"]);
    expect(globbed.truncated).not.toBe(true);

    const found = await run("fff_search", { query: "readme" });
    expect(found.ok).toBe(true);
    expect(Array.isArray(found.value)).toBe(true);
    expect((found.value as string[]).some((entry) => entry.endsWith("README.md"))).toBe(true);

    const matched = await run("grep", { pattern: "root" });
    expect(matched.ok).toBe(true);
    expect(Array.isArray(matched.value)).toBe(true);
    expect((matched.value as string[]).length).toBe(1);
    expect((matched.value as string[])[0]).toMatch(/README\.md:1: root/);

    mkdirSync(path.join(root, "empty"));
    const listedEmpty = await run("list_dir", { path: "empty" });
    const globbedEmpty = await run("glob", { pattern: "**/*.nope" });
    const foundEmpty = await run("fff_search", { query: "zzzz-no-such-file" });
    const matchedEmpty = await run("grep", { pattern: "zzzz-no-such-pattern" });
    expect({
      listed: { ok: listedEmpty.ok, value: listedEmpty.value, text: listedEmpty.text },
      glob: { ok: globbedEmpty.ok, value: globbedEmpty.value, text: globbedEmpty.text },
      fff: { ok: foundEmpty.ok, value: foundEmpty.value, text: foundEmpty.text },
      grep: { ok: matchedEmpty.ok, value: matchedEmpty.value, text: matchedEmpty.text },
    }).toEqual({
      listed: { ok: true, value: [], text: "(empty directory: empty)" },
      glob: { ok: true, value: [], text: "(no files match **/*.nope)" },
      fff: { ok: true, value: [], text: "(no files match zzzz-no-such-file)" },
      grep: { ok: true, value: [], text: "(no matches for /zzzz-no-such-pattern/)" },
    });
  });

  it("extra-root grant: human / yolo remainder / session read; shell cwd; symlink still holds", async () => {
    const leaked = path.join(outside, "secret.txt");
    const relCwd = path.relative(root, outside);
    const deniedRead = new SystemToolJob({
      toolCallId: "d1",
      name: "read_file",
      argsJson: JSON.stringify({ path: leaked }),
    });
    const allowedRead = new SystemToolJob({
      toolCallId: "a1",
      name: "read_file",
      argsJson: JSON.stringify({ path: leaked }),
      // a soft-deny the human allowed: the floor voted before the answer counts
      policyResult: "deny",
      humanApprove: true,
    });
    const grantRead = new SystemToolJob({
      toolCallId: "g1",
      name: "read_file",
      argsJson: JSON.stringify({ path: leaked }),
      // a read under a folder the human said to treat as part of the session: the floor approves it
      policyResult: "policyApprove",
    });
    const deniedShell = new SystemToolJob({
      toolCallId: "ds",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: outside }),
    });
    const grantShell = new SystemToolJob({
      toolCallId: "gs",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: outside }),
    });
    const allowedShell = new SystemToolJob({
      toolCallId: "as",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: outside }),
      // a soft-deny the human allowed: the floor voted before the answer counts
      policyResult: "deny",
      humanApprove: true,
    });
    const allowedRel = new SystemToolJob({
      toolCallId: "ar",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: relCwd }),
      // a soft-deny the human allowed: the floor voted before the answer counts
      policyResult: "deny",
      humanApprove: true,
    });
    const yoloShell = new SystemToolJob({
      toolCallId: "y1",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: outside }),
      policyResult: "deny",
    });
    const yoloRead = new SystemToolJob({
      toolCallId: "yr",
      name: "read_file",
      argsJson: JSON.stringify({ path: leaked }),
      policyResult: "deny",
    });
    const symlinkRead = new SystemToolJob({
      toolCallId: "sr",
      name: "read_file",
      argsJson: JSON.stringify({ path: "innocent.txt" }),
      // a soft-deny the human allowed: the floor voted before the answer counts
      policyResult: "deny",
      humanApprove: true,
    });
    const symlinkShell = new SystemToolJob({
      toolCallId: "ss",
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: "escape" }),
      // a soft-deny the human allowed: the floor voted before the answer counts
      policyResult: "deny",
      humanApprove: true,
    });
    const plexus = homeJobs("ht-extra-root", [
      deniedRead,
      allowedRead,
      deniedShell,
      grantShell,
      grantRead,
      allowedShell,
      allowedRel,
      yoloShell,
      yoloRead,
      symlinkRead,
      symlinkShell,
    ]);
    await executeSystemTool(deniedRead, new AbortController().signal);
    await executeSystemTool(allowedRead, new AbortController().signal);
    await executeSystemTool(deniedShell, new AbortController().signal);
    expect(plexus.root.addReadRoot(outside)).toBe(true);
    await executeSystemTool(grantShell, new AbortController().signal);
    await executeSystemTool(grantRead, new AbortController().signal);
    await executeSystemTool(allowedShell, new AbortController().signal);
    await executeSystemTool(allowedRel, new AbortController().signal);
    plexus.root.standingPermissionMode = "yolo";
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [yoloShell, yoloRead],
      queue: [],
    });
    plexus.root.head.pushChild(yoloShell);
    plexus.root.head.pushChild(yoloRead);
    await executeSystemTool(yoloShell, new AbortController().signal);
    await executeSystemTool(yoloRead, new AbortController().signal);
    symlinkSync(leaked, path.join(root, "innocent.txt"));
    symlinkSync(outside, path.join(root, "escape"), "dir");
    await executeSystemTool(symlinkRead, new AbortController().signal);
    await executeSystemTool(symlinkShell, new AbortController().signal);

    expect({
      deniedRead: snapOf(deniedRead),
      allowedRead: snapOf(allowedRead),
      grantRead: snapOf(grantRead),
      deniedShell: pwdOf(deniedShell),
      grantShell: pwdOf(grantShell),
      allowedShell: pwdOf(allowedShell),
      allowedRel: pwdOf(allowedRel),
      yoloShell: pwdOf(yoloShell),
      yoloRead: snapOf(yoloRead),
      yoloReadApproved: yoloRead.humanApprove,
      symlinkRead: snapOf(symlinkRead),
      symlinkShell: pwdOf(symlinkShell),
    }).toEqual({
      deniedRead: { ok: false, text: expect.stringMatching(/escapes the project root/) },
      allowedRead: { ok: true, text: "not yours" },
      grantRead: { ok: true, text: "not yours" },
      deniedShell: expect.stringMatching(/escapes the project root/),
      grantShell: expect.stringMatching(/escapes the project root/),
      allowedShell: outside,
      allowedRel: outside,
      yoloShell: outside,
      yoloRead: { ok: true, text: "not yours" },
      yoloReadApproved: null,
      symlinkRead: { ok: false, text: expect.stringMatching(/escapes the project root/) },
      symlinkShell: expect.stringMatching(/escapes the project root/),
    });
  });

  it("write/edit FS: spawn, overwrite only with flag, inode, Diff prior, regex inserts, parallel unique both land", async () => {
    const session = new SessionRoot({ sessionId: "ht-write-admit", path: root });
    const handler = new ToolCallHandler({ catalog });
    const hit = handler.admit(invocation("write_file", { path: "note.txt", content: "n" }), catalog, { session });
    const flaggedAdmit = handler.admit(
      invocation("write_file", { path: "note.txt", content: "n", overwriteExisting: true }, "c2"),
      catalog,
      { session },
    );
    const aliased = handler.admit(
      invocation("write_file", { path: "note.txt", content: "n", overwrite_existing: true }, "c3"),
      catalog,
      { session },
    );
    const miss = handler.admit(invocation("write_file", { path: "b.ts", content: "n" }, "c4"), catalog, { session });
    const noSession = handler.admit(invocation("write_file", { path: "note.txt", content: "n" }, "c5"));
    const editAdmit = handler.admit(
      invocation("edit_file", { path: "note.txt", old_string: "beta", new_string: "BETA" }, "c6"),
      catalog,
      { session },
    );
    expect({
      hit:
        hit instanceof FileMutateToolJob
          ? { existed: hit.existed, prior: hit.priorContent, completed: hit.completed, door: hit.receiptJson }
          : hit,
      flagged:
        flaggedAdmit instanceof FileMutateToolJob
          ? { existed: flaggedAdmit.existed, prior: flaggedAdmit.priorContent, completed: flaggedAdmit.completed }
          : flaggedAdmit,
      aliased: aliased instanceof FileMutateToolJob && aliased.existed === true && aliased.completed === false,
      miss: miss instanceof FileMutateToolJob && miss.existed,
      noSession: noSession instanceof FileMutateToolJob && noSession.existed,
      edit:
        editAdmit instanceof FileMutateToolJob
          ? { prior: editAdmit.priorContent, line: editAdmit.priorLineStart, completed: editAdmit.completed }
          : editAdmit,
    }).toEqual({
      hit: {
        existed: true,
        prior: "alpha\nbeta\nalpha\n",
        completed: true,
        door: expect.stringContaining("overwriteExisting"),
      },
      flagged: { existed: true, prior: "alpha\nbeta\nalpha\n", completed: false },
      aliased: true,
      miss: false,
      noSession: null,
      edit: { prior: "alpha\nbeta\nalpha\n", line: 2, completed: false },
    });

    const spawned = await run("write_file", { path: "new.txt", content: "hi" });
    const noFlag = await run("write_file", { path: "note.txt", content: "clobber" });
    const noFlagBody = readFileSync(path.join(root, "note.txt"), "utf8");
    const inoBefore = statSync(path.join(root, "note.txt")).ino;
    let textPrior: string | null | undefined;
    const flagged = await runTool(
      "write_file",
      { path: "note.txt", content: "from-flag", overwriteExisting: true },
      {
        root,
        catalog,
        onPriorContent: (text) => {
          textPrior = text;
        },
      },
    );
    const inoAfter = statSync(path.join(root, "note.txt")).ino;
    const again = await run("write_file", {
      path: "note.txt",
      content: "via-alias",
      overwriteExisting: true,
    });
    writeFileSync(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 255]));
    let binaryPrior: string | null | undefined;
    const binary = await runTool(
      "write_file",
      { path: "bin.dat", content: "x", overwriteExisting: true },
      {
        root,
        catalog,
        onPriorContent: (text) => {
          binaryPrior = text;
        },
      },
    );
    expect({
      spawned: spawned.text,
      noFlag: { ok: noFlag.ok, text: noFlag.text, body: noFlagBody },
      flagged: flagged.text,
      textPrior,
      inode: inoBefore === inoAfter && Number(inoBefore) !== 0,
      again: again.text,
      after: readFileSync(path.join(root, "note.txt"), "utf8"),
      binary: binary.text,
      binaryPrior,
    }).toEqual({
      spawned: expect.stringMatching(/^created new\.txt /),
      noFlag: {
        ok: false,
        text: expect.stringContaining("overwriteExisting"),
        body: "alpha\nbeta\nalpha\n",
      },
      flagged: expect.stringMatching(/^replaced note\.txt /),
      textPrior: "alpha\nbeta\nalpha\n",
      inode: true,
      again: expect.stringMatching(/^replaced note\.txt /),
      after: "via-alias",
      binary: expect.stringMatching(/^replaced bin\.dat /),
      binaryPrior: null,
    });

    writeFileSync(path.join(root, "a.ts"), "one\ntwo\nthree\n");
    writeFileSync(path.join(root, "sh.ts"), "x = 1\ny = 2\nkeep\nkeep\n");
    writeFileSync(path.join(root, "pair.ts"), "AAA\nBBB\n");
    const diffJob = new FileMutateToolJob({
      toolCallId: "e1",
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "two", new_string: "TWO" }),
    });
    homeJobs("ht-edit-prior", [diffJob]);
    await executeSystemTool(diffJob, new AbortController().signal);
    const once = await run("edit_file", {
      path: "sh.ts",
      old_string: "x = 1",
      new_string: "x = $'hi' $$ $&",
    });
    const all = await run("edit_file", {
      path: "sh.ts",
      old_string: "keep",
      new_string: "$$",
      replace_all: true,
    });
    const [left, right] = await Promise.all([
      run("edit_file", { path: "pair.ts", old_string: "AAA", new_string: "XXX" }),
      run("edit_file", { path: "pair.ts", old_string: "BBB", new_string: "YYY" }),
    ]);
    expect({
      diff: {
        prior: diffJob.priorContent,
        line: diffJob.priorLineStart,
        outcome: snapOf(diffJob),
        body: readFileSync(path.join(root, "a.ts"), "utf8"),
      },
      dollars: { once: once.ok, all: all.ok, body: readFileSync(path.join(root, "sh.ts"), "utf8") },
      parallel: { left: left.ok, right: right.ok, body: readFileSync(path.join(root, "pair.ts"), "utf8") },
    }).toEqual({
      diff: {
        prior: "one\ntwo\nthree\n",
        line: 2,
        outcome: { ok: true, text: expect.stringMatching(/^edited /) },
        body: "one\nTWO\nthree\n",
      },
      dollars: { once: true, all: true, body: "x = $'hi' $$ $&\ny = 2\n$$\n$$\n" },
      parallel: { left: true, right: true, body: "XXX\nYYY\n" },
    });
  });

  it("refuses content over the named byte budget", async () => {
    const over = await run("write_file", { path: "big.txt", content: "x".repeat(MAX_FILE_WRITE_BYTES + 1) });
    expect(over).toMatchObject({
      ok: false,
      text: expect.stringContaining(`over the ${MAX_FILE_WRITE_BYTES}-byte limit`),
    });
    expect(existsSync(path.join(root, "big.txt"))).toBe(false);
  });

  it("bounds the shell: timeout a sleeper, tail a flood, non-zero is ok:false; abort names timeout; cancelled shell seals the tail", async () => {
    const timed = await run("shell", { command: "sleep 5", timeoutMs: 50 });
    const flood = await run("shell", {
      command: "printf HEAD; awk 'BEGIN{for(i=0;i<50000;i++) printf \"y\"}'; printf '\\nTAIL\\n'",
    });
    const stdout = (flood.value as { stdout: string }).stdout;
    const timeoutJob = new SystemToolJob({
      toolCallId: "t1",
      name: "read_file",
      argsJson: JSON.stringify({ path: "note.txt" }),
    });
    const cancelJob = new SystemToolJob({
      toolCallId: "c1",
      name: "shell",
      argsJson: JSON.stringify({ command: "printf 'TAIL\\n'; exec sleep 5", timeoutMs: 30_000 }),
    });
    homeJobs("ht-shell-bounds", [timeoutJob, cancelJob]);
    const abortTimeout = new AbortController();
    abortTimeout.abort(new Error("evaluation timed out after 90ms"));
    await executeSystemTool(timeoutJob, abortTimeout.signal);
    const cancelAbort = new AbortController();
    const running = executeSystemTool(cancelJob, cancelAbort.signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    cancelAbort.abort();
    await running;
    const cancelled = snapOf(cancelJob);
    expect({
      timed: { ok: timed.ok, text: timed.text, stdout: (timed.value as { stdout: string }).stdout },
      flood: {
        ok: flood.ok,
        hasTail: stdout.includes("TAIL"),
        hasHead: stdout.includes("HEAD"),
        comment: stdout.includes("tailed last"),
        clipped: stdout.length < 20 * 1024,
      },
      nonzero: await run("shell", { command: "exit 7" }),
      abortTimeout: snapOf(timeoutJob),
      cancelled: {
        ok: cancelled.ok,
        text: cancelled.text,
        stdout: (cancelled.value as { stdout?: string } | undefined)?.stdout ?? "",
        turnTail: shellTailOf(cancelJob),
      },
    }).toEqual({
      timed: {
        ok: false,
        text: expect.stringMatching(/timed out/),
        stdout: expect.stringMatching(/timed out after 50ms/),
      },
      flood: { ok: true, hasTail: true, hasHead: false, comment: true, clipped: true },
      nonzero: { ok: false, value: expect.objectContaining({ exitCode: 7 }) },
      abortTimeout: { ok: false, text: "evaluation timed out after 90ms" },
      cancelled: {
        ok: false,
        text: "cancelled",
        stdout: expect.stringContaining("TAIL"),
        turnTail: null,
      },
    });
  });

  it.each([
    {
      name: "drops empty optional",
      tool: "grep",
      raw: { pattern: "x", glob: "" },
      parsed: { pattern: "x" },
    },
    {
      name: "keeps empty required content",
      tool: "write_file",
      raw: { path: "a", content: "" },
      parsed: { path: "a", content: "" },
    },
    {
      name: "write description is optional paint",
      tool: "write_file",
      raw: { path: "a", content: "x", description: "Add greeting" },
      parsed: { path: "a", content: "x", description: "Add greeting" },
    },
    {
      name: "write non-string description omitted",
      tool: "write_file",
      raw: { path: "a", content: "x", description: 1 },
      parsed: { path: "a", content: "x" },
    },
    {
      name: "edit description is optional paint",
      tool: "edit_file",
      raw: { path: "a", old_string: "x", new_string: "y", description: "Rename export" },
      parsed: { path: "a", old_string: "x", new_string: "y", description: "Rename export" },
    },
    {
      name: "keeps empty required new_string",
      tool: "edit_file",
      raw: { path: "a", old_string: "x", new_string: "" },
      parsed: { path: "a", old_string: "x", new_string: "" },
    },
    {
      name: "stringified boolean",
      tool: "edit_file",
      raw: { path: "a", old_string: "x", new_string: "y", replace_all: "true" },
      parsed: { path: "a", old_string: "x", new_string: "y", replace_all: true },
    },
    {
      name: "missing required",
      tool: "read_file",
      raw: {},
      door: /path/i,
    },
    {
      name: "wrong type",
      tool: "read_file",
      raw: { path: 7 },
      door: /path/i,
    },
    {
      name: "published minimum not clamp",
      tool: "read_file",
      raw: { path: "a", offset: 0 },
      door: /offset|>=|minimum/i,
    },
    {
      name: "shell description is optional paint",
      tool: "shell",
      raw: { command: "echo hi", description: "Say hello" },
      parsed: { command: "echo hi", description: "Say hello" },
    },
    {
      name: "shell non-string description omitted",
      tool: "shell",
      raw: { command: "echo hi", description: 1 },
      parsed: { command: "echo hi" },
    },
  ])("arg coerce — $name", ({ tool, raw, parsed, door }) => {
    if (door !== undefined) {
      expect(() => parseArgs(tool, raw)).toThrow(door);
      return;
    }
    expect(parseArgs(tool, raw)).toEqual(parsed);
  });

  it.each([
    {
      name: "missing path is a door not a stack",
      act: () => run("read_file", { path: "nope.md" }),
      throws: /no such path under the project root: nope.md/,
    },
    {
      name: "bad regex",
      act: () => run("grep", { pattern: "([", mode: "regex" }),
      match: {
        ok: false,
        text: expect.stringMatching(/grep: "pattern" is not a valid regular expression/),
      },
    },
    {
      name: "non-unique edit by count names two ways out",
      act: () => run("edit_file", { path: "note.txt", old_string: "alpha", new_string: "A" }),
      match: { ok: false },
      texts: [/appears 2 times/, /replace_all=true/],
      unchanged: "note.txt",
    },
    {
      name: "empty old_string routes to write",
      act: () => run("edit_file", { path: "note.txt", old_string: "", new_string: "x" }),
      match: {
        ok: false,
        text: expect.stringContaining("use write_file"),
      },
      unchanged: "note.txt",
    },
    {
      name: "no-match points at the changed file",
      act: () => run("edit_file", { path: "note.txt", old_string: "gamma", new_string: "G" }),
      match: {
        ok: false,
        text: expect.stringContaining("may have changed since you read it"),
      },
    },
  ])("tool door — $name", async ({ act, throws, match, texts, unchanged }) => {
    if (throws !== undefined) {
      await expect(act()).rejects.toThrow(throws);
      return;
    }
    const door = await act();
    expect(door).toMatchObject(match ?? {});
    for (const text of texts ?? []) {
      expect((door as { text: string }).text).toMatch(text);
    }
    if (unchanged !== undefined) {
      expect(readFileSync(path.join(root, unchanged), "utf8")).toBe("alpha\nbeta\nalpha\n");
    }
  });
});
