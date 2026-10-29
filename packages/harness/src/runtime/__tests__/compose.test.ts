/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-require -- temp dir + package bin */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { SessionPlexus } from "@inhuman.tools/harness-model";
import { registerProviders } from "@inhuman.tools/harness-provider-sdk";
import { ConnectionSpec, type DriverSpec } from "@inhuman.tools/plexus-expectations";
import { disposeKernelConnections } from "@inhuman.tools/plexus-expectations/executor";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { memoryCredentialsStore, openDriverRegistry } from "@/connections";
import { mcpProvider } from "@/providers/mcp";
import { openaiCompatProvider } from "@/providers/openai-compat/register";
import { KernelToolCatalog } from "@/tool-catalog";
import { DocumentService } from "@/yjs";

import { ProductionRuntime } from "../compose.js";
import { graphEligibleSessionIds } from "../eligibility.js";
import { admitCall } from "./fixtures.js";

const require = createRequire(import.meta.url);
const temps: string[] = [];

afterEach(async () => {
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

async function listenCompat(models: readonly string[]): Promise<{
  readonly baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (addr == null || typeof addr === "string") {
    throw new Error("compat server has no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error != null) reject(error);
          else resolve();
        });
      }),
  };
}

function localRoster() {
  return openDriverRegistry(registerProviders([openaiCompatProvider, mcpProvider]));
}

function emptyTables(): {
  connections: Record<string, ConnectionSpec | undefined>;
  drivers: Record<string, DriverSpec | undefined>;
} {
  return { connections: {}, drivers: {} };
}

describe("production runtime composition", () => {
  beforeEach(() => resetLocalIDs());

  it("constructs without observers; activate binds catalog projection", () => {
    const catalog = new KernelToolCatalog();
    const runtime = new ProductionRuntime({
      registry: localRoster(),
      catalog,
    });
    const tables = emptyTables();
    runtime.bind(tables);
    expect({
      activated: runtime.activated,
      host: catalog.connectionHost,
      openai: tables.drivers["openai-compat"]?.abilityClaim,
      mcp: tables.drivers["mcp-stdio"]?.abilityClaim,
    }).toEqual({
      activated: false,
      host: undefined,
      openai: ["completion"],
      mcp: ["mcp"],
    });
    runtime.activate();
    expect({
      activated: runtime.activated,
      host: catalog.connectionHost === undefined ? "missing" : "bound",
    }).toEqual({ activated: true, host: "bound" });
    runtime[Symbol.dispose]();
    expect(catalog.connectionHost).toBeUndefined();
  });

  it("interns generic completion and MCP on the same assembler", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "runtime-compose-"));
    temps.push(workspace);
    await writeFile(path.join(workspace, "hello.txt"), "compose-mcp\n");
    const compat = await listenCompat(["m1", "m2"]);
    onTestFinished(() => compat.close());
    const registry = localRoster();
    const catalog = new KernelToolCatalog();
    const runtime = new ProductionRuntime({ registry, catalog });
    const tables = emptyTables();
    runtime.bind(tables);
    onTestFinished(() => {
      disposeKernelConnections(tables);
      runtime[Symbol.dispose]();
    });
    expect(runtime.activated).toBe(false);

    const openaiDriver = tables.drivers["openai-compat"];
    const mcpDriver = tables.drivers["mcp-stdio"];
    if (openaiDriver == null || mcpDriver == null) {
      throw new Error("roster missing openai-compat or mcp-stdio");
    }
    const workSpec = new ConnectionSpec({ driver: openaiDriver, name: "work" });
    workSpec.configuration = { baseUrl: compat.baseUrl };
    tables.connections.work = workSpec;
    const filesSpec = new ConnectionSpec({ driver: mcpDriver, name: "files" });
    filesSpec.configuration = {
      command: process.execPath,
      args: [filesystemServerEntry(), workspace],
      cwd: workspace,
      enabled: true,
    };
    tables.connections.files = filesSpec;
    runtime.activate();
    const secrets = memoryCredentialsStore();
    const work = await runtime.internDiscovery(tables, runtime, "work", {
      secrets,
    });
    const files = await runtime.internDiscovery(tables, runtime, "files", {
      secrets,
    });
    const models = (tables.connections.work?.live.models ?? []) as unknown[];
    const tools = catalog.connectionEntries
      .filter((entry) => entry.source.kind === "connection")
      .map((entry) => (entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName));
    expect({
      workClass: work.constructor.name,
      filesClass: files.constructor.name,
      models: [...models].map(String).sort(),
      listed: tools.some((name) => /list/i.test(name)),
      read: tools.some((name) => /read/i.test(name)),
    }).toEqual({
      workClass: "OpenAiCompatDriverConnection",
      filesClass: "McpStdioDriverConnection",
      models: ["m1", "m2"],
      listed: true,
      read: true,
    });
  }, 20_000);

  it("two assemblers keep separate catalogs and replica intern", () => {
    const a = new ProductionRuntime({ registry: localRoster() });
    const b = new ProductionRuntime({ registry: localRoster() });
    onTestFinished(() => {
      a[Symbol.dispose]();
      b[Symbol.dispose]();
    });
    a.bind({ connections: {}, drivers: {} });
    b.bind({ connections: {}, drivers: {} });
    a.activate();
    b.activate();
    const left = SessionPlexus.create("same", "/tmp/runtime-a");
    const right = SessionPlexus.create("same", "/tmp/runtime-b");
    onTestFinished(() => {
      left.destroy();
      right.destroy();
    });
    a.intern("same", left);
    b.intern("same", right);
    expect(a.replica("same")).toBe(left);
    expect(b.replica("same")).toBe(right);
    expect(a.catalog).not.toBe(b.catalog);
    expect(a.catalog.connectionHost).not.toBe(b.catalog.connectionHost);
  });

  it("binds DocumentService without starting catalog observers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runtime-docs-"));
    temps.push(root);
    const documents = new DocumentService({ root });
    const catalog = new KernelToolCatalog();
    const runtime = new ProductionRuntime({
      registry: localRoster(),
      catalog,
      documents,
    });
    runtime.bind(emptyTables());
    const key = { kind: "sessions" as const, id: "cold" };
    expect({
      activated: runtime.activated,
      host: catalog.connectionHost,
      documents: runtime.documents === documents,
      loaded: documents.getLoaded(key),
    }).toEqual({
      activated: false,
      host: undefined,
      documents: true,
      loaded: undefined,
    });
    const opened = await documents.openExisting(key);
    expect(opened).toEqual({ ok: false, reason: "not-found" });
    expect(documents.getLoaded(key)).toBeUndefined();
    runtime[Symbol.dispose]();
  });

  it("eligibility uses interned replicas without fabricating seats", () => {
    const runtime = new ProductionRuntime({ registry: localRoster() });
    onTestFinished(() => runtime[Symbol.dispose]());
    const caller = SessionPlexus.create("caller", "/tmp/runtime/caller");
    const worker = SessionPlexus.create("worker", "/tmp/runtime/worker");
    onTestFinished(() => {
      caller.destroy();
      worker.destroy();
    });
    worker.root.agent.spec.recipeScope = "session";
    worker.root.agent.spec.name = "reviewer";
    admitCall(caller, worker);
    runtime.intern("caller", caller);
    runtime.intern("worker", worker);
    expect(
      [
        ...graphEligibleSessionIds(
          runtime.eligibilitySnapshot({
            occupied: new Set(["caller"]),
            reserved: new Set(),
          }),
        ),
      ].sort(),
    ).toEqual(["caller", "worker"]);
    expect([
      ...graphEligibleSessionIds(
        runtime.eligibilitySnapshot({
          occupied: new Set(),
          reserved: new Set(),
        }),
      ),
    ]).toEqual([]);
  });
});
