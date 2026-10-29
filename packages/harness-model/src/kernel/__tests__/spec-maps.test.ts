import { prompt } from "@inhuman.tools/harness-commons";
import { expect, test } from "vitest";

import { BotSpec, projectBotSpecs } from "../BotSpec.js";
import { KernelRoot } from "../KernelRoot.js";
import { projectPluginSpec } from "../PluginSpec.js";

test("kernel spec maps replace leftover names", () => {
  const bots = new KernelRoot();
  projectBotSpecs(bots, [
    new BotSpec({ name: "scout", description: "look", instructions: prompt.system`Look.`, tools: ["glob"] }),
    new BotSpec({ name: "gone", instructions: prompt.system`x` }),
  ]);
  projectBotSpecs(bots, [new BotSpec({ name: "scout", description: "watch", error: "bad frontmatter" })]);

  const plugins = new KernelRoot();
  projectPluginSpec(plugins, "tasks", [
    { name: "task__create", question: "Will do later: {{subject}}", effect: "Will do later: {{subject}}" },
  ]);
  projectPluginSpec(plugins, "tasks", [{ name: "task__start", question: "Now working on: {{subject}}" }]);

  expect({
    bots: {
      names: Object.keys(bots.bots),
      name: bots.bots.scout?.name,
      stem: bots.bots.scout?.stem,
      description: bots.bots.scout?.description,
      error: bots.bots.scout?.error,
    },
    plugins: {
      create: plugins.pluginTool("task__create")?.question,
      ghost: plugins.pluginTool("ghost")?.question,
      start: plugins.pluginSpecs.tasks?.tools.task__start?.question,
      uncovered: plugins.pluginSpecs.tasks?.tools.task__start?.effect,
    },
  }).toEqual({
    bots: { names: ["scout"], name: "scout", stem: "scout", description: "watch", error: "bad frontmatter" },
    plugins: { create: undefined, ghost: undefined, start: "Now working on: {{subject}}", uncovered: null },
  });
});
