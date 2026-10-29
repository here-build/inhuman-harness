import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { formatBotMarkdown } from "../parse-bot-markdown.js";
import { defaultBotsHome } from "../paths.js";

describe("kernel home bots", () => {
  it("prefills the isolated home dir and projects admitted faces", { timeout: 15_000 }, async () => {
    const system = await realpath(await mkdtemp(join(tmpdir(), "harness-bots-k-")));
    const home = defaultBotsHome(system);
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "implementer.md"),
      formatBotMarkdown({
        name: "implementer",
        recipeScope: "session",
        description: "operator",
        instructions: prompt.system`Do the brief.`,
        tools: [],
      }),
    );
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    onTestFinished(() => kernel[Symbol.dispose]());
    expect({
      kept: readFileSync(join(home, "implementer.md"), "utf8").includes("Do the brief."),
      reviewerFile: existsSync(join(home, "reviewer.md")),
      faces: Object.keys(kernel.plexus.root.bots).sort(),
      overlay: kernel.catalog.recipes.map((recipe) => recipe.spec.name),
      compiled: kernel.catalog.recipe("implementer")?.category,
    }).toEqual({
      kept: true,
      reviewerFile: true,
      faces: ["implementer"],
      overlay: ["implementer"],
      compiled: "plugin",
    });

    await kernel.homeBotsReady;
    const implementer = join(home, "implementer.md");
    writeFileSync(implementer, readFileSync(implementer, "utf8").replace("Do the brief.", "Patch the brief."));
    writeFileSync(
      join(home, "scout.md"),
      formatBotMarkdown({
        name: "scout",
        recipeScope: "session",
        description: "look around",
        instructions: prompt.system`Look. Cite. Stop.`,
        tools: ["glob"],
      }),
    );
    await when(
      () =>
        kernel.plexus.root.bots.scout != null &&
        kernel.catalog.recipe("implementer")?.spec.instructions.includes("Patch") === true,
      { timeout: 8_000 },
    );
    expect({
      scout: kernel.catalog.recipe("scout")?.spec.description,
      implementer: kernel.catalog.recipe("implementer")?.spec.instructions.includes("Patch"),
      overlay: kernel.catalog.recipes.map((recipe) => recipe.spec.name).sort(),
      faces: Object.keys(kernel.plexus.root.bots).sort(),
    }).toEqual({
      scout: "look around",
      implementer: true,
      overlay: ["implementer", "scout"],
      faces: ["implementer", "scout"],
    });
  });
});
