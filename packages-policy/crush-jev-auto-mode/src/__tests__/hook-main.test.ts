/**
 * Crush execs this bin. The child env is the only env: a parent API key must not leak in.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../../dist/hook-main.js", import.meta.url));

function runBin(
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { env, stdio: ["pipe", "pipe", "pipe"] });
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
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads TYPESAFE_API_KEY, then JEV_API_KEY, and not SAGE_API_KEY", async () => {
    await access(bin);
    const dir = await mkdtemp(path.join(tmpdir(), "policy-crush-jev-bin-"));
    temps.push(dir);
    const file = path.join(dir, "authorize.scm");
    await writeFile(file, '"allow"\n');
    const ask = JSON.stringify({ tool_name: "bash", tool_input: { command: "git pull" } });
    const deny = JSON.stringify({ decision: "deny", reason: "not authorized" });
    const allow = JSON.stringify({ decision: "allow" });
    const rows = [
      { env: {}, stdout: deny },
      { env: { SAGE_API_KEY: "sage", POLICY_AUTHORIZE: file }, stdout: deny },
      { env: { TYPESAFE_API_KEY: "test-key", POLICY_AUTHORIZE: file }, stdout: allow },
      { env: { TYPESAFE_API_KEY: "", JEV_API_KEY: "test-key", POLICY_AUTHORIZE: file }, stdout: allow },
    ];
    const got = [];
    for (const row of rows) {
      const result = await runBin(ask, row.env);
      got.push({ code: result.code, stdout: result.stdout, stderr: result.stderr });
    }
    expect(got).toEqual(rows.map((row) => ({ code: 0, stdout: row.stdout, stderr: "" })));
  }, 5_000);
});
