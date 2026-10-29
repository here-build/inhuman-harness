/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-require -- temp dir + package bin */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { afterEach, describe, expect, it } from "vitest";

import { admitPrivateMcpTool, type PrivateMcpInstallState, type PrivateMcpPluginRecord } from "@/extensions";
import { McpStdioDriverConnection } from "@/providers/mcp";

import {
  parsePrivateConnectionKey,
  PRIVATE_CONNECTION_PREFIX,
  privateConnectionKey,
  privateMcpCatalogEntries,
  PrivatePluginMcpHost,
} from "../private-plugin-mcp.js";

const require = createRequire(import.meta.url);
const live: McpStdioDriverConnection[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection[Symbol.asyncDispose]()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

function installOf(record: PrivateMcpPluginRecord): PrivateMcpInstallState {
  return { plugins: new Map([[record.pluginName, record]]) };
}

function filesPlugin(
  command: string,
  args: readonly string[],
  listedTools: readonly string[] = ["list_directory", "read_file", "write_file"],
): PrivateMcpPluginRecord {
  const definition = {
    name: "fs",
    visibility: "private" as const,
    scope: "workspace" as const,
    transport: {
      type: "stdio" as const,
      command,
      args,
      cwd: "plugin" as const,
    },
  };
  return {
    pluginName: "files",
    definition: { mcpServers: [definition] },
    privateServers: [
      {
        pluginName: "files",
        definition,
        listedTools,
      },
    ],
    bindings: [
      {
        pluginName: "files",
        botName: "worker",
        serverName: "fs",
        tools: ["list_directory", "read_file"],
        approval: "allow",
      },
    ],
  };
}

describe("extension private MCP bridge", () => {
  it("keeps private connection key shape and worker ceilings", () => {
    const workspace = "/tmp/ws-bridge";
    const key = privateConnectionKey(workspace, "files", "fs");
    const listed = {
      [key]: [
        {
          serverToolName: "list_directory",
          parameters: { type: "object", properties: {} },
          class: "read",
        },
        {
          serverToolName: "read_file",
          parameters: { type: "object", properties: {} },
          class: "read",
        },
        {
          serverToolName: "write_file",
          parameters: { type: "object", properties: {} },
          class: "write",
        },
      ],
    };
    const install = installOf(filesPlugin("node", ["./server.js"]));
    const worker = privateMcpCatalogEntries(install, workspace, "worker", listed);
    const foreground = privateMcpCatalogEntries(install, workspace, "", listed);
    expect({
      prefix: key.startsWith(PRIVATE_CONNECTION_PREFIX),
      parsed: parsePrivateConnectionKey(key),
      workerTools: worker.map((entry) =>
        entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName,
      ),
      foreground,
    }).toEqual({
      prefix: true,
      parsed: { pluginName: "files", serverName: "fs" },
      workerTools: ["list_directory", "read_file"],
      foreground: [],
    });
  });

  it("denied or unstarted work does not start an MCP child", async () => {
    const workspace = "/tmp/ws-deny";
    const key = privateConnectionKey(workspace, "files", "fs");
    const parsed = parsePrivateConnectionKey(key);
    expect(parsed).not.toBeNull();
    const install = installOf(filesPlugin("node", ["./server.js"]));
    let started = 0;
    const callIfAllowed = async (recipe: string, tool: string): Promise<unknown> => {
      const admission = admitPrivateMcpTool(install, recipe, parsed!.pluginName, parsed!.serverName, tool);
      if (!admission.allowed) return admission;
      started += 1;
      throw new Error("should not start MCP");
    };
    const denied = await callIfAllowed("", "read_file");
    const unbound = await callIfAllowed("worker", "write_file");
    expect({ denied, unbound, started }).toEqual({
      denied: expect.objectContaining({ allowed: false }),
      unbound: expect.objectContaining({ allowed: false }),
      started: 0,
    });
  });

  it("clears secrets when a private connection is removed", () => {
    const workspace = "/tmp/ws-secrets";
    const catalog = {
      pluginInstall: installOf(filesPlugin(process.execPath, [process.execPath])),
    };
    const connections: {
      [connectionKey: string]: ConnectionSpec | undefined;
    } = {};
    const secrets: Record<string, Record<string, string>> = {};
    const driver = new DriverSpec({ abilityClaim: ["mcp"] });
    using host = new PrivatePluginMcpHost({
      catalog,
      workspacePath: workspace,
      pluginRoots: new Map([["files", workspace]]),
      connections,
      drivers: { "mcp-stdio": driver },
      writeSecrets: (id, bag) => {
        secrets[id] = { ...bag };
      },
    });
    const key = privateConnectionKey(workspace, "files", "fs");
    expect(connections[key]).toBeDefined();
    expect(Object.keys(secrets[key] ?? {}).length).toBeGreaterThan(0);
    catalog.pluginInstall = { plugins: new Map() };
    host.sync(connections, { "mcp-stdio": driver });
    expect({ spec: connections[key], secrets: secrets[key] }).toEqual({
      spec: undefined,
      secrets: {},
    });
  });

  it("binds a real filesystem MCP child into catalog projection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-mcp-"));
    temps.push(root);
    const hello = path.join(root, "hello.txt");
    await writeFile(hello, "runtime-private-mcp\n");
    const server = filesystemServerEntry();
    const record = filesPlugin(process.execPath, [server, root]);
    const install = installOf(record);
    const driver = new DriverSpec({ abilityClaim: ["mcp"] });
    const connections: {
      [connectionKey: string]: ConnectionSpec | undefined;
    } = {};
    const secrets: Record<string, Record<string, string>> = {};
    using host = new PrivatePluginMcpHost({
      catalog: { pluginInstall: install },
      workspacePath: root,
      pluginRoots: new Map([["files", root]]),
      connections,
      drivers: { "mcp-stdio": driver },
      writeSecrets: (id, bag) => {
        secrets[id] = { ...bag };
      },
    });
    const key = privateConnectionKey(root, "files", "fs");
    const spec = connections[key];
    expect(spec).toBeDefined();
    if (spec == null) throw new Error("missing private connection spec");
    expect(spec.annotation).toBe("@private-plugin");
    expect(spec.name).toBe(key);

    const connection = new McpStdioDriverConnection(key, {
      command: process.execPath,
      args: [server, root],
      cwd: root,
    });
    live.push(connection);
    await connection.ensureBootstrapStarted();
    spec.live = { tools: connection.state.tools };
    host.sync(connections, { "mcp-stdio": driver });

    const names = connection.state.tools.map((tool) => tool.serverToolName);
    const listName =
      names.find((name) => /list_directory|list_dir|listDirectory/i.test(name)) ??
      names.find((name) => /list/i.test(name));
    const readName = names.find((name) => /read_file|readFile/i.test(name));
    const workerInstall: PrivateMcpPluginRecord = {
      ...record,
      bindings: [
        {
          pluginName: "files",
          botName: "worker",
          serverName: "fs",
          tools: [listName ?? "list_directory", readName ?? "read_file"],
          approval: "allow",
        },
      ],
      privateServers: [
        {
          ...record.privateServers[0]!,
          listedTools: names,
        },
      ],
    };
    const workerState = installOf(workerInstall);
    const entries = privateMcpCatalogEntries(workerState, root, "worker", host.listedToolsByConnection);
    const parsed = parsePrivateConnectionKey(key);
    expect(parsed).not.toBeNull();
    const listTool = listName ?? names[0]!;
    const listAdmission = admitPrivateMcpTool(workerState, "worker", parsed!.pluginName, parsed!.serverName, listTool);
    const listed = listAdmission.allowed
      ? await connection.callTool({
          serverToolName: listTool,
          args: { path: root },
        })
      : undefined;
    const writeAdmission = admitPrivateMcpTool(
      workerState,
      "worker",
      parsed!.pluginName,
      parsed!.serverName,
      "write_file",
    );
    const writeStarted = writeAdmission.allowed
      ? await connection.callTool({
          serverToolName: "write_file",
          args: { path: hello, contents: "nope" },
        })
      : undefined;

    expect({
      ready: connection.readyState,
      hasList: listName != null,
      workerProjected: entries.map((entry) =>
        entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName,
      ),
      admitted: listAdmission.allowed,
      listedOk: listed?.ok,
      listedHasHello: JSON.stringify(listed).includes("hello.txt"),
      writeDenied: writeAdmission.allowed,
      writeStarted,
      revisionSecret: Object.keys(secrets[key] ?? {}).some((name) => name.includes("MEMORY_CONTRIBUTION_REVISION")),
    }).toEqual({
      ready: "ready",
      hasList: true,
      workerProjected: expect.arrayContaining([listName]),
      admitted: true,
      listedOk: true,
      listedHasHello: true,
      writeDenied: false,
      writeStarted: undefined,
      revisionSecret: true,
    });
  }, 20_000);
});
