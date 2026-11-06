import { FileMutateToolJob, ProgrammaticJob, SystemToolJob } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { fileFact, schemeReceipt, schemeSummary, toolReceipt } from "../tool-receipt.js";

describe("tool receipts", () => {
  it("extracts only complete successful reads as full-file facts, including empty files", () => {
    const makeRead = (args: Record<string, unknown>, ok: boolean, text: string) =>
      new SystemToolJob({
        name: "read_file",
        argsJson: JSON.stringify({ path: "a.ts", ...args }),
        outcomeJson: JSON.stringify({ ok, text }),
        completed: true,
      });
    expect(fileFact(makeRead({}, true, ""))).toEqual({ kind: "read", path: "a.ts", content: "" });
    expect(fileFact(makeRead({ offset: 1 }, true, "part"))).toBeUndefined();
    expect(fileFact(makeRead({ limit: 5 }, true, "part"))).toBeUndefined();
    expect(fileFact(makeRead({}, false, "error"))).toBeUndefined();
    expect(fileFact(makeRead({}, true, "prefix\n…[file is 999999 bytes; read the first 262144]"))).toBeUndefined();
  });

  it("distinguishes pending, failed, and successful mutations without dropping empty writes", () => {
    const make = (outcomeJson: string | null, completed: boolean) =>
      new FileMutateToolJob({
        name: "write_file",
        argsJson: JSON.stringify({ path: "a.ts", content: "" }),
        outcomeJson,
        completed,
        priorContent: "before",
        existed: true,
      });
    expect(fileFact(make(null, false))).toMatchObject({ status: "pending" });
    expect(fileFact(make('{"ok":false}', true))).toMatchObject({ status: "failed" });
    expect(fileFact(make('{"ok":true}', true))).toMatchObject({
      status: "applied",
      prior: "before",
      operation: { kind: "write", content: "" },
    });
  });

  it("paints an edit from the prior file and a create as an empty-old diff", () => {
    const prior = "const a = 1;\nconst b = 2;\n";
    const read = new SystemToolJob({
      name: "read_file",
      argsJson: JSON.stringify({ path: "a.ts" }),
      outcomeJson: JSON.stringify({ ok: true, text: prior }),
      completed: true,
    });
    const edit = new FileMutateToolJob({
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "const b = 2;", new_string: "const b = 3;" }),
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    expect(toolReceipt(edit, [read])).toEqual({
      kind: "diff",
      oldText: prior,
      newText: "const a = 1;\nconst b = 3;\n",
      path: "a.ts",
    });

    const created = new FileMutateToolJob({
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: "hi" }),
      existed: false,
      priorContent: "",
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    expect(toolReceipt(created, [])).toEqual({ kind: "diff", oldText: "", newText: "hi", path: "a.ts" });
  });

  it("numbers a span from the stamped file line and refuses a denied edit", () => {
    const stamped = new FileMutateToolJob({
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "alpha", new_string: "beta" }),
      outcomeJson: '{"ok":true}',
      completed: true,
      priorLineStart: 46,
    });
    expect(toolReceipt(stamped, [])).toEqual({
      kind: "diff",
      oldText: "alpha",
      newText: "beta",
      path: "a.ts",
      lineStart: 46,
    });

    const denied = new SystemToolJob({
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "a", new_string: "b" }),
      outcomeJson: JSON.stringify({ ok: false, code: "policy_denied", text: "blocked" }),
      completed: true,
    });
    expect(toolReceipt(denied, [])).toEqual({ kind: "text", text: "blocked" });
  });

  it("renders write and edit doors as a fail line instead of a fake diff", () => {
    const overwrite = new SystemToolJob({
      name: "write_file",
      argsJson: JSON.stringify({ path: "src/tui/empty-home.ts", content: "x" }),
      outcomeJson: JSON.stringify({
        ok: false,
        text: "write_file: src/tui/empty-home.ts exists — tried to overwrite the existing file, use write_file with the overwriteExisting flag if you need that to happen",
      }),
      completed: true,
    });
    expect(toolReceipt(overwrite, [], "/work")).toEqual({
      kind: "fail-line",
      verb: "overwrite",
      path: "src/tui/empty-home.ts",
      label: "src/tui/empty-home.ts",
      detail:
        "write_file: src/tui/empty-home.ts exists — tried to overwrite the existing file, use write_file with the overwriteExisting flag if you need that to happen",
    });

    const write = new SystemToolJob({
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: "x" }),
      outcomeJson: JSON.stringify({ ok: false, text: "could not write a.ts: EACCES" }),
      completed: true,
    });
    expect(toolReceipt(write, [], "/work")).toEqual({
      kind: "fail-line",
      verb: "write",
      path: "a.ts",
      label: "a.ts",
      detail: "could not write a.ts: EACCES",
    });

    const edit = new SystemToolJob({
      name: "edit_file",
      argsJson: JSON.stringify({ path: "src/tui/paint-source.ts", old_string: "a", new_string: "b" }),
      outcomeJson: JSON.stringify({
        ok: false,
        text: "edit_file: that text appears 2 times in src/tui/paint-source.ts. Include more surrounding lines to make it unique, or pass replace_all=true to change all 2.",
      }),
      completed: true,
    });
    expect(toolReceipt(edit, [], "/work")).toEqual({
      kind: "fail-line",
      verb: "edit",
      path: "src/tui/paint-source.ts",
      label: "src/tui/paint-source.ts",
      detail:
        "edit_file: that text appears 2 times in src/tui/paint-source.ts. Include more surrounding lines to make it unique, or pass replace_all=true to change all 2.",
    });
  });

  it("does not invent a create diff when an overwrite has no prior", () => {
    const overwrite = new FileMutateToolJob({
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: "hi" }),
      outcomeJson: JSON.stringify({ ok: true, text: "replaced a.ts" }),
      completed: true,
      existed: true,
    });
    expect(toolReceipt(overwrite, [])).toEqual({ kind: "text", text: "replaced a.ts" });
  });

  it("highlights a read and a shell command instead of dumping the outcome", () => {
    const read = new SystemToolJob({
      name: "read_file",
      argsJson: JSON.stringify({ path: "src/a.ts" }),
      outcomeJson: JSON.stringify({ ok: true, text: "export const ready = true;\n" }),
      completed: true,
    });
    expect(toolReceipt(read, [])).toEqual({
      kind: "code",
      text: "export const ready = true;\n",
      lang: "typescript",
    });

    const shell = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: 'python -c "print(1)"' }),
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout: "1\n", stderr: "" } }),
      completed: true,
    });
    expect(toolReceipt(shell, [])).toEqual({
      kind: "shell",
      command: 'python -c "print(1)"',
      output: "1\n",
      exitCode: 0,
    });
  });

  it("shows a live shell as the command until bytes arrive", () => {
    const live = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pnpm test" }),
      completed: false,
    });
    expect(toolReceipt(live, [])).toEqual({ kind: "shell", command: "pnpm test", output: "" });
  });

  it("keeps a shell call in the project directory as the command alone", () => {
    const home = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: "." }),
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout: "/repo\n", stderr: "" } }),
      completed: true,
    });
    expect(toolReceipt(home, [], "/repo")).toEqual({
      kind: "shell",
      command: "pwd",
      output: "/repo\n",
      exitCode: 0,
    });
    const root = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pwd", cwd: "/repo" }),
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout: "", stderr: "" } }),
      completed: true,
    });
    expect(toolReceipt(root, [], "/repo")).not.toHaveProperty("directory");
  });

  it("names a subdirectory and leaves an outside directory absolute", () => {
    const nested = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pnpm test", cwd: "/repo/packages/web" }),
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout: "", stderr: "" } }),
      completed: true,
    });
    expect(toolReceipt(nested, [], "/repo")).toMatchObject({ directory: "packages/web" });
    const outside = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "ls", cwd: "/etc" }),
      outcomeJson: JSON.stringify({ ok: false, value: { exitCode: 1, stdout: "", stderr: "denied\n" } }),
      completed: true,
    });
    expect(toolReceipt(outside, [], "/repo")).toEqual({
      kind: "shell",
      command: "ls",
      directory: "/etc",
      output: "denied\n",
      exitCode: 1,
    });
  });

  it("keeps shell VT sequences and a denial has no exit code", () => {
    const colored = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "pnpm exec vitest", cwd: "packages/web" }),
      outcomeJson: JSON.stringify({
        ok: true,
        value: { exitCode: 0, stdout: "\u001b[32m✓\u001b[39m ok\n", stderr: "" },
      }),
      completed: true,
    });
    expect(toolReceipt(colored, [], "/repo")).toMatchObject({
      directory: "packages/web",
      output: "\u001b[32m✓\u001b[39m ok\n",
    });
    const denied = new SystemToolJob({
      name: "shell",
      argsJson: JSON.stringify({ command: "rm -rf /" }),
      outcomeJson: JSON.stringify({ ok: false, code: "policy_denied", text: "blocked" }),
      completed: true,
    });
    expect(toolReceipt(denied, [])).toEqual({
      kind: "shell",
      command: "rm -rf /",
      output: "blocked",
    });
  });

  it("keeps a scheme program as source and a serializer result as code", () => {
    const job = new ProgrammaticJob({
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "add" }),
      outcomeJson: JSON.stringify({ ok: true, value: ["(+ 1 2)"] }),
      completed: true,
    });
    expect(schemeSummary(job)).toBe("scheme_repl add");
    expect(schemeReceipt(job)).toEqual({
      kind: "parts",
      parts: [
        { kind: "code", text: "(+ 1 2)", lang: "scm" },
        { kind: "code", text: "(+ 1 2)", lang: "scm" },
      ],
    });
  });
});
