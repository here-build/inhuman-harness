/**
 * Plugin `.prompt` bots as named agents. Every bot not attached to the
 * foreground becomes a recipe; its behavior is a `{plugin, bot}` reference that a new
 * worker pins from the installed sources when it is created.
 */
import { z } from "zod";

import {
  botChoices,
  ENVIRONMENT_UNSUPPORTED,
  pinChoice,
  pinJson,
  type PluginPackage,
  resolvePackageSurface,
} from "@/extensions";
import { catalogRecipe, type CatalogRecipe } from "@/tool-catalog";

const botReferenceSchema = z.object({ plugin: z.string().min(1), bot: z.string().min(1) }).strict();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A bot recipe and the plugin that declares it. */
export type PluginBot = {
  readonly plugin: string;
  readonly recipe: CatalogRecipe;
};

/** Problems per plugin name. */
export type PluginProblems = Map<string, string[]>;

export function reportProblem(problems: PluginProblems, plugin: string, text: string): void {
  const list = problems.get(plugin);
  if (list == null) problems.set(plugin, [text]);
  else list.push(text);
}

export function pluginBotRecipes(packages: readonly PluginPackage[], problems: PluginProblems): PluginBot[] {
  const out: PluginBot[] = [];
  const owners = new Map<string, string>();
  for (const plugin of packages) {
    let bots;
    try {
      bots = resolvePackageSurface(plugin.root).bots;
    } catch (error) {
      reportProblem(problems, plugin.name, messageOf(error));
      continue;
    }
    for (const bot of bots) {
      if (bot.foreground) continue;
      if (bot.name.trim() === "" || bot.name.includes("__")) {
        reportProblem(problems, plugin.name, `bot name "${bot.name}" is not a recipe name`);
        continue;
      }
      if (bot.behavior != null && bot.behavior.environmentPath !== "") {
        reportProblem(problems, plugin.name, `bot ${bot.name}: ${ENVIRONMENT_UNSUPPORTED}`);
        continue;
      }
      const owner = owners.get(bot.name);
      if (owner != null) {
        reportProblem(problems, plugin.name, `bot ${bot.name} is already declared by ${owner}`);
        continue;
      }
      owners.set(bot.name, plugin.name);
      const recipe = catalogRecipe({
        name: bot.name,
        category: "plugin",
        recipeScope: bot.recipeScope,
        description: bot.description,
        instructions: bot.instructions,
        tools: bot.tools ?? [],
      });
      recipe.spec.behavior = bot.behavior == null ? null : { plugin: plugin.name, bot: bot.name };
      out.push({ plugin: plugin.name, recipe });
    }
  }
  return out;
}

/**
 * The program revision each enabled plugin bot currently has, keyed by bot
 * name. `isCallPaused` holds a call while its bot is absent here or the
 * revision differs, so a disabled plugin — which contributes no package —
 * pauses its calls, and re-enabling it unchanged resumes them.
 */
export async function botRevisions(packages: readonly PluginPackage[]): Promise<ReadonlyMap<string, string>> {
  const problems: PluginProblems = new Map();
  const revisions = new Map<string, string>();
  for (const row of pluginBotRecipes(packages, problems)) {
    const behavior = row.recipe.spec.behavior;
    if (behavior == null) continue;
    try {
      const pinned = await recipePin(behavior, packages);
      if (pinned.revision !== "") revisions.set(row.recipe.spec.name, pinned.revision);
    } catch {
      /* a bot that cannot pin has no revision, so its calls stay paused */
    }
  }
  return revisions;
}

/**
 * The pin a new worker of this recipe starts with, and the revision of the bot
 * program it was pinned from. The revision is what an accepted call records, so
 * the call pauses when the plugin is disabled or the program changes.
 * Both are empty when the recipe has no behavior.
 */
export async function recipePin(
  behavior: Readonly<Record<string, unknown>> | null,
  packages: readonly PluginPackage[],
): Promise<{ readonly pin: string; readonly revision: string }> {
  if (behavior == null) return { pin: "", revision: "" };
  let reference: z.infer<typeof botReferenceSchema>;
  try {
    reference = botReferenceSchema.parse(behavior);
  } catch {
    throw new Error("bot behavior must come from an installed plugin's .prompt bot");
  }
  const plugin = packages.find((row) => row.name === reference.plugin);
  if (plugin == null) throw new Error(`plugin ${reference.plugin} is not installed and enabled`);
  const errors: string[] = [];
  const choice = botChoices([plugin], (bot) => bot.name === reference.bot, errors).at(0);
  if (choice == null) {
    throw new Error(errors.at(0) ?? `${reference.plugin} has no bot ${reference.bot} with a behavior`);
  }
  const pinned = await pinChoice(choice);
  return {
    pin: pinJson({ version: 1, behaviors: [pinned] }),
    revision: pinned.revision,
  };
}
