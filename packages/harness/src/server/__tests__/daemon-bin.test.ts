import { execFile } from "node:child_process";

import { describe, expect, it } from "vitest";

const binHref = new URL("../../../dist/server/bin.js", import.meta.url).href;

// Vitest transforms the graph, so an in-process import of dist/server/bin.js
// can succeed while `node` rejects a stale re-export. This is the CLI's loader.
function instantiateBuiltBin(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(binHref)})`],
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error == null ? 0 : error.code;
        if (typeof code !== "number") {
          reject(error ?? new Error("daemon bin load failed"));
          return;
        }
        resolve({
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      },
    );
  });
}

describe("daemon bin", () => {
  it("node instantiates the built entry", async () => {
    expect(await instantiateBuiltBin()).toEqual({ code: 0, stdout: "", stderr: "" });
  }, 30_000);
});
