/**
 * Expand connection-sourced tools into the one catalog table.
 * Wire modelName (mcp__{slug}__…) is projection for tools[] only — route by
 * connectionKey (+ serverToolName), never by re-parsing the wire name.
 *
 * Membership is yaml MCP ConnectionSpecs. Tools ride `spec.live.tools`
 * (PEW mirrors instance state extras onto live at ensure). Catalog is
 * projection, not an execute door.
 */
import type { ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import { autorun, computed, type IReactionDisposer } from "mobx";

import {
  discoverMcpConnectionTools,
  isMcpDriver,
  mcpCatalogClassOf,
  mcpToolSeveritySettingOf,
  type McpListedTool,
} from "@/providers/mcp/wire";
import type { CatalogEntry, KernelToolCatalog } from "@/tool-catalog";

import { bindMcpFaces, clearMcpFaces, mcpServerFace, type McpServerFace } from "./bot-mcp.js";
import { isPrivatePluginConnection, mcpWireName } from "./private-plugin-mcp.js";

function entriesOf(
  connectionKey: string,
  tools: readonly McpListedTool[],
  toolSeverity: unknown,
): readonly CatalogEntry[] {
  const seen = new Set<string>();
  return tools.flatMap((tool) => {
    const modelName = mcpWireName(connectionKey, tool.serverToolName);
    // One server's duplicate must not take down the catalog every session reads. First wins.
    if (seen.has(modelName)) return [];
    seen.add(modelName);
    return {
      wireName: modelName,
      description: tool.description ?? tool.serverToolName,
      class: mcpCatalogClassOf(tool.serverToolName, tool.class, toolSeverity),
      representation: "symbol",
      parameters: tool.parameters,
      source: {
        kind: "connection" as const,
        connectionKey,
        serverToolName: tool.serverToolName,
      },
    };
  });
}

/**
 * Kernel-lifetime owner of MCP catalog slices. A session must never own these:
 * many sessions share one kernel catalog. Tools appear when PEW ensure mirrors
 * connection `state.tools` onto ConnectionSpec.live.
 */
export class McpConnectionToolCatalogHost implements Disposable {
  readonly #keep: IReactionDisposer;

  constructor(
    readonly catalog: KernelToolCatalog,
    readonly connections: {
      readonly [connectionKey: string]: ConnectionSpec | undefined;
    },
  ) {
    this.catalog.connectionHost = this;
    this.#keep = autorun(() => {
      bindMcpFaces(this.catalog, this.connectionFaces);
      void this.connectionEntries;
    });
  }

  @computed
  get connectionFaces(): ReadonlyMap<string, McpServerFace> {
    const faces = new Map<string, McpServerFace>();
    for (const [connectionKey, spec] of Object.entries(this.connections)) {
      if (spec == null || isPrivatePluginConnection(connectionKey)) continue;
      if (!isMcpDriver(spec.driver.abilityClaim)) continue;
      faces.set(connectionKey, mcpServerFace(connectionKey, spec));
    }
    return faces;
  }

  @computed
  get connectionEntries(): readonly CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const [connectionKey, spec] of Object.entries(this.connections)) {
      if (spec == null || isPrivatePluginConnection(connectionKey)) continue;
      if (!isMcpDriver(spec.driver.abilityClaim)) continue;
      const severity = mcpToolSeveritySettingOf(spec.configuration);
      out.push(...entriesOf(connectionKey, discoverMcpConnectionTools(spec), severity));
    }
    return out;
  }

  [Symbol.dispose](): void {
    this.#keep();
    if (this.catalog.connectionHost === this) {
      this.catalog.connectionHost = undefined;
      clearMcpFaces(this.catalog);
    }
  }
}
