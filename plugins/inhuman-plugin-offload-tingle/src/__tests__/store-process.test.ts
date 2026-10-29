/**
 * Process boundary: SQLite lives only in the memory MCP child.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDefinitions, resolveReferences } from "@inhuman.tools/plugin-sdk";
import { describe, expect, it } from "vitest";

import { connectMemoryMcp, parseToolJson } from "../test-helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const STORE_PATH = fileURLToPath(new URL("../../dist/store.js", import.meta.url));

describe("store process boundary", () => {
  it("database_pid_differs_and_scout_binding_excludes_commit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ot-ws-"));
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `import { MemoryStore } from ${JSON.stringify(STORE_PATH)}; const s = new MemoryStore(process.env.MEMORY_WORKSPACE); console.log(String(s.databasePid)); s.close();`,
      ],
      { env: { ...process.env, MEMORY_WORKSPACE: workspace }, encoding: "utf8" },
    );
    const childPid = Number(probe.stdout.trim());
    expect(childPid).toBeGreaterThan(0);
    expect(childPid).not.toBe(process.pid);

    const grep = spawnSync(
      "rg",
      ["better-sqlite3", "packages/harness/src/server/daemon", "packages/harness/src/server/drivers"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(grep.stdout ?? "").not.toMatch(/from ["']better-sqlite3["']/);

    const mod = await import(new URL("../../dist/plugin.js", import.meta.url).href);
    const definition = resolveReferences(normalizeDefinitions(mod.default, "offload-tingle"), "offload-tingle");
    const scout = definition.bots.find((bot) => bot.name === "scout");
    const writer = definition.bots.find((bot) => bot.name === "writer");
    expect(scout?.mcp?.[0]?.tools).toEqual(["find", "read"]);
    expect(writer?.mcp?.[0]?.tools).toContain("commit");
    expect(scout?.mcp?.[0]?.tools).not.toContain("commit");

    const client = await connectMemoryMcp(workspace);
    const commit = await client.callTool({
      name: "commit",
      arguments: {
        requestId: "req-1",
        inputDigest: "digest-1",
        candidate: { episode: null, facts: [], core: null, emptyReason: "probe" },
      },
    });
    const row = parseToolJson(commit as { content: Array<{ type: string; text?: string }> });
    expect(row).toMatchObject({ kind: "empty", requestId: "req-1" });

    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
