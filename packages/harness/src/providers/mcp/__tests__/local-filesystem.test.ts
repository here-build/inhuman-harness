/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-require -- temp dir + package bin */
/**
 * Real local MCP filesystem server: discovery, tools/call, and child dispose.
 */
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { McpStdioDriverConnection } from "../stdio-driver.js";

const require = createRequire(import.meta.url);
const live: McpStdioDriverConnection[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection[Symbol.asyncDispose]()));
});

function filesystemServerEntry(): string {
  const pkg = require.resolve("@modelcontextprotocol/server-filesystem/package.json");
  const manifest = require(pkg) as {
    bin?: string | Record<string, string>;
    main?: string;
  };
  const bin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : (manifest.bin?.["mcp-server-filesystem"] ??
        manifest.bin?.[Object.keys(manifest.bin ?? {})[0] ?? ""] ??
        manifest.main);
  if (typeof bin !== "string" || bin === "") {
    throw new Error("server-filesystem package has no bin/main entry");
  }
  return path.join(path.dirname(pkg), bin);
}

it("stdio filesystem MCP lists tools, reads a file, and drops the child on dispose", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-fs-"));
  const hello = path.join(root, "hello.txt");
  await writeFile(hello, "filesystem-mcp\n");
  const connection = new McpStdioDriverConnection("filesystem", {
    command: process.execPath,
    args: [filesystemServerEntry(), root],
    cwd: root,
  });
  live.push(connection);
  try {
    await connection.ensureBootstrapStarted();
    const names = connection.state.tools.map((tool) => tool.serverToolName);
    expect(connection.readyState).toBe("ready");
    expect(connection.client).not.toBeNull();
    expect(names.some((name) => /list_directory|list_dir|listDirectory/i.test(name))).toBe(true);
    expect(names.some((name) => /read_file|readFile/i.test(name))).toBe(true);

    const listed = names.includes("list_directory")
      ? await connection.callTool({
          serverToolName: "list_directory",
          args: { path: root },
        })
      : await connection.callTool({
          serverToolName: names.find((name) => /list/i.test(name)) ?? names[0]!,
          args: { path: root },
        });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.value)).toMatch(/hello\.txt/);

    const reader = names.find((name) => /read_file|readFile/i.test(name));
    if (reader !== undefined) {
      const read = await connection.callTool({
        serverToolName: reader,
        args: { path: hello },
      });
      expect(read.ok).toBe(true);
      expect(JSON.stringify(read.value)).toMatch(/filesystem-mcp/);
    }

    await connection[Symbol.asyncDispose]();
    expect({ client: connection.client, cwd: realpathSync(root) }).toEqual({
      client: null,
      cwd: realpathSync(root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
