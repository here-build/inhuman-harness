/**
 * Overlay a bots dir onto a backing catalog. A file that matches backing
 * authoring is not an overlay. Admit-misses fail() and stay off faces.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { asSystemPrompt } from "@inhuman.tools/harness-commons";
import { fail } from "@inhuman.tools/harness-diagnostics";
import { BotSpec, type RecipeScope, type ReasoningEffort } from "@inhuman.tools/harness-model";
import equal from "fast-deep-equal";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { botDefinitionSchema } from "@/extensions/schemas";
import { mcpJsonOf } from "@/runtime";
import { invokeCyclePath, type CatalogRecipe } from "@/tool-catalog";

import { asRecord } from "../../util/read-field.js";

export function recipeAuthoring(spec: BotSpec): {
  readonly recipeScope: RecipeScope;
  readonly keepAlive: boolean;
  readonly description: string;
  readonly instructions: BotSpec["instructions"];
  readonly tools: readonly string[];
  readonly invokes: readonly string[];
  readonly reasoningEffort: ReasoningEffort | null;
  readonly skills: readonly string[];
  readonly modelPreferences: readonly string[];
  readonly behavior: Readonly<Record<string, unknown>> | null;
  readonly mcpJson: string;
} {
  return {
    recipeScope: spec.recipeScope,
    keepAlive: spec.keepAlive,
    description: spec.description,
    instructions: spec.instructions,
    tools: spec.tools,
    invokes: spec.invokes,
    reasoningEffort: spec.reasoningEffort,
    skills: spec.skills,
    modelPreferences: spec.modelPreferences,
    behavior: spec.behavior,
    mcpJson: spec.mcpJson,
  };
}

export function overlayBotDir(
  dir: string,
  backing: readonly CatalogRecipe[],
): {
  readonly recipes: CatalogRecipe[];
  readonly faces: BotSpec[];
  readonly snap: ReadonlyMap<string, string>;
} {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const walked: BotSpec[] = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const stem = basename(name, ".md");
    if (stem === "") continue;
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    if (!text.startsWith("---")) {
      fail(`bot ${path}`, "missing frontmatter");
      continue;
    }
    const close = text.indexOf("\n---", 3);
    if (close === -1) {
      fail(`bot ${path}`, "unterminated frontmatter");
      continue;
    }
    const rawHead = text.slice(3, close).replace(/^\n/, "");
    const body = text.slice(close + 4).replace(/^\n/, "");
    let bag: Record<string, unknown>;
    try {
      const record = asRecord(parseYaml(rawHead) ?? {});
      if (record == null) {
        fail(`bot ${path}`, "frontmatter must be a YAML map");
        continue;
      }
      bag = record;
    } catch (error) {
      fail(`bot ${path}`, error instanceof Error ? error.message : String(error));
      continue;
    }
    const parsed = botDefinitionSchema
      .and(
        z.strictObject({
          name: z
            .union([
              z.undefined(),
              z
                .string()
                .trim()
                .refine((value) => value === stem || value === "", {
                  error: `name does not match file stem "${stem}"`,
                }),
            ])
            .default(stem),
        }),
      )
      .safeParse({ ...bag, instructions: body });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      fail(
        `bot ${path}`,
        issues.length === 0
          ? "invalid definition"
          : issues
              .map((issue) => {
                switch (true) {
                  case issue.code === "unrecognized_keys":
                    return `unknown key ${issue.keys.join(", ")}`;
                  case issue.path.join(".") === "":
                    return issue.message;
                  default:
                    return `${issue.path.join(".")}: ${issue.message}`;
                }
              })
              .join("; "),
      );
      continue;
    }
    walked.push(
      new BotSpec({
        name: parsed.data.name,
        recipeScope: parsed.data.recipeScope,
        keepAlive: parsed.data.keepAlive,
        description: parsed.data.description,
        instructions: asSystemPrompt(parsed.data.instructions),
        tools: parsed.data.tools,
        invokes: parsed.data.invokes,
        reasoningEffort: parsed.data.reasoningEffort ?? null,
        modelPreferences: parsed.data.modelPreferences,
        skills: parsed.data.skills,
        behaviorJson: parsed.data.behavior == null ? null : JSON.stringify(parsed.data.behavior),
        mcpJson: mcpJsonOf(parsed.data.mcp),
      }),
    );
  }
  walked.sort((a, b) => a.name.localeCompare(b.name));

  const byName = new Map(backing.map((recipe) => [recipe.spec.name, recipe]));
  const candidates: CatalogRecipe[] = [];
  for (const row of walked) {
    const base = byName.get(row.name);
    if (base != null && equal(recipeAuthoring(row), recipeAuthoring(base.spec))) continue;
    candidates.push({ spec: row, category: "plugin", capabilities: [] });
  }
  const { recipes, errors } = admitRecipes(candidates, backing);
  for (const [name, error] of errors) {
    fail(`bot ${join(dir, `${name}.md`)}`, error);
  }
  const kept = new Set(recipes.map((recipe) => recipe.spec.name));
  const admitted = walked.filter((row) => kept.has(row.name));
  return { recipes, faces: admitted, snap: snapshotOf(admitted) };
}

export function admitRecipes(
  candidates: readonly CatalogRecipe[],
  backing: readonly CatalogRecipe[],
): { readonly recipes: CatalogRecipe[]; readonly errors: ReadonlyMap<string, string> } {
  const names = new Set(backing.map((recipe) => recipe.spec.name));
  for (const recipe of candidates) names.add(recipe.spec.name);
  const errors = new Map<string, string>();
  const kept: CatalogRecipe[] = [];
  for (const recipe of candidates) {
    const missing = recipe.spec.invokes.filter((target) => !names.has(target));
    if (missing.length > 0) {
      errors.set(recipe.spec.name, `invokes unknown "${missing[0]}"`);
      continue;
    }
    kept.push(recipe);
  }
  const merged = [...backing.filter((recipe) => !kept.some((row) => row.spec.name === recipe.spec.name)), ...kept];
  const cycle = invokeCyclePath(merged);
  if (cycle != null) {
    const culprit = cycle[0] ?? "";
    if (culprit !== "" && kept.some((row) => row.spec.name === culprit)) {
      errors.set(culprit, `invoke cycle ${cycle.join(" → ")}`);
      return admitRecipes(
        kept.filter((row) => row.spec.name !== culprit),
        backing,
      );
    }
  }
  return { recipes: kept, errors };
}

export function snapshotOf(walked: readonly BotSpec[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const row of walked) {
    out.set(row.name, JSON.stringify(recipeAuthoring(row)));
  }
  return out;
}

export function botChangeNotice(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [name, finger] of next) {
    const prior = prev.get(name);
    if (prior == null) added.push(name);
    else if (prior !== finger) updated.push(name);
  }
  for (const name of prev.keys()) {
    if (!next.has(name)) removed.push(name);
  }
  const parts: string[] = [];
  if (added.length > 0) parts.push(`new bot added: ${added.join(", ")}`);
  if (updated.length > 0) parts.push(`bot updated: ${updated.join(", ")}`);
  if (removed.length > 0) parts.push(`bot removed: ${removed.join(", ")}`);
  return parts.join("; ");
}
