import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { foregroundChoices, parseAgentPin } from "@/extensions";

import { pluginBotRecipes, recipePin } from "../plugin-bots.js";

const PLUGINS = fileURLToPath(new URL("../../../../../../../plugins", import.meta.url));

function installed(dir: string) {
  const root = join(PLUGINS, dir);
  const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as { name: string };
  return { name: manifest.name, root };
}

test("the repository's plugins compile their non-foreground bots into recipes", async () => {
  const packages = [
    "inhuman-plugin-goal",
    "inhuman-plugin-tasks",
    "inhuman-plugin-fusion",
    "inhuman-plugin-offload-tingle",
  ].map(installed);
  const problems = new Map<string, string[]>();
  const bots = pluginBotRecipes(packages, problems);
  const recipes = bots.map((row) => row.recipe);
  const scout = recipes.find((recipe) => recipe.spec.name === "scout");
  const pinned = await recipePin(scout?.spec.behavior ?? null, packages);
  const pin = parseAgentPin(pinned.pin);

  expect({
    problems: [...problems],
    owner: bots.find((row) => row.recipe.spec.name === "scout")?.plugin,
    recipes: Object.fromEntries(recipes.map((recipe) => [recipe.spec.name, recipe.spec.tools])),
    pinned: pin.behaviors.map((row) => ({
      plugin: row.plugin,
      bot: row.bot,
      modules: row.modules.map((module) => module.path),
      revision: row.revision,
    })),
    recorded: pinned.revision,
  }).toEqual({
    problems: [],
    owner: "offload-tingle",
    recipes: expect.objectContaining({ writer: [], scout: ["read_file"] }),
    pinned: [
      {
        plugin: "offload-tingle",
        bot: "scout",
        modules: ["behavior/scout.scm"],
        revision: pinned.revision,
      },
    ],
    recorded: pinned.revision,
  });
  expect(Object.keys(Object.fromEntries(recipes.map((recipe) => [recipe.spec.name, 1])))).not.toContain("foreground");
});

function inlinePlugin(name: string, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "plugin-bots-"));
  temps.push(root);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return { name, root };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("bots attach to the foreground by frontmatter and declare their scope", () => {
  const bots = (files: string[]) => ({
    "plugin.json": JSON.stringify({
      name: "scoped",
      extensions: { "tools.inhuman": { bots: files } },
    }),
  });
  const plugin = inlinePlugin("scoped", {
    ...bots(["./foreground.prompt", "./keeper.prompt", "./helper.prompt"]),
    "foreground.prompt": "---\ndescription: not attached\n---\nA named bot.\n",
    "keeper.prompt": "---\nattach: foreground\nbehavior:\n  program: ./keeper.scm\n---\nForeground.\n",
    "keeper.scm": "(define kept 1)\n",
    "helper.prompt": "---\nscope: project\n---\nProject helper.\n",
  });
  const broken = inlinePlugin("broken", {
    ...bots(["./wide.prompt"]),
    "wide.prompt": "---\nscope: galaxy\n---\nNo.\n",
  });
  const jsenv = inlinePlugin("jsenv", {
    ...bots(["./env.prompt"]),
    "env.prompt": "---\nbehavior:\n  program: ./env.scm\n  environment: ./env.ts\n---\nNo.\n",
    "env.scm": "(define x 1)\n",
    "env.ts": "export {};\n",
  });
  const problems = new Map<string, string[]>();
  const recipes = pluginBotRecipes([plugin, broken, jsenv], problems).map((row) => row.recipe.spec);
  const errors: string[] = [];

  expect({
    recipes: Object.fromEntries(recipes.map((spec) => [spec.name, spec.recipeScope])),
    problems: [...problems],
    foreground: foregroundChoices([plugin], errors).map((row) => row.bot.name),
    optedOut: foregroundChoices([{ ...plugin, foreground: false }], errors),
    errors,
  }).toEqual({
    recipes: { foreground: "session", helper: "project" },
    problems: [
      ["broken", [expect.stringContaining("recipe scope must be session, project, or global")]],
      ["jsenv", [expect.stringContaining("bot env: behavior environment modules run JS in the host")]],
    ],
    foreground: ["keeper"],
    optedOut: [],
    errors: [],
  });
});

test("a recipe behavior that does not name an installed plugin bot does not pin", async () => {
  await expect(recipePin({ program: "./x.scm" }, [])).rejects.toThrow(
    "bot behavior must come from an installed plugin's .prompt bot",
  );
  await expect(recipePin({ plugin: "gone", bot: "writer" }, [])).rejects.toThrow(
    "plugin gone is not installed and enabled",
  );
});
