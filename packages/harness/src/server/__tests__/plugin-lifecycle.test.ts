/**
 * Install → use → restart → disable → re-enable, on the behavior surface.
 *
 * A plugin reaches the kernel as a dependency carrying `plugin.json`. Its
 * non-foreground bots compile into surface recipes (`pluginBotRecipes`).
 * Disabling drops the plugin from `behavior.packages()`, so the recipe leaves
 * the catalog; re-enabling brings it back. The same kernel dirs survive a
 * restart.
 *
 * `plugins[].importPath` is not part of this: the pack loader does not import
 * it, and the exemplar packs do not declare one.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { BotCallJob } from "@inhuman.tools/harness-model";
import { isCallPaused } from "@inhuman.tools/turn/agent-calls";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { reflectKernel } from "../daemon/kernel/fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../../../plugins/inhuman-plugin-offload-tingle", import.meta.url));
const PLUGIN_NPM = "@inhuman.tools/plugin-offload-tingle";
const PLUGIN_NAME = "offload-tingle";
const TASKS_ROOT = fileURLToPath(new URL("../../../../../plugins/inhuman-plugin-tasks", import.meta.url));
const TASKS_NPM = "@inhuman.tools/plugin-tasks";
const TASKS_NAME = "tasks";
const BOT = "scout";
const TIMEOUT = 8_000;

function installPlugin(kernelRoot: string, kernel: KernelDaemon, npmName: string, pluginRoot: string): void {
  const pkgPath = join(kernelRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = { ...pkg.dependencies, [npmName]: "0.0.0" };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const link = join(kernelRoot, "node_modules", ...npmName.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(pluginRoot, link);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  reflectKernel(kernelRoot, kernel.plexus.root);
}

function setEnabled(kernelRoot: string, kernel: KernelDaemon, pluginName: string, enabled: boolean): void {
  writeFileSync(
    join(kernelRoot, "config.json"),
    enabled ? "{}\n" : `${JSON.stringify({ plugins: { [pluginName]: { enabled: false } } }, null, 2)}\n`,
  );
  kernel.adjustConfig(() => {});
}

function packWires(kernel: KernelDaemon, pluginName: string): string[] {
  const names: string[] = [];
  for (const entry of kernel.catalog.packEntries) {
    if (entry.source.kind === "pack" && entry.source.pluginName === pluginName) names.push(entry.wireName);
  }
  names.sort();
  return names;
}

describe("plugin lifecycle", () => {
  beforeEach(() => resetLocalIDs());

  it("install_restart_disable_reenable", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-life-k-"));
    let kernel = new KernelDaemon(system);
    await kernel.ready;
    installPlugin(system, kernel, PLUGIN_NPM, PLUGIN_ROOT);
    await when(() => kernel.catalog.recipe(BOT) != null, { timeout: TIMEOUT });
    const installed = kernel.catalog.recipe(BOT)?.spec.behavior;

    kernel[Symbol.dispose]();
    kernel = new KernelDaemon(system);
    await kernel.ready;
    await when(() => kernel.catalog.recipe(BOT) != null, { timeout: TIMEOUT });
    const restarted = kernel.catalog.recipe(BOT)?.spec.behavior;

    setEnabled(system, kernel, PLUGIN_NAME, false);
    await when(() => kernel.catalog.recipe(BOT) == null, { timeout: TIMEOUT });

    setEnabled(system, kernel, PLUGIN_NAME, true);
    await when(() => kernel.catalog.recipe(BOT) != null, { timeout: TIMEOUT });

    await when(() => (kernel.catalog.botRevisions.get(BOT) ?? "") !== "", { timeout: TIMEOUT });
    const revision = kernel.catalog.botRevisions.get(BOT) ?? "";
    const accepted = new BotCallJob({
      name: "agent__send",
      contributionPluginName: PLUGIN_NAME,
      contributionBotName: BOT,
      contributionRevision: revision,
      acceptedAt: Date.now(),
    });

    setEnabled(system, kernel, PLUGIN_NAME, false);
    await when(() => isCallPaused(accepted, kernel.catalog), { timeout: TIMEOUT });
    const paused = isCallPaused(accepted, kernel.catalog);

    setEnabled(system, kernel, PLUGIN_NAME, true);
    await when(() => !isCallPaused(accepted, kernel.catalog), { timeout: TIMEOUT });

    expect({
      installed,
      restarted,
      reenabled: kernel.catalog.recipe(BOT)?.spec.behavior,
      revisionRecorded: revision !== "",
      paused,
      resumed: isCallPaused(accepted, kernel.catalog),
    }).toEqual({
      installed: { plugin: PLUGIN_NAME, bot: BOT },
      restarted: { plugin: PLUGIN_NAME, bot: BOT },
      reenabled: { plugin: PLUGIN_NAME, bot: BOT },
      revisionRecorded: true,
      paused: true,
      resumed: false,
    });

    installPlugin(system, kernel, TASKS_NPM, TASKS_ROOT);
    await when(() => packWires(kernel, TASKS_NAME).includes("task__create"), { timeout: TIMEOUT });
    const shell = packWires(kernel, "shell");
    const namedAgents = packWires(kernel, "named-agents");
    const taskQuestion = kernel.plexus.root.pluginTool("task__create")?.question ?? "";
    setEnabled(system, kernel, TASKS_NAME, false);
    await when(() => packWires(kernel, TASKS_NAME).length === 0, { timeout: TIMEOUT });
    const disabled = {
      tasks: packWires(kernel, TASKS_NAME),
      shell: packWires(kernel, "shell"),
      namedAgents: packWires(kernel, "named-agents"),
      taskFace: kernel.plexus.root.pluginTool("task__create")?.question ?? null,
      shellFace: kernel.plexus.root.pluginTool("shell") != null,
    };
    setEnabled(system, kernel, TASKS_NAME, true);
    await when(() => packWires(kernel, TASKS_NAME).includes("task__create"), { timeout: TIMEOUT });

    expect({
      taskQuestionLoaded: taskQuestion !== "",
      hostShellPresent: shell.length > 0,
      hostAgentsPresent: namedAgents.length > 0,
      disabled,
      restored: kernel.plexus.root.pluginTool("task__create")?.question ?? "",
    }).toEqual({
      taskQuestionLoaded: true,
      hostShellPresent: true,
      hostAgentsPresent: true,
      disabled: {
        tasks: [],
        shell,
        namedAgents,
        taskFace: null,
        shellFace: true,
      },
      restored: taskQuestion,
    });

    onTestFinished(() => kernel[Symbol.dispose]());
  });
});
