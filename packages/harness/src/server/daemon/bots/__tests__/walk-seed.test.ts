import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { SessionRoot } from "@inhuman.tools/harness-model";
import { describe, expect, it, onTestFinished } from "vitest";

import { NAMED_AGENT_BOTS, namedAgentInventory } from "@/builtin-tools";
import { bindSessionCatalog, catalogRecipe } from "@/tool-catalog";

import { NAMED_AGENTS_PLUGIN_NAME } from "../../../system-plugins/named-agents/agent-catalog.js";
import { namedAgentsInstall } from "../../../system-plugins/named-agents/agent-stdlib.js";
import {
  bindProjectRecipes,
  KernelToolCatalog,
  sessionCatalog,
  unbindProjectRecipes,
  workerToolAllowed,
} from "../../../toolkit/tool-table.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { formatBotMarkdown } from "../parse-bot-markdown.js";
import { projectBotsDir } from "../paths.js";

describe("named agents compile and walk", () => {
  it("stdlib compiles; overlay shadows that workspace", async () => {
    expect({
      compile: {
        install: namedAgentsInstall.pluginName,
        recipes: namedAgentsInstall.compiledRecipes.map((recipe) => ({
          name: recipe.spec.name,
          category: recipe.category,
          scope: recipe.spec.recipeScope,
        })),
        implementer: namedAgentsInstall.compiledRecipes.find((recipe) => recipe.spec.name === "implementer")?.spec
          .invokes,
      },
      inventory: {
        door: namedAgentInventory(namedAgentsInstall.compiledRecipes).includes("(agent/ask spec message)"),
        quick: namedAgentInventory(namedAgentsInstall.compiledRecipes).includes("quick-search"),
        reviewer: namedAgentInventory(namedAgentsInstall.compiledRecipes).includes(
          "persistent reviewer for this session",
        ),
      },
    }).toEqual({
      compile: {
        install: NAMED_AGENTS_PLUGIN_NAME,
        recipes: NAMED_AGENT_BOTS.map((bot) => ({
          name: bot.name,
          category: "internal",
          scope: "session",
        })),
        implementer: ["reviewer"],
      },
      inventory: { door: true, quick: true, reviewer: true },
    });

    const catalog = new KernelToolCatalog();
    expect({
      compiled: {
        description: catalog.recipe("quick-search")?.spec.description.includes("agent/ask") === true,
        userJson: catalog.recipes,
        reviewer: catalog.compiledRecipes.some((recipe) => recipe.spec.name === "reviewer"),
      },
      quickSearch: {
        read: workerToolAllowed(catalog, "quick-search", "read_file"),
        write: workerToolAllowed(catalog, "quick-search", "write_file"),
        shell: workerToolAllowed(catalog, "quick-search", "shell"),
        scheme: workerToolAllowed(catalog, "quick-search", "scheme_repl"),
      },
    }).toEqual({
      compiled: { description: true, userJson: [], reviewer: true },
      quickSearch: { read: true, write: false, shell: false, scheme: true },
    });
    catalog.replaceRecipes([
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping" }],
        invokes: ["reviewer"],
      }),
      catalogRecipe({
        name: "implementer",
        recipeScope: "session",
        category: "plugin",
        description: "user edit",
        capabilities: [],
        invokes: ["reviewer"],
      }),
    ]);
    const rows = catalog.allRecipes().filter((recipe) => recipe.spec.name === "implementer");
    expect({
      echo: catalog.recipe("echo")?.spec.invokes,
      reviewer: catalog.recipe("reviewer")?.category,
      overlayCount: rows.length,
      overlayDescription: catalog.recipe("implementer")?.spec.description,
    }).toEqual({
      echo: ["reviewer"],
      reviewer: "internal",
      overlayCount: 1,
      overlayDescription: "user edit",
    });

    const bindCatalog = new KernelToolCatalog();
    const workspace = "/tmp/project-bots-overlay";
    bindProjectRecipes(bindCatalog, workspace, [
      catalogRecipe({
        name: "scout",
        recipeScope: "session",
        category: "plugin",
        description: "look around",
        capabilities: [],
        invokes: [],
      }),
    ]);
    const here = new SessionRoot({ sessionId: "here", path: workspace });
    const other = new SessionRoot({ sessionId: "other", path: "/tmp/other-project" });
    bindSessionCatalog(here, bindCatalog);
    bindSessionCatalog(other, bindCatalog);
    expect({
      here: sessionCatalog(here)?.recipe("scout")?.spec.description,
      other: sessionCatalog(other)?.recipe("scout"),
      kernel: bindCatalog.recipe("scout"),
    }).toEqual({ here: "look around", other: undefined, kernel: undefined });
    unbindProjectRecipes(bindCatalog, workspace);

    const system = await realpath(await mkdtemp(join(tmpdir(), "harness-pbots-k-")));
    const liveWorkspace = await realpath(await mkdtemp(join(tmpdir(), "harness-pbots-p-")));
    const dir = projectBotsDir(liveWorkspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "scout.md"),
      formatBotMarkdown({
        name: "scout",
        recipeScope: "session",
        description: "look around",
        instructions: prompt.system`Look. Cite. Stop.`,
        tools: ["glob"],
      }),
    );
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, liveWorkspace);
    await project.ready;
    const session = await project.session("s1");
    onTestFinished(() => {
      session[Symbol.dispose]();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });
    expect({
      face: project.root.bots.scout?.description,
      recipe: sessionCatalog(session.root)?.recipe("scout")?.spec.description,
      reload: session.root.findRunningTurn()?.reloadTools ?? false,
    }).toEqual({ face: "look around", recipe: "look around", reload: false });
  });
});
