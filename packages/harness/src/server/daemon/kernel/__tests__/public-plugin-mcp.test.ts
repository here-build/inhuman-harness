import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { KernelPlexus, type KernelRoot } from "@inhuman.tools/harness-model";
import { PEWDriver } from "@inhuman.tools/plexus-expectations/driver";
import { observable, when } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { DriverRegistry, memoryCredentialsStore, openDriverRegistry } from "@/connections";
import { mcpStdioConfigurationSchema } from "@/providers/mcp/schemas/mcp";

import { PRODUCT_PROVIDERS } from "../../../composition.js";
import { reflectKernel } from "../fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../KernelDaemon.js";

const roots: string[] = [];

function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function fixture(dependencies: Record<string, string> = { "test-plugin": "1.0.0" }): string {
  const root = mkdtempSync(join(tmpdir(), "public-plugin-mcp-"));
  roots.push(root);
  json(join(root, "package.json"), { dependencies });
  return root;
}

function plugin(
  root: string,
  npmName: string,
  pluginName: string,
  mcp: readonly unknown[],
  dependencies: Record<string, string> = {},
): string {
  const path = join(root, "node_modules", npmName);
  mkdirSync(path, { recursive: true });
  json(join(path, "package.json"), { name: npmName, version: "1.0.0", dependencies });
  json(join(path, "plugin.json"), { name: pluginName, extensions: { "tools.inhuman": { mcp } } });
  return path;
}

function publicConnections(kernel: KernelRoot) {
  return Object.entries(kernel.connections).filter(([id]) => id.startsWith("plugin_mcp_"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public plugin MCP reflection", () => {
  it("uses stdio settings, resolves only command paths, and leaves policy unchanged", () => {
    const root = fixture();
    const absolute = join(root, "absolute-driver");
    const pluginRoot = plugin(root, "test-plugin", "desktop", [
      { name: "path", command: "cua-driver", args: ["--mode", "stdio", "./relative-arg"], visibility: "public" },
      { name: "relative", command: "./bin/server", args: ["--file=data.json"], visibility: "public" },
      { name: "relative-no-dot", command: "bin/worker", visibility: "public" },
      { name: "absolute", command: absolute, visibility: "public" },
      { name: "private", command: "secret", visibility: "private" },
      { name: "default-private", command: "secret" },
      { name: "no-command", visibility: "public" },
    ]);
    const kernel = KernelPlexus.bootstrap().root;
    reflectKernel(root, kernel);

    const connections = publicConnections(kernel);
    expect(connections).toHaveLength(4);
    for (const [id, connection] of connections) {
      expect(id).toMatch(/^plugin_mcp_[a-f0-9]{16}$/);
      expect(connection.driver).toBe(kernel.drivers["mcp-stdio"]);
      expect(mcpStdioConfigurationSchema.safeParse(connection.configuration).success).toBe(true);
    }
    const settings = Object.fromEntries(
      connections.map(([, connection]) => [connection.name, connection.configuration]),
    );
    expect(settings).toEqual({
      "desktop/path": {
        command: "cua-driver",
        args: ["--mode", "stdio", "./relative-arg"],
        cwd: pluginRoot,
        enabled: true,
      },
      "desktop/relative": {
        command: resolvePath(pluginRoot, "bin/server"),
        args: ["--file=data.json"],
        cwd: pluginRoot,
        enabled: true,
      },
      "desktop/relative-no-dot": {
        command: resolvePath(pluginRoot, "bin/worker"),
        args: [],
        cwd: pluginRoot,
        enabled: true,
      },
      "desktop/absolute": { command: absolute, args: [], cwd: pluginRoot, enabled: true },
    });
    expect(kernel.grantsJson).toBe("");
    expect(kernel.authorizationJson).toBe("");
    expect(kernel.defaultPermissionMode).toBe("manual");

    reflectKernel(root, kernel);
    for (const [id, connection] of connections) expect(kernel.connections[id]).toBe(connection);
  });

  it("namespaces same-named servers by plugin identity, independently of install location", () => {
    function project() {
      const root = fixture({ "first-plugin": "1.0.0", "second-plugin": "1.0.0" });
      plugin(root, "first-plugin", "first", [{ name: "shared", command: "driver", visibility: "public" }]);
      plugin(root, "second-plugin", "second", [{ name: "shared", command: "driver", visibility: "public" }]);
      const kernel = KernelPlexus.bootstrap().root;
      reflectKernel(root, kernel);
      return publicConnections(kernel).map(([id, connection]) => [id, connection.name]);
    }
    const first = project();
    expect(first).toHaveLength(2);
    expect(new Set(first.map(([id]) => id)).size).toBe(2);
    expect(project()).toEqual(first);
  });

  it("follows enabled graph reachability and removes connections on disable, manifest removal, and uninstall", () => {
    const root = fixture({ "parent-plugin": "1.0.0" });
    const server = [{ name: "shared", command: "driver", visibility: "public" }];
    plugin(root, "parent-plugin", "parent", server, { "child-plugin": "1.0.0" });
    plugin(root, "child-plugin", "child", server);
    const kernel = KernelPlexus.bootstrap().root;
    reflectKernel(root, kernel);
    const ids = publicConnections(kernel)
      .map(([id]) => id)
      .sort();
    expect(ids).toHaveLength(2);

    json(join(root, "config.json"), { plugins: { parent: { enabled: false } } });
    reflectKernel(root, kernel);
    expect(publicConnections(kernel)).toEqual([]);

    json(join(root, "config.json"), { plugins: { child: { enabled: false } } });
    reflectKernel(root, kernel);
    expect(publicConnections(kernel).map(([, connection]) => connection.name)).toEqual(["parent/shared"]);

    json(join(root, "config.json"), {});
    reflectKernel(root, kernel);
    expect(
      publicConnections(kernel)
        .map(([id]) => id)
        .sort(),
    ).toEqual(ids);

    plugin(root, "child-plugin", "child", []);
    reflectKernel(root, kernel);
    expect(publicConnections(kernel).map(([, connection]) => connection.name)).toEqual(["parent/shared"]);

    // Files remain installed, but package.json is the consent/reachability root.
    json(join(root, "package.json"), { dependencies: {} });
    reflectKernel(root, kernel);
    expect(publicConnections(kernel)).toEqual([]);
  });

  it("never overwrites config connections, including a colliding generated ID", () => {
    const root = fixture();
    plugin(root, "test-plugin", "desktop", [{ name: "shared", command: "driver", visibility: "public" }]);
    const kernel = KernelPlexus.bootstrap().root;
    reflectKernel(root, kernel);
    const id = publicConnections(kernel)[0]![0];
    const user = {
      driver: "mcp-stdio",
      name: "User connection",
      annotation: "Leave me alone",
      settings: { command: "user-driver", args: ["--user"], enabled: false },
    };
    json(join(root, "config.json"), { connections: { [id]: user, "user-owned": user } });
    reflectKernel(root, kernel);
    for (const key of [id, "user-owned"]) {
      expect(kernel.connections[key]?.name).toBe(user.name);
      expect(kernel.connections[key]?.annotation).toBe(user.annotation);
      expect(kernel.connections[key]?.configuration).toEqual(user.settings);
    }

    json(join(root, "package.json"), { dependencies: {} });
    reflectKernel(root, kernel);
    expect(kernel.connections[id]?.configuration).toEqual(user.settings);
    expect(kernel.connections["user-owned"]?.configuration).toEqual(user.settings);
  });

  it("does not replace config rows with unavailable drivers or invent a missing stdio driver", () => {
    const root = fixture();
    plugin(root, "test-plugin", "desktop", [{ name: "shared", command: "driver", visibility: "public" }]);
    const kernel = KernelPlexus.bootstrap().root;
    reflectKernel(root, kernel);
    const id = publicConnections(kernel)[0]![0];
    json(join(root, "config.json"), { connections: { [id]: { driver: "missing", settings: {} } } });
    reflectKernel(root, kernel);
    expect(kernel.connections[id]).toBeUndefined();

    json(join(root, "config.json"), {});
    reflectKernel(root, kernel, DriverRegistry.fromDrivers([]));
    expect(kernel.drivers["mcp-stdio"]).toBeUndefined();
    expect(publicConnections(kernel)).toEqual([]);
  });
});

it("retires a public plugin transport on descriptor changes and disable, then re-enables a fresh handle", async () => {
  const root = fixture();
  const servers = (command: string) => [{ name: "shared", command, visibility: "public", scope: "global" }];
  plugin(root, "test-plugin", "desktop", servers("first-driver"));
  const disposed = observable.array<string>();
  class OwnedMcp extends PEWDriver {
    override async bootstrap(): Promise<void> {}
    protected override resolve(): never {
      throw new Error("fixture has no requests");
    }
    override async [Symbol.asyncDispose](): Promise<void> {
      disposed.push(String(this.settings.command));
    }
  }
  const product = openDriverRegistry(PRODUCT_PROVIDERS).list();
  const registry = DriverRegistry.fromDrivers(
    product.map((row) => (row.name === "mcp-stdio" ? { ...row, connection: OwnedMcp } : row)),
  );
  await using kernel = new KernelDaemon(root, registry);
  await kernel.ready;
  const id = publicConnections(kernel.plexus.root)[0]![0];
  const credentials = memoryCredentialsStore();
  const ensure = () => kernel.runtime.internDiscovery(kernel.plexus.root, kernel.runtime, id, { secrets: credentials });
  const first = await ensure();
  plugin(root, "test-plugin", "desktop", servers("replacement-driver"));
  kernel.adjustConfig(() => {});
  await when(() => disposed.length === 1, { timeout: 2_000 });
  const replacement = await ensure();
  expect({ disposed: [...disposed], reminted: replacement !== first, command: replacement.settings.command }).toEqual({
    disposed: ["first-driver"],
    reminted: true,
    command: "replacement-driver",
  });
  await kernel.handleRequest("plugin/set", { name: "desktop", enabled: false });
  await when(() => disposed.length === 2, { timeout: 2_000 });
  expect({ present: kernel.plexus.root.connections[id] != null, disposed: [...disposed] }).toEqual({
    present: false,
    disposed: ["first-driver", "replacement-driver"],
  });
  await kernel.handleRequest("plugin/set", { name: "desktop", enabled: true });
  const reenabled = await ensure();
  expect({ fresh: reenabled !== replacement, command: reenabled.settings.command }).toEqual({
    fresh: true,
    command: "replacement-driver",
  });
  kernel.adjustConfig((config) => {
    config.connections[id] = {
      driver: "mcp-stdio",
      name: "User transport",
      annotation: "",
      settings: { command: "user-driver" },
    };
  });
  await when(() => disposed.length === 3, { timeout: 2_000 });
  const user = await ensure();
  await kernel.handleRequest("plugin/set", { name: "desktop", enabled: false });
  kernel.adjustConfig((config) => {
    config.connections[id]!.settings = { command: "user-edited" };
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect({
    ownedByUser: (await ensure()) === user,
    name: kernel.plexus.root.connections[id]?.name,
    disposed: [...disposed],
  }).toEqual({
    ownedByUser: true,
    name: "User transport",
    disposed: ["first-driver", "replacement-driver", "replacement-driver"],
  });
});

it.each(["session", "workspace"] as const)(
  "reports unsupported public MCP %s scope instead of sharing it globally",
  async (scope) => {
    const root = fixture();
    plugin(root, "test-plugin", "scoped", [{ name: "local", command: "driver", visibility: "public", scope }]);
    await using kernel = new KernelDaemon(root);
    await kernel.ready;
    await when(() => kernel.plexus.root.plugins.scoped?.problem != null, { timeout: 2_000 });
    expect({
      connections: publicConnections(kernel.plexus.root),
      problem: kernel.plexus.root.plugins.scoped?.problem,
    }).toEqual({
      connections: [],
      problem: expect.stringContaining(
        `public MCP scope ${scope} is not supported; set scope to global for a shared host process`,
      ),
    });
  },
);
