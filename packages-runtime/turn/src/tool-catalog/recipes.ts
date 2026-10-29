/**
 * Bot recipes. Standing bots go through `bot/send` / `bot/ask` —
 * not per-recipe catalog rows. No execute bodies.
 */
import { asSystemPrompt } from "@inhuman.tools/harness-commons";
import { AGENT_ASK, AGENT_SEND, BotSpec, type RecipeScope, type ReasoningEffort } from "@inhuman.tools/harness-model";

import { CallsCatalog } from "../agent-calls/types.js";

export type { RecipeScope } from "@inhuman.tools/harness-model";

export type RecipeCapability = {
  readonly name: string;
  readonly description?: string;
  readonly supportsNotify?: boolean;
};

export type CatalogRecipe = {
  readonly spec: BotSpec;
  readonly category: "plugin" | "internal";
  readonly capabilities: readonly RecipeCapability[];
};

export function catalogRecipe(init: {
  readonly name: string;
  readonly category: CatalogRecipe["category"];
  readonly recipeScope?: RecipeScope;
  readonly keepAlive?: boolean;
  readonly description?: string;
  readonly instructions?: string;
  readonly tools?: readonly string[];
  readonly invokes?: readonly string[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly modelPreferences?: readonly string[];
  readonly skills?: readonly string[];
  readonly capabilities?: readonly RecipeCapability[];
}): CatalogRecipe {
  return {
    spec: new BotSpec({
      name: init.name,
      recipeScope: init.recipeScope ?? "session",
      keepAlive: init.keepAlive === true,
      description: init.description ?? "",
      instructions: asSystemPrompt(init.instructions ?? ""),
      tools: init.tools ? [...init.tools] : [],
      invokes: init.invokes ? [...init.invokes] : [],
      reasoningEffort: init.reasoningEffort ?? null,
      modelPreferences: init.modelPreferences ? [...init.modelPreferences] : [],
      skills: init.skills ? [...init.skills] : [],
    }),
    category: init.category,
    capabilities: init.capabilities ?? [],
  };
}

export function findRecipe(recipes: readonly CatalogRecipe[], name: string): CatalogRecipe | undefined {
  return recipes.find((recipe) => recipe.spec.name === name);
}

export function agentCallSupportsNotify(catalog: CallsCatalog, callName: string): boolean {
  if (callName === AGENT_SEND || callName === AGENT_ASK) return true;
  const entry = catalog.catalogEntry(callName);
  if (entry?.packMeta?.kind === "bot-call") {
    return entry.packMeta.supportsNotify === true;
  }
  return false;
}

/** Foreground (no recipe name) may invoke any known recipe. A worker may only invoke declared edges. */
export function invokeDenied(
  recipes: readonly CatalogRecipe[],
  invokerName: string,
  targetName: string,
): string | undefined {
  if (invokerName === "") return undefined;
  const invoker = findRecipe(recipes, invokerName);
  if (invoker == null) return `unknown invoker recipe ${invokerName}`;
  if (!invoker.spec.invokes.includes(targetName)) return `${invokerName} cannot invoke ${targetName}`;
  if (edgeCreatesCycle(recipes, invokerName, targetName)) return `invoke cycle ${invokerName} → ${targetName}`;
  return undefined;
}

/** First cycle path (including return to the start), or null if the DAG is sound. */
export function invokeCyclePath(recipes: readonly CatalogRecipe[]): readonly string[] | null {
  const edges = new Map(recipes.map((recipe) => [recipe.spec.name, recipe.spec.invokes]));
  const names = new Set(recipes.map((recipe) => recipe.spec.name));
  const visiting = new Set<string>();
  const seen = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): readonly string[] | null => {
    if (visiting.has(node)) {
      const at = stack.indexOf(node);
      return at === -1 ? [node, node] : [...stack.slice(at), node];
    }
    if (seen.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!names.has(next)) continue;
      const cycle = visit(next);
      if (cycle != null) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    seen.add(node);
    return null;
  };

  for (const name of names) {
    const cycle = visit(name);
    if (cycle != null) return cycle;
  }
  return null;
}

export function edgeCreatesCycle(recipes: readonly CatalogRecipe[], from: string, to: string): boolean {
  if (from === to) return true;
  return (
    invokeCyclePath(
      recipes.map((recipe) => {
        if (recipe.spec.name !== from) return recipe;
        const spec = recipe.spec;
        return {
          ...recipe,
          spec: new BotSpec({
            name: spec.name,
            description: spec.description,
            recipeScope: spec.recipeScope,
            keepAlive: spec.keepAlive,
            instructions: spec.instructions,
            tools: [...spec.tools],
            invokes: [...spec.invokes, to],
            reasoningEffort: spec.reasoningEffort,
            skills: [...spec.skills],
            modelPreferences: [...spec.modelPreferences],
            error: spec.error,
          }),
        };
      }),
    ) != null
  );
}

export function dedupeRecipes(recipes: readonly CatalogRecipe[]): CatalogRecipe[] {
  const seen = new Set<string>();
  const out: CatalogRecipe[] = [];
  for (const recipe of recipes) {
    if (seen.has(recipe.spec.name)) continue;
    seen.add(recipe.spec.name);
    out.push(recipe);
  }
  return out;
}
