/**
 * Installed plugin state compiled from normalized definitions. Plugin bots become
 * internal recipes here; they are not written to KernelRoot.bots.
 */
import type { BotCallToolDefinition, NormalizedPluginDefinition } from "@inhuman.tools/plugin-sdk";

import type { InstalledPrivateMcpServer, PluginBotBinding } from "@/extensions";
import { catalogRecipe, type CatalogRecipe, type RecipeScope } from "@/tool-catalog";

import { NAMED_AGENTS_PLUGIN_NAME } from "../system-plugins/named-agents/agent-catalog.js";

export type InstalledPluginRecord = {
  readonly pluginName: string;
  readonly definition: NormalizedPluginDefinition;
  readonly compiledRecipes: readonly CatalogRecipe[];
  readonly privateServers: readonly InstalledPrivateMcpServer[];
  readonly bindings: readonly PluginBotBinding[];
};

export function compilePluginBots(
  pluginName: string,
  definition: NormalizedPluginDefinition,
): readonly CatalogRecipe[] {
  return definition.bots.map((bot) => {
    let scope: RecipeScope;
    switch (bot.recipeScope) {
      case "invocation":
        // Identity only. Enqueue mints one-shot via pluginBotInvocationScoped.
        scope = "session";
        break;
      case "workspace":
        scope = "project";
        break;
      case "session":
        scope = "session";
        break;
      case "global":
        scope = "global";
        break;
      default: {
        const _exhaustive: never = bot.recipeScope;
        scope = _exhaustive;
      }
    }
    return catalogRecipe({
      name: bot.name,
      recipeScope: scope,
      keepAlive: bot.keepAlive === true,
      description: bot.description,
      instructions: bot.instructions,
      tools: bot.tools ?? [],
      category: pluginName === NAMED_AGENTS_PLUGIN_NAME ? "internal" : "plugin",
      invokes: bot.invokes ?? [],
      reasoningEffort: bot.reasoningEffort,
      modelPreferences: bot.modelPreferences,
      skills: bot.skills,
    });
  });
}

export function compilePluginInstall(
  pluginName: string,
  definition: NormalizedPluginDefinition,
  listedToolsByServer: Readonly<Record<string, readonly string[]>> = {},
): InstalledPluginRecord {
  const privateServers = definition.mcpServers.map((server) => ({
    pluginName,
    definition: server,
    listedTools: listedToolsByServer[server.name] ?? [],
  }));
  const bindings = definition.bots.flatMap((bot) =>
    (bot.mcp ?? []).map((binding) => ({
      pluginName,
      botName: bot.name,
      serverName: binding.server,
      tools: binding.tools,
      approval: binding.approval ?? "policy",
    })),
  );
  return {
    pluginName,
    definition,
    compiledRecipes: compilePluginBots(pluginName, definition),
    privateServers,
    bindings,
  };
}

export function botCallToolOf(record: InstalledPluginRecord, wireName: string): BotCallToolDefinition | undefined {
  return record.definition.tools.find(
    (tool): tool is BotCallToolDefinition => tool.name === wireName && tool.type === "bot-call",
  );
}

export type PluginInstallState = {
  readonly plugins: ReadonlyMap<string, InstalledPluginRecord>;
  readonly compiledRecipes: readonly CatalogRecipe[];
  readonly exclusiveSlots: ReadonlyMap<string, string>;
};

export function mergePluginInstallState(records: readonly InstalledPluginRecord[]): PluginInstallState {
  const plugins = new Map(records.map((record) => [record.pluginName, record]));
  const exclusiveSlots = new Map<string, string>();
  const compiledRecipes: CatalogRecipe[] = [];
  for (const record of records) {
    for (const slot of record.definition.exclusiveSlots) {
      const prior = exclusiveSlots.get(slot);
      if (prior != null && prior !== record.pluginName) {
        throw new Error(`exclusive slot "${slot}" claimed by both "${prior}" and "${record.pluginName}"`);
      }
      exclusiveSlots.set(slot, record.pluginName);
    }
    compiledRecipes.push(...record.compiledRecipes);
  }
  const recipeNames = new Set<string>();
  for (const recipe of compiledRecipes) {
    if (recipeNames.has(recipe.spec.name)) {
      throw new Error(`compiled bot "${recipe.spec.name}" collides across plugins`);
    }
    recipeNames.add(recipe.spec.name);
  }
  return { plugins, compiledRecipes, exclusiveSlots };
}
