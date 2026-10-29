/**
 * Private MCP binding and admission.
 */
import { createHash } from "node:crypto";

export type PluginBotBinding = {
  readonly pluginName: string;
  readonly botName: string;
  readonly serverName: string;
  readonly tools: readonly string[];
  readonly approval: "allow" | "policy";
};

export type PrivateMcpServerDefinition = {
  readonly name: string;
  readonly visibility: "private" | "public";
  readonly scope: "session" | "workspace" | "global";
  readonly transport: {
    readonly type: "stdio";
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: "plugin" | "workspace";
    readonly env?:
      | Readonly<Record<string, string>>
      | ((ctx: { readonly pluginRoot: string; readonly workspaceRoot: string }) => Record<string, string>);
  };
};

export type InstalledPrivateMcpServer = {
  readonly pluginName: string;
  readonly definition: PrivateMcpServerDefinition;
  readonly listedTools: readonly string[];
};

export type PrivateMcpPluginRecord = {
  readonly pluginName: string;
  readonly definition: {
    readonly mcpServers: readonly PrivateMcpServerDefinition[];
  };
  readonly privateServers: readonly InstalledPrivateMcpServer[];
  readonly bindings: readonly PluginBotBinding[];
};

export type PrivateMcpInstallState = {
  readonly plugins: {
    readonly get: (pluginName: string) => PrivateMcpPluginRecord | undefined;
    readonly values: () => Iterable<PrivateMcpPluginRecord>;
  };
};

export type PrivateMcpAdmission = {
  readonly allowed: boolean;
  readonly reason?: string;
};

/** Stable contribution revision for `call` pinning and MCP env. */
export function pluginContributionRevision(record: { readonly definition: unknown }): string {
  return createHash("sha256").update(JSON.stringify(record.definition)).digest("hex").slice(0, 16);
}

export function admitPrivateMcpTool(
  state: PrivateMcpInstallState,
  callerRecipeName: string,
  pluginName: string,
  serverName: string,
  toolName: string,
): PrivateMcpAdmission {
  const record = state.plugins.get(pluginName);
  const server = record?.privateServers.find((row) => row.definition.name === serverName);
  if (record == null || server == null) {
    return { allowed: false, reason: "unknown private server" };
  }
  if (server.definition.visibility !== "private") {
    return { allowed: false, reason: "server is not private" };
  }
  if (callerRecipeName === "") {
    return {
      allowed: false,
      reason: "foreground cannot call private MCP tools",
    };
  }
  const binding = record.bindings.find((row) => row.botName === callerRecipeName && row.serverName === serverName);
  if (binding == null) {
    return {
      allowed: false,
      reason: `${callerRecipeName} is not bound to ${serverName}`,
    };
  }
  if (!binding.tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${callerRecipeName} cannot use ${toolName} on ${serverName}`,
    };
  }
  if (server.listedTools.length > 0 && !server.listedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is unavailable on ${serverName}`,
    };
  }
  return { allowed: true };
}
