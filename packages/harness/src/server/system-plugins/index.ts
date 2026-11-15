/**
 * Product roster: builtin-tools plus the always-on tasks plugin.
 * Catalog starts empty; this composition seeds it.
 */
import type { KernelRoot } from "@inhuman.tools/harness-model";
import { InhumanPlugin } from "@inhuman.tools/plugin-sdk";

import {
  AGENT_COMMS_ENTRIES,
  METADATA_PLUGIN_NAME,
  SCHEME_REPL_PLUGIN_NAME,
  SHELL_PLUGIN_NAME,
  SYSTEM_PLUGIN_NAMES as BUILTIN_PLUGIN_NAMES,
  TOOLKIT_PLUGIN_NAME,
  TOGGLEABLE_HOST_PLUGINS,
  WEB_SEARCH_PLUGIN_NAME,
  expandPluginNames,
  metadataPlugin,
  projectHostPluginSpecs as projectBuiltinHostPluginSpecs,
  schemeReplPlugin,
  shellPlugin,
  toolkitPlugin,
  webSearchPlugin,
} from "@/builtin-tools";
import type { CatalogEntry } from "@/tool-catalog";

import { catalogEntryFromTool, catalogProjectionFromTool } from "../toolkit/tool-entry.js";

export * from "./named-agents/agent-catalog.js";
export * from "./named-agents/agent-stdlib.js";

export const HOST_PLUGINS: Readonly<Record<string, InhumanPlugin>> = {
  [TOOLKIT_PLUGIN_NAME]: toolkitPlugin,
  [SHELL_PLUGIN_NAME]: shellPlugin,
  [METADATA_PLUGIN_NAME]: metadataPlugin,
  [SCHEME_REPL_PLUGIN_NAME]: schemeReplPlugin,
  [WEB_SEARCH_PLUGIN_NAME]: webSearchPlugin,
};

export const SYSTEM_PLUGIN_NAMES = new Set(BUILTIN_PLUGIN_NAMES);

function buildSystemEntries(enabledHostPlugins?: ReadonlySet<string>): readonly CatalogEntry[] {
  const expanded = enabledHostPlugins === undefined ? undefined : expandPluginNames(enabledHostPlugins);
  return [
    ...Object.entries(HOST_PLUGINS)
      .filter(
        ([pluginName]) =>
          expanded === undefined || !TOGGLEABLE_HOST_PLUGINS.has(pluginName) || expanded.has(pluginName),
      )
      .flatMap(([pluginName, plugin]) =>
        plugin.tools.map((tool) => {
          const source = { kind: "pack" as const, pluginName };
          return pluginName === SCHEME_REPL_PLUGIN_NAME || pluginName === WEB_SEARCH_PLUGIN_NAME
            ? catalogProjectionFromTool(tool, source)
            : catalogEntryFromTool(tool, source);
        }),
      ),
    ...AGENT_COMMS_ENTRIES,
  ];
}

export const SYSTEM_ENTRIES: readonly CatalogEntry[] = buildSystemEntries();

export function systemEntriesFor(enabledHostPlugins?: ReadonlySet<string>): readonly CatalogEntry[] {
  if (enabledHostPlugins === undefined) return SYSTEM_ENTRIES;
  return buildSystemEntries(enabledHostPlugins);
}

export const SYSTEM_WIRE_NAMES = new Set(SYSTEM_ENTRIES.map((entry) => entry.wireName));

/** Always-on host faces. Task tools come from the plugin ABI, not these specs. */
export function projectHostPluginSpecs(root: KernelRoot): void {
  projectBuiltinHostPluginSpecs(root);
}

export {
  LOCAL_ENV_PLUGIN_NAME,
  localEnvProjectConfigSchema,
  SCHEME_REPL_PLUGIN_NAME,
  METADATA_PLUGIN_NAME,
  SHELL_PLUGIN_NAME,
  TOOLKIT_PLUGIN_NAME,
  TOGGLEABLE_HOST_PLUGINS,
  expandPluginNames,
  WEB_SEARCH_PLUGIN_NAME,
} from "@/builtin-tools";
