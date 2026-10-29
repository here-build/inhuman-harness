/**
 * Production assembler: generic completion + MCP through KernelDaemon.
 * Does not boot HTTPServer / HarnessDaemon.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { mkdtemp, writeFile } from "fs-extra";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { listenCompat } from "../../testkit/compat-server.js";
import { sequenceReply } from "../../testkit/sequence-provider.js";
import { KernelDaemon } from "../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../project/ProjectDaemon.js";

const require = createRequire(import.meta.url);

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
  return join(pkg, "..", bin);
}

describe("local production runtime composition", () => {
  beforeEach(() => resetLocalIDs());

  it("generic completion and MCP intern without HTTPServer", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-r0-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-r0-p-"));
    await writeFile(join(workspace, "hello.txt"), "r0-mcp\n");
    const compat = await listenCompat({
      models: [{ id: "m1" }, { id: "m2" }],
      reply: sequenceReply,
    });
    onTestFinished(() => compat.close());
    const kernel = new KernelDaemon(system);
    onTestFinished(() => kernel[Symbol.dispose]());
    expect(kernel.runtime.activated).toBe(false);
    await kernel.ready;
    expect({
      activated: kernel.runtime.activated,
      catalog: kernel.runtime.catalog === kernel.catalog,
      openai: kernel.plexus.root.drivers["openai-compat"]?.abilityClaim,
      mcp: kernel.plexus.root.drivers["mcp-stdio"]?.abilityClaim,
    }).toEqual({
      activated: true,
      catalog: true,
      openai: ["completion"],
      mcp: ["mcp"],
    });

    const work = (await kernel.handleRequest("connect/adopt", {
      driver: "openai-compat",
      name: "Work",
      settings: { baseUrl: compat.baseUrl },
    })) as { id: string };
    const files = (await kernel.handleRequest("connect/adopt", {
      driver: "mcp-stdio",
      name: "Files",
      settings: {
        command: process.execPath,
        args: [filesystemServerEntry(), workspace],
        cwd: workspace,
      },
    })) as { id: string };
    const models = (await kernel.handleRequest("connect/models", { id: work.id })) as {
      connections: Array<{ id: string; models: string[]; error: string }>;
    };
    const project = new ProjectDaemon(kernel, workspace);
    onTestFinished(() => project[Symbol.dispose]());
    await project.ready;
    const session = await project.session("s1");
    await session.orchestrator.ensure(files.id);
    const mcpTools = kernel.catalog.connectionEntries
      .filter((entry) => entry.source.kind === "connection" && entry.source.connectionKey === files.id)
      .map((entry) => (entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName));
    expect({
      work: work.id,
      files: files.id,
      models: models.connections.map((row) => ({ id: row.id, models: [...row.models].sort(), error: row.error })),
      listed: mcpTools.some((name) => /list/i.test(name)),
      read: mcpTools.some((name) => /read/i.test(name)),
      replica: kernel.sessionPlexus("s1") === session.plexus,
    }).toEqual({
      work: "work",
      files: "files",
      models: [{ id: "work", models: ["m1", "m2"], error: "" }],
      listed: true,
      read: true,
      replica: true,
    });
  }, 20_000);
});
