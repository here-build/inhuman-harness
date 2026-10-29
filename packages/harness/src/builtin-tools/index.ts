/**
 * Always-on host plugins. Same InhumanPlugin registration path as user packs.
 * Catalog starts empty; composition registers these entries.
 */
import { projectPluginSpec, type KernelRoot } from "@inhuman.tools/harness-model";
import { InhumanPlugin } from "@inhuman.tools/plugin-sdk";

import type { CatalogEntry } from "@/tool-catalog";

import { catalogEntryFromTool, catalogProjectionFromTool } from "./catalog-entry.js";
import { contextNeedTool } from "./metadata/context-need.js";
import { contextRecallTool } from "./metadata/context-recall.js";
import { updateMetadataTool } from "./metadata/update-metadata.js";
import { AGENT_COMMS_ENTRIES, NAMED_AGENTS_PLUGIN_NAME } from "./named-agents/agent-catalog.js";
import { namedAgentsPlugin } from "./named-agents/agent-stdlib.js";
import { schemeReplTool, schemeWatchTool } from "./scheme-repl/register.js";
import { jobStopTool } from "./shell/job-stop.js";
import { shellTool } from "./shell/shell-tool.js";
import { DIST_TOOLS } from "./toolkit/dist-tools.js";
import { webExtractTool } from "./web-search/web-extract.js";
import { webSearchTool } from "./web-search/web-search.js";

export const TOOLKIT_PLUGIN_NAME = "toolkit";
export const SHELL_PLUGIN_NAME = "shell";
export const METADATA_PLUGIN_NAME = "metadata";
export const SCHEME_REPL_PLUGIN_NAME = "scheme-repl";
export const WEB_SEARCH_PLUGIN_NAME = "web-search";

export const SYSTEM_PLUGIN_NAMES = new Set([
  TOOLKIT_PLUGIN_NAME,
  SHELL_PLUGIN_NAME,
  METADATA_PLUGIN_NAME,
  SCHEME_REPL_PLUGIN_NAME,
  WEB_SEARCH_PLUGIN_NAME,
  NAMED_AGENTS_PLUGIN_NAME,
]);

export const toolkitPlugin = new InhumanPlugin({ tools: [...DIST_TOOLS] });
export const shellPlugin = new InhumanPlugin({
  tools: [shellTool, jobStopTool],
});
export const metadataPlugin = new InhumanPlugin({
  tools: [updateMetadataTool, contextNeedTool, contextRecallTool],
});
export const schemeReplPlugin = new InhumanPlugin({
  tools: [schemeReplTool, schemeWatchTool],
});
export const webSearchPlugin = new InhumanPlugin({
  tools: [webSearchTool, webExtractTool],
});

const HOST_PLUGINS: ReadonlyArray<{
  readonly pluginName: string;
  readonly plugin: InhumanPlugin;
}> = [
  { pluginName: TOOLKIT_PLUGIN_NAME, plugin: toolkitPlugin },
  { pluginName: SHELL_PLUGIN_NAME, plugin: shellPlugin },
  { pluginName: METADATA_PLUGIN_NAME, plugin: metadataPlugin },
  { pluginName: SCHEME_REPL_PLUGIN_NAME, plugin: schemeReplPlugin },
  { pluginName: WEB_SEARCH_PLUGIN_NAME, plugin: webSearchPlugin },
];

export const SYSTEM_ENTRIES: readonly CatalogEntry[] = [
  ...HOST_PLUGINS.flatMap(({ pluginName, plugin }) =>
    plugin.tools.map((tool) => {
      const source = { kind: "pack" as const, pluginName };
      return pluginName === SCHEME_REPL_PLUGIN_NAME || pluginName === WEB_SEARCH_PLUGIN_NAME
        ? catalogProjectionFromTool(tool, source)
        : catalogEntryFromTool(tool, source);
    }),
  ),
  ...AGENT_COMMS_ENTRIES,
];

/** Always-on host faces owned by this package. Tasks are composition. */
export function projectHostPluginSpecs(root: KernelRoot): void {
  for (const { pluginName, plugin } of HOST_PLUGINS) {
    projectPluginSpec(root, pluginName, plugin.tools);
  }
  projectPluginSpec(root, NAMED_AGENTS_PLUGIN_NAME, namedAgentsPlugin.tools);
}

export * from "./shell/shell-tool.js";
export * from "./metadata/update-metadata.js";
export * from "./metadata/context-need.js";
export * from "./metadata/context-recall.js";
export * from "./scheme-repl/register.js";
export * from "./web-search/web-search.js";
export * from "./web-search/web-extract.js";
export * from "./named-agents/agent-catalog.js";
export * from "./named-agents/agent-stdlib.js";

export {
  DIST_TOOLS as DIST_TOOLS,
  ToolError as ToolError,
  asToolResult as asToolResult,
  constrainQuery as constrainQuery,
  resolveInRoot as resolveInRoot,
  type ToolResult as ToolResult,
} from "./toolkit/dist-tools.js";
export { toolResultSchema as toolResultSchema } from "./schemas/tool-result.js";
export * from "./toolkit/bounds.js";
export * from "./toolkit/finder.js";
export * from "./toolkit/write-gate.js";
export * from "./shell/job-stop.js";
