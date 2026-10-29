/**
 * Pack catalog load. Tools run as Job executors, not PEW honor.
 * Wire prefixes `mcp__`, `call__`, `agent__` are reserved — colliding pack
 * tools are skipped, they do not overlay.
 */

import { projectPluginSpec, type KernelRoot, type PluginProjectionRegistry } from "@inhuman.tools/harness-model";
import { normalizeDefinitions, resolveReferences, type ToolDefinition } from "@inhuman.tools/plugin-sdk";

import { setPackToolCatalog, type PackToolHandle } from "./pack-catalog.js";
import { compilePluginInstall, mergePluginInstallState } from "./plugin-registry.js";
import { type PluginModuleRow } from "./plugin-tools.js";
import { parametersFromZod } from "./tool-entry.js";
import { type KernelToolCatalog } from "./tool-table.js";
import { argsJsonValue, unknownRecordSchema } from "../schemas/json-record.js";
import {
  HOST_PLUGINS,
  projectHostPluginSpecs,
  SYSTEM_PLUGIN_NAMES,
  SYSTEM_WIRE_NAMES,
} from "../system-plugins/index.js";
import { namedAgentsInstall } from "../system-plugins/named-agents/agent-stdlib.js";

/** Daemon pack dataflow writes through here. Host plugins re-seed inside replacePack. */
export async function applyPackPlugins(
  catalog: KernelToolCatalog,
  rows: readonly PluginModuleRow[],
  kernel?: KernelRoot,
  projections?: PluginProjectionRegistry,
): Promise<{ loaded: number; errors: readonly string[] }> {
  const errors: string[] = [];
  const merged: PackToolHandle[] = [];
  const seen = new Map<string, string>();
  const installed = [namedAgentsInstall];

  for (const row of rows) {
    if (SYSTEM_PLUGIN_NAMES.has(row.pluginName)) {
      errors.push(`${row.pluginName}: plugin name reserved for host registration — skipped`);
      continue;
    }
    try {
      const definition = resolveReferences(normalizeDefinitions(row.module, row.pluginName), row.pluginName);
      installed.push(compilePluginInstall(row.pluginName, definition));
      for (const handle of handlesFromDefinition(row.pluginName, definition)) {
        if (SYSTEM_WIRE_NAMES.has(handle.name)) {
          errors.push(`${row.pluginName}: tool "${handle.name}" collides with a registered tool — skipped`);
          continue;
        }
        if (handle.name.startsWith("mcp__")) {
          errors.push(`${row.pluginName}: tool name reserved for connection expand: ${handle.name} — skipped`);
          continue;
        }
        if (handle.name.startsWith("call__") || handle.name.startsWith("agent__")) {
          errors.push(`${row.pluginName}: tool name reserved for named agents: ${handle.name} — skipped`);
          continue;
        }
        const prior = seen.get(handle.name);
        if (prior !== undefined) {
          errors.push(`${row.pluginName}: tool "${handle.name}" collides with plugin "${prior}" — skipped`);
          continue;
        }
        seen.set(handle.name, row.pluginName);
        merged.push(handle);
      }
    } catch (error) {
      errors.push(`${row.pluginName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    catalog.replaceCompiledPlugins(mergePluginInstallState(installed));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    catalog.replaceCompiledPlugins(mergePluginInstallState([namedAgentsInstall]));
  }
  setPackToolCatalog(catalog, merged);
  if (kernel != null) projectPackPluginSpecs(kernel, installed);
  projections?.install({
    ...HOST_PLUGINS,
    ...Object.fromEntries(installed.map((record) => [record.pluginName, record.definition])),
  });
  return { loaded: merged.length, errors };
}

function projectPackPluginSpecs(
  kernel: KernelRoot,
  installed: readonly ReturnType<typeof compilePluginInstall>[],
): void {
  projectHostPluginSpecs(kernel);
  const keep = new Set(Object.keys(kernel.pluginSpecs));
  for (const record of installed) {
    if (SYSTEM_PLUGIN_NAMES.has(record.pluginName)) continue;
    projectPluginSpec(kernel, record.pluginName, record.definition.tools);
    keep.add(record.pluginName);
  }
  for (const name of Object.keys(kernel.pluginSpecs)) {
    if (!keep.has(name)) delete kernel.pluginSpecs[name];
  }
}

function handlesFromDefinition(
  pluginName: string,
  definition: ReturnType<typeof normalizeDefinitions>,
): PackToolHandle[] {
  return definition.tools.map((tool) => handleFromTool(pluginName, tool));
}

function handleFromTool(pluginName: string, tool: ToolDefinition): PackToolHandle {
  const className = tool.class ?? "effect";
  if (tool.type === "bot-call") {
    return {
      pluginName,
      name: tool.name,
      description: tool.description ?? tool.name,
      class: className,
      representation: tool.representation,
      parameters: parametersFromZod(tool.input),
      tool,
      meta: {
        kind: "bot-call",
        pluginName,
        target: tool.target,
        background: tool.background === true,
        lifetime: tool.lifetime ?? "turn",
        show: tool.show ?? "result",
        deadlineMs: tool.deadlineMs,
        supportsNotify: tool.supportsNotify === true,
      },
      triggersReactLoop: tool.triggersReactLoop,
      isSideChannel: tool.isSideChannel,
      tapeHidden: tool.tapeHidden,
    };
  }
  return {
    pluginName,
    name: tool.name,
    description: tool.description ?? tool.name,
    class: className,
    representation: tool.representation,
    parameters: parametersFromZod(tool.input),
    tool,
    meta: { kind: "function" },
    execute: async (raw, ctx) => tool.run(tool.input.parse(raw), ctx),
    triggersReactLoop: tool.triggersReactLoop,
    isSideChannel: tool.isSideChannel,
    tapeHidden: tool.tapeHidden,
    exam: tool.exam,
  };
}

export function parseArgs(argumentsJson: string): Record<string, unknown> | null {
  const parsed = unknownRecordSchema.safeParse(argsJsonValue(argumentsJson.trim() === "" ? "{}" : argumentsJson));
  return parsed.success ? parsed.data : null;
}
