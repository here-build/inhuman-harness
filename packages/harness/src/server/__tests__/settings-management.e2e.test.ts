/**
 * Settings writes go through the kernel RPC, then the assertion reads the
 * plexus document that session is running on. The RPC return is only the ack.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { when } from "mobx";
import { beforeEach, describe, expect, it } from "vitest";

import {
  botRemoveOutput,
  botWriteOutput,
  connectUpdateOutput,
  mcpServerAdoptOutput,
  pluginInstallOutput,
  pluginRemoveOutput,
  pluginSetOutput,
  skillListOutput,
  skillReadOutput,
  skillRemoveOutput,
  skillWriteOutput,
} from "@/protocol/rpc";

import { defaultBotsHome } from "../daemon/bots/paths.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { writeBotFile } from "../daemon/kernel/settings-files.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

const TASKS = fileURLToPath(new URL("../../../../../plugins/inhuman-plugin-tasks", import.meta.url));
const FACE_TIMEOUT = 4_000;

describe("settings management", () => {
  beforeEach(() => resetLocalIDs());

  it("writes skills, bots, plugins, and an mcp server onto the live documents", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-settings-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-settings-p-"));
    const home = await mkdtemp(join(tmpdir(), "harness-settings-h-"));
    const kernel = new KernelDaemon(system);
    let opened = false;
    try {
      await kernel.ready;
      opened = true;
      const project = new ProjectDaemon(kernel, workspace);
      await project.ready;
      const previousHome = process.env.INHUMAN_HOME;
      try {
        process.env.INHUMAN_HOME = home;
        const projectSkill = skillWriteOutput.parse(
          await kernel.handleRequest("skill/write", {
            scope: "project",
            project: project.path,
            name: "review-e2e",
            description: "Look again",
            body: "Read the diff.",
          }),
        );
        const homeSkill = skillWriteOutput.parse(
          await kernel.handleRequest("skill/write", {
            scope: "home",
            name: "home-glance",
            description: "From home",
            body: "Stay here.",
          }),
        );
        const listed = skillListOutput.parse(await kernel.handleRequest("skill/list", { project: project.path }));
        const read = skillReadOutput.parse(
          await kernel.handleRequest("skill/read", {
            scope: "project",
            project: project.path,
            name: "review-e2e",
          }),
        );
        const first = await project.session("s1");
        const admitted = first.root.skills.map((skill) => skill.name);

        skillRemoveOutput.parse(
          await kernel.handleRequest("skill/remove", {
            scope: "project",
            project: project.path,
            name: "review-e2e",
          }),
        );
        skillRemoveOutput.parse(await kernel.handleRequest("skill/remove", { scope: "home", name: "home-glance" }));
        const again = skillListOutput.parse(await kernel.handleRequest("skill/list", { project: project.path }));
        const second = await project.session("s2");

        expect({
          projectSkill,
          homeSkill,
          listed: listed.skills.map((skill) => skill.name),
          body: read.body,
          admitted,
          afterRemove: again.skills.map((skill) => skill.name),
          mintedAgain: second.root.skills.map((skill) => skill.name),
        }).toEqual({
          projectSkill: expect.objectContaining({ name: "review-e2e", scope: "project", description: "Look again" }),
          homeSkill: expect.objectContaining({ name: "home-glance", scope: "home" }),
          listed: expect.arrayContaining(["review-e2e", "home-glance"]),
          body: "Read the diff.",
          admitted: expect.arrayContaining(["review-e2e", "home-glance"]),
          afterRemove: expect.not.arrayContaining(["review-e2e", "home-glance"]),
          mintedAgain: expect.not.arrayContaining(["review-e2e", "home-glance"]),
        });
      } finally {
        if (previousHome === undefined) delete process.env.INHUMAN_HOME;
        else process.env.INHUMAN_HOME = previousHome;
      }

      writeBotFile(defaultBotsHome(kernel.root), {
        name: "keeper",
        description: "Holds a behavior",
        instructions: "Keep it.",
        recipeScope: "session",
        tools: [],
        skills: [],
        keepAlive: false,
        behavior: { program: "./keep.scm" },
      });
      await when(() => kernel.plexus.root.bots.keeper?.behaviorJson != null, { timeout: FACE_TIMEOUT });
      botWriteOutput.parse(
        await kernel.handleRequest("bot/write", {
          scope: "home",
          name: "keeper",
          description: "Keeps",
          instructions: "Keep it.",
          recipeScope: "session",
          tools: [],
          skills: [],
          keepAlive: false,
        }),
      );
      await when(() => kernel.plexus.root.bots.keeper?.description === "Keeps", { timeout: FACE_TIMEOUT });

      botWriteOutput.parse(
        await kernel.handleRequest("bot/write", {
          scope: "home",
          name: "scribe",
          description: "Writes notes",
          instructions: "Be brief.",
          recipeScope: "session",
          tools: ["read_file"],
          skills: [],
          keepAlive: false,
        }),
      );
      await when(() => kernel.plexus.root.bots.scribe != null, { timeout: FACE_TIMEOUT });
      botWriteOutput.parse(
        await kernel.handleRequest("bot/write", {
          scope: "home",
          name: "glance",
          description: "Looks again",
          instructions: "Look.",
          recipeScope: "session",
          tools: [],
          skills: ["review-e2e"],
          keepAlive: false,
          invokes: ["scribe"],
          reasoningEffort: "low",
          modelPreferences: ["gpt-test"],
          mcp: [{ server: "notes", tools: ["search"], account: "desk" }],
        }),
      );
      await when(() => kernel.plexus.root.bots.glance?.reasoningEffort === "low", { timeout: FACE_TIMEOUT });
      botWriteOutput.parse(
        await kernel.handleRequest("bot/write", {
          scope: "home",
          name: "glance",
          description: "Edits notes",
          instructions: "Look.",
          recipeScope: "session",
          tools: [],
          skills: ["review-e2e"],
          keepAlive: false,
        }),
      );
      await when(() => kernel.plexus.root.bots.glance?.description === "Edits notes", { timeout: FACE_TIMEOUT });
      const glance = kernel.plexus.root.bots.glance;
      const kept: unknown = JSON.parse(kernel.plexus.root.bots.keeper?.behaviorJson ?? "null");
      const glanceMcp: unknown = JSON.parse(glance?.mcpJson || "[]");
      const glanceFace = {
        description: glance?.description,
        invokes: glance == null ? [] : [...glance.invokes],
        reasoningEffort: glance?.reasoningEffort,
        modelPreferences: glance == null ? [] : [...glance.modelPreferences],
        skills: glance == null ? [] : [...glance.skills],
        mcp: glanceMcp,
      };

      botWriteOutput.parse(
        await kernel.handleRequest("bot/write", {
          scope: "project",
          project: project.path,
          name: "note",
          description: "Project note",
          instructions: "Local.",
          recipeScope: "project",
          tools: [],
          skills: [],
          keepAlive: true,
          mcp: [{ server: "notes" }],
        }),
      );
      await when(() => (project.root.bots.note?.mcpJson ?? "") !== "", { timeout: FACE_TIMEOUT });
      const noteMcp: unknown = JSON.parse(project.root.bots.note?.mcpJson || "[]");
      botRemoveOutput.parse(
        await kernel.handleRequest("bot/remove", { scope: "project", project: project.path, name: "note" }),
      );
      await when(() => project.root.bots.note == null, { timeout: FACE_TIMEOUT });
      botRemoveOutput.parse(await kernel.handleRequest("bot/remove", { scope: "home", name: "glance" }));
      await when(() => kernel.plexus.root.bots.glance == null, { timeout: FACE_TIMEOUT });

      const adopted = mcpServerAdoptOutput.parse(
        await kernel.handleRequest("mcp-server/adopt", {
          name: "notes",
          settings: { command: "echo", args: ["hi"] },
        }),
      );
      if (!("id" in adopted)) throw new Error("mcp adopt did not connect");
      connectUpdateOutput.parse(
        await kernel.handleRequest("connect/update", {
          id: adopted.id,
          name: "notes-local",
          settings: { command: "printf" },
        }),
      );
      const connection = kernel.plexus.root.connections[adopted.id];
      const connectionFace = {
        driver: connection?.driver.name,
        name: connection?.name,
        command: connection?.configuration.command,
        args: connection?.configuration.args,
      };

      const installed = pluginInstallOutput.parse(
        await kernel.handleRequest("plugin/install", { spec: pathToFileURL(TASKS).href }),
      );
      pluginSetOutput.parse(
        await kernel.handleRequest("plugin/set", { name: "tasks", enabled: false, foreground: false }),
      );
      const disabled = kernel.plexus.root.plugins.tasks;
      pluginRemoveOutput.parse(await kernel.handleRequest("plugin/remove", { name: "tasks" }));

      expect({
        keeper: kept,
        glance: glanceFace,
        note: noteMcp,
        noteGone: project.root.bots.note == null,
        glanceGone: kernel.plexus.root.bots.glance == null,
        connection: connectionFace,
        installed,
        disabled: { enabled: disabled?.enabled, foreground: disabled?.foreground },
        removed: kernel.plexus.root.plugins.tasks == null,
      }).toEqual({
        keeper: { program: "./keep.scm" },
        glance: {
          description: "Edits notes",
          invokes: ["scribe"],
          reasoningEffort: "low",
          modelPreferences: ["gpt-test"],
          skills: ["review-e2e"],
          mcp: [{ server: "notes", tools: ["search"], account: "desk" }],
        },
        note: [{ server: "notes" }],
        noteGone: true,
        glanceGone: true,
        connection: {
          driver: "mcp-stdio",
          name: "notes-local",
          command: "printf",
          args: ["hi"],
        },
        installed: { name: "tasks", npmName: "@inhuman.tools/plugin-tasks" },
        disabled: { enabled: false, foreground: false },
        removed: true,
      });
    } finally {
      if (opened) kernel[Symbol.dispose]();
    }
  }, 120_000);
});
