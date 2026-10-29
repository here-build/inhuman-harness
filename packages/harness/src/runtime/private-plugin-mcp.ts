/**
 * Lazy private bundled MCP connections per workspace. Not adopted into
 * config.json or the foreground model catalog.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { action, autorun, type IReactionDisposer, observable } from "mobx";

import { pluginContributionRevision, type PrivateMcpInstallState, type PrivateMcpPluginRecord } from "@/extensions";
import { parseListedTools, type McpListedTool } from "@/providers/mcp/wire";
import type { CatalogEntry } from "@/tool-catalog";

export const PRIVATE_CONNECTION_PREFIX = "__prv_";

export function isPrivatePluginConnection(connectionKey: string): boolean {
  return connectionKey.startsWith(PRIVATE_CONNECTION_PREFIX);
}

export function privateConnectionKey(workspacePath: string, pluginName: string, serverName: string): string {
  const ws = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
  return `${PRIVATE_CONNECTION_PREFIX}${ws}__${pluginName}__${serverName}`;
}

export function parsePrivateConnectionKey(connectionKey: string): { pluginName: string; serverName: string } | null {
  if (!isPrivatePluginConnection(connectionKey)) return null;
  const body = connectionKey.slice(PRIVATE_CONNECTION_PREFIX.length);
  const parts = body.split("__");
  if (parts.length < 3) return null;
  const pluginName = parts.at(1);
  if (pluginName == null || pluginName === "") return null;
  return { pluginName, serverName: parts.slice(2).join("__") };
}

function resolveTransportEnv(
  record: PrivateMcpPluginRecord,
  pluginRoot: string,
  serverName: string,
  workspacePath: string,
): Record<string, string> {
  const server = record.definition.mcpServers.find((row) => row.name === serverName);
  if (server == null) return {};
  const env = server.transport.env;
  const resolved =
    env == null ? {} : typeof env === "function" ? env({ pluginRoot, workspaceRoot: workspacePath }) : { ...env };
  return {
    ...resolved,
    MEMORY_CONTRIBUTION_REVISION: pluginContributionRevision(record),
  };
}

function resolvePluginRoot(pluginRootPath: string): string {
  return pluginRootPath.trim() === "" ? process.cwd() : resolve(pluginRootPath);
}

const MCP_PREFIX = "mcp__";
const MAX_WIRE_NAME = 64;
const WIRE_NAME_RE = /^[\w-]+$/;

export function mcpWireName(connectionKey: string, serverToolName: string): string {
  const prefix = `${MCP_PREFIX}${connectionKey}__`;
  const direct = `${prefix}${serverToolName}`;
  if (direct.length <= MAX_WIRE_NAME && WIRE_NAME_RE.test(direct)) return direct;

  const hash = createHash("sha256").update(serverToolName).digest("hex").slice(0, 10);
  const safe = serverToolName.replaceAll(/[^\w-]+/g, "_").replaceAll(/^_+|_+$/g, "") || "tool";
  const suffix = `__${hash}`;
  const available = Math.max(1, MAX_WIRE_NAME - prefix.length - suffix.length);
  return `${prefix}${safe.slice(0, available)}${suffix}`;
}

export function privateMcpCatalogEntries(
  state: PrivateMcpInstallState,
  workspacePath: string,
  recipeName: string,
  listedToolsByConnection: Readonly<Record<string, readonly McpListedTool[]>>,
): readonly CatalogEntry[] {
  const pluginRecord = [...state.plugins.values()].find((row) =>
    row.bindings.some((binding) => binding.botName === recipeName),
  );
  if (pluginRecord == null) return [];
  const bindings = pluginRecord.bindings.filter((binding) => binding.botName === recipeName);
  const out: CatalogEntry[] = [];
  for (const binding of bindings) {
    const key = privateConnectionKey(workspacePath, pluginRecord.pluginName, binding.serverName);
    const listed = listedToolsByConnection[key] ?? [];
    for (const toolName of binding.tools) {
      const tool = listed.find((row) => row.serverToolName === toolName);
      if (tool == null) continue;
      out.push({
        wireName: mcpWireName(key, toolName),
        description: tool.description ?? toolName,
        class: tool.class ?? "read",
        representation: "symbol",
        parameters: tool.parameters,
        source: {
          kind: "connection",
          connectionKey: key,
          serverToolName: toolName,
        },
      });
    }
  }
  return out;
}

export class PrivatePluginMcpHost implements Disposable {
  readonly #catalog: { readonly pluginInstall: PrivateMcpInstallState };
  readonly #workspacePath: string;
  readonly #pluginRoots: ReadonlyMap<string, string>;
  readonly #writeSecrets: (connectionId: string, secrets: Readonly<Record<string, string>>) => void;
  readonly #dispose: IReactionDisposer;
  @observable.shallow accessor listedToolsByConnection: Record<string, McpListedTool[]> = {};

  constructor(ops: {
    readonly catalog: { readonly pluginInstall: PrivateMcpInstallState };
    readonly workspacePath: string;
    readonly pluginRoots: ReadonlyMap<string, string>;
    readonly connections: {
      [connectionKey: string]: ConnectionSpec | undefined;
    };
    readonly drivers: { [name: string]: DriverSpec | undefined };
    readonly writeSecrets: (connectionId: string, secrets: Readonly<Record<string, string>>) => void;
  }) {
    this.#catalog = ops.catalog;
    this.#workspacePath = ops.workspacePath;
    this.#pluginRoots = ops.pluginRoots;
    this.#writeSecrets = ops.writeSecrets;
    this.#dispose = autorun(() => {
      this.sync(ops.connections, ops.drivers);
      const listed: Record<string, McpListedTool[]> = {};
      for (const record of this.#catalog.pluginInstall.plugins.values()) {
        for (const server of record.privateServers) {
          if (server.definition.scope !== "workspace") continue;
          const key = privateConnectionKey(this.#workspacePath, record.pluginName, server.definition.name);
          const spec = ops.connections[key];
          if (spec == null) continue;
          listed[key] = [...parseListedTools(spec.live.tools)];
        }
      }
      this.listedToolsByConnection = listed;
    });
  }

  @action
  sync(
    connections: { [connectionKey: string]: ConnectionSpec | undefined },
    drivers: { [name: string]: DriverSpec | undefined },
  ): void {
    const keep = new Set<string>();
    const listed: Record<string, McpListedTool[]> = {};
    for (const record of this.#catalog.pluginInstall.plugins.values()) {
      for (const server of record.privateServers) {
        if (server.definition.visibility !== "private") continue;
        if (server.definition.scope !== "workspace") continue;
        const key = privateConnectionKey(this.#workspacePath, record.pluginName, server.definition.name);
        keep.add(key);
        const driver = drivers["mcp-stdio"];
        if (driver == null) continue;
        const pluginRoot = resolvePluginRoot(this.#pluginRoots.get(record.pluginName) ?? "");
        const cwd = server.definition.transport.cwd === "plugin" ? pluginRoot : this.#workspacePath;
        const entry = server.definition.transport.args[0];
        if (typeof entry === "string" && entry.trim() !== "") {
          const executable = resolve(cwd, entry);
          // Plugin transport path is operator-authored, not a user upload.
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          if (!existsSync(executable)) continue;
        }
        const spec = connections[key] ?? new ConnectionSpec({ driver, name: key });
        spec.driver = driver;
        spec.name = key;
        spec.annotation = "@private-plugin";
        spec.configuration = {
          command: server.definition.transport.command,
          args: [...server.definition.transport.args],
          cwd,
          enabled: true,
        };
        connections[key] = spec;
        const env = resolveTransportEnv(record, pluginRoot, server.definition.name, this.#workspacePath);
        const secrets: Record<string, string> = {};
        for (const [name, value] of Object.entries(env)) {
          secrets[`env_${name}`] = value;
        }
        this.#writeSecrets(key, secrets);
        listed[key] = [...parseListedTools(spec.live.tools)];
      }
    }
    for (const id of Object.keys(connections)) {
      if (!isPrivatePluginConnection(id)) continue;
      if (keep.has(id)) continue;
      delete connections[id];
      this.#writeSecrets(id, {});
    }
    this.listedToolsByConnection = listed;
  }

  [Symbol.dispose](): void {
    this.#dispose();
  }
}
