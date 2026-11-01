import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillListOutput, skillWriteOutput, skillReadOutput } from "@inhuman.tools/harness-contract";
import { describe, expect, it } from "vitest";

import { parseConfigJson } from "../../../schemas/well-known.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { KernelDaemon } from "../KernelDaemon.js";
import { applyConfigSet, applyPluginSet } from "../settings-config.js";
import {
  listSkillFiles,
  readBotAuthoring,
  removeSkillFile,
  skillBody,
  writeBotFile,
  writeSkillFile,
} from "../settings-files.js";

describe("settings files", () => {
  it("writes a skill under the root and lists it as a project skill", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-skill-"));
    const location = writeSkillFile(root, "review", "Look again", "Read the diff.");
    expect(readFileSync(location, "utf8")).toContain("name: review");
    expect(skillBody(location)).toBe("Read the diff.");
    expect(listSkillFiles(root, null).map((row) => row.name)).toEqual(["review"]);
    removeSkillFile(root, "review");
    expect(listSkillFiles(root, null)).toEqual([]);
  });

  it("qualifies reserved command collisions and retains invoke in the list contract", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-skill-"));
    writeSkillFile(root, "undo", "Skill undo", "Undo a change.");
    const location = join(root, ".agents", "skills", "undo", "SKILL.md");
    const skills = listSkillFiles(root, null, new Set(["undo"]));
    expect(skills).toEqual([
      { name: "undo", description: "Skill undo", location, invoke: "skill:undo", scope: "project" },
    ]);
    expect(skillListOutput.parse({ skills })).toEqual({ skills });
  });

  it("retains canonical invokes for duplicate names across project and home", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-skill-"));
    const home = mkdtempSync(join(tmpdir(), "harness-skill-home-"));
    writeSkillFile(root, "review", "Project review", "Read the diff.");
    writeSkillFile(home, "review", "Home review", "Read the whole project.");
    const projectLocation = join(root, ".agents", "skills", "review", "SKILL.md");
    const homeLocation = join(home, ".agents", "skills", "review", "SKILL.md");
    const listed = listSkillFiles(root, home);
    expect(listed.map(({ name, invoke, scope }) => ({ name, invoke, scope }))).toEqual([
      { name: "review", invoke: "review", scope: "project" },
      { name: "review", invoke: "agents:review", scope: "home" },
    ]);
    const skills = listSkillFiles(root, home, new Set(["review"]));
    expect(skills).toEqual([
      {
        name: "review",
        description: "Project review",
        location: projectLocation,
        invoke: "skill:review",
        scope: "project",
      },
      {
        name: "review",
        description: "Home review",
        location: homeLocation,
        invoke: "agents:review",
        scope: "home",
      },
    ]);
    expect(skillListOutput.parse({ skills })).toEqual({ skills });
  });

  it("refuses a skill name that leaves the root", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-skill-"));
    expect(() => writeSkillFile(root, "../escape", "", "")).toThrow(/invalid skill name/);
  });

  it("writes a bot markdown file", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-bot-"));
    const file = writeBotFile(dir, {
      name: "scribe",
      description: "Writes notes",
      instructions: "Be brief.",
      recipeScope: "session",
      tools: ["read_file"],
      skills: [],
      keepAlive: false,
    });
    expect(readFileSync(file, "utf8")).toContain("Be brief.");
    expect(file.endsWith("scribe.md")).toBe(true);
    writeBotFile(dir, {
      name: "scribe",
      description: "Writes notes",
      instructions: "Be brief.",
      recipeScope: "global",
      tools: ["read_file"],
      skills: [],
      keepAlive: false,
      mcp: [{ server: "notes", tools: ["search"], account: "desk" }],
    });
    expect(readBotAuthoring(dir, "scribe")?.mcp).toEqual([{ server: "notes", tools: ["search"], account: "desk" }]);
  });

  it("patches plugin policy and daemon fields without dropping the other", () => {
    const config = parseConfigJson({
      plugins: { tasks: { enabled: true, guards: ["abc"] } },
      compact: "@inhuman.tools/harness/compact.scm",
    });
    applyPluginSet(config, { name: "tasks", enabled: false });
    expect(config.plugins.tasks).toEqual({ enabled: false, guards: ["abc"] });
    applyConfigSet(config, { approvalAskThrottleMs: 0, textOnlyContinue: false, superKey: "cmd" });
    expect(config.approvalAskThrottleMs).toBe(0);
    expect(config.superKey).toBe("cmd");
    expect(config.reActLoopIntentDetectedTrigger).toMatchObject({ enabled: false });
    expect(config.compact).toBe("@inhuman.tools/harness/compact.scm");
  });
});

it("skill list, write and read agree on the qualified invocation when a host command owns the bare name", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-skill-rpc-k-"));
  const workspace = mkdtempSync(join(tmpdir(), "harness-skill-rpc-p-"));
  await using kernel = new KernelDaemon(root);
  await kernel.ready;
  using project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const written = skillWriteOutput.parse(
    await kernel.handleRequest("skill/write", {
      project: project.path,
      scope: "project",
      name: "compact",
      description: "Local compact skill",
      body: "Summarize the work.",
    }),
  );
  const listed = skillListOutput
    .parse(await kernel.handleRequest("skill/list", { project: project.path }))
    .skills.find((skill) => skill.name === "compact");
  const read = skillReadOutput.parse(
    await kernel.handleRequest("skill/read", { project: project.path, scope: "project", name: "compact" }),
  );
  expect({ write: written.invoke, list: listed?.invoke, read: read.invoke, body: read.body }).toEqual({
    write: "skill:compact",
    list: "skill:compact",
    read: "skill:compact",
    body: "Summarize the work.",
  });
});
