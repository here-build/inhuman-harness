/**
 * Crush execs the hook as a command. Stdin is the fixture. Stdout is the decision.
 * Exit 0 even on deny: Crush treats exit 2 as its own block, and this script does not.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../../dist/hook-main.js", import.meta.url));

function runBin(stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
}

describe("hook-main", () => {
  it("prints the decision on stdout and exits 0", async () => {
    await access(bin);
    const rows = [
      {
        stdin: JSON.stringify({ tool_name: "bash", tool_input: { command: "ls" } }),
        stdout: JSON.stringify({ decision: "allow" }),
      },
      {
        stdin: JSON.stringify({ tool_name: "write", tool_input: { file_path: ".env" } }),
        stdout: JSON.stringify({ decision: "deny", reason: "not authorized" }),
      },
      {
        stdin: JSON.stringify({ tool_name: "view", tool_input: { file_path: "a.ts" } }),
        stdout: "",
      },
      {
        stdin: "{",
        stdout: JSON.stringify({ decision: "deny", reason: "hook input is not json" }),
      },
    ];
    const got = [];
    for (const row of rows) {
      const result = await runBin(row.stdin);
      got.push({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    }
    expect(got).toEqual(rows.map((row) => ({ code: 0, stdout: row.stdout, stderr: "" })));
  });
});
