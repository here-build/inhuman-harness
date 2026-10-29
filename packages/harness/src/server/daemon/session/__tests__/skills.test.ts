/**
 * Project skills are `.agents/skills/<name>/SKILL.md`. The `.agents`↔`.claude`
 * symlink farm is skipped as an agents drawer; the real `.claude/skills`
 * still lists. Other skill-dir symlinks are not skipped.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { mkdtemp, writeJson } from "fs-extra";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const SKILL = `---
name: review
description: Review the diff. Use when the user asks to review.
---

Read the diff. Name risks.
`;

function writeSkill(root: string, name: string, body = SKILL): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("project skills", () => {
  beforeEach(() => resetLocalIDs());

  it("session attach lists one-level skills, skips farm and nested, expands /name unless host-reserved", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-skills-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-skills-p-"));
    const skillBlock = (name: string, body: string): string =>
      `<skill name="${name}" location="${join(realpathSync(workspace), ".agents", "skills", name, "SKILL.md")}">\n${body}\n</skill>`;
    writeSkill(workspace, "review");
    writeSkill(workspace, "mismatch", SKILL.replace("name: review", "name: other"));
    writeSkill(workspace, "undo", "---\nname: undo\ndescription: Undo last.\n---\n\nUndo the last edit.\n");
    mkdirSync(join(workspace, ".agents", "skills", "engineering", "tdd"), { recursive: true });
    writeFileSync(
      join(workspace, ".agents", "skills", "engineering", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: TDD.\n---\nRed green.\n",
    );
    const other = await mkdtemp(join(tmpdir(), "harness-skills-link-"));
    writeSkill(
      other,
      "linked",
      "---\nname: linked\ndescription: Review the diff. Use when the user asks to review.\n---\n\nRead the diff. Name risks.\n",
    );
    symlinkSync(join(other, ".agents", "skills", "linked"), join(workspace, ".agents", "skills", "linked"));

    const farm = await mkdtemp(join(tmpdir(), "harness-skills-farm-"));
    mkdirSync(join(farm, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(farm, ".claude", "skills", "review", "SKILL.md"), SKILL);
    symlinkSync(join(farm, ".claude"), join(farm, ".agents"));

    await writeJson(join(system, "config.json"), { connections: {} });
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const farmProject = new ProjectDaemon(kernel, farm);
    await farmProject.ready;
    const session = await project.session("s1");
    const reservedSession = await project.session("s2");
    const farmSession = await farmProject.session("farm");
    onTestFinished(() => {
      session[Symbol.dispose]();
      reservedSession[Symbol.dispose]();
      farmSession[Symbol.dispose]();
      project[Symbol.dispose]();
      farmProject[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });
    await session.handleRequest("kv/set", { key: "connection", value: "c1" });
    await reservedSession.handleRequest("kv/set", { key: "connection", value: "c1" });
    const skillUndo = await project.session("s3");
    onTestFinished(() => skillUndo[Symbol.dispose]());
    await session.handleRequest("turn", { prompt: "/review the login" });
    await reservedSession.handleRequest("turn", { prompt: "/undo leftover" });
    await skillUndo.handleRequest("kv/set", { key: "connection", value: "c1" });
    await skillUndo.handleRequest("turn", { prompt: "/skill:undo leftover" });
    expect({
      listed: session.root.skills.map((row) => ({ name: row.name, invoke: row.invoke === "" ? row.name : row.invoke })),
      nested: session.root.skills.some((row) => row.name === "tdd"),
      farm: farmSession.root.skills.map((row) => ({
        name: row.name,
        invoke: row.invoke === "" ? row.name : row.invoke,
      })),
      typed: session.root.head?.prompt,
      prompt: session.root.head?.completionMessage,
      reserved: reservedSession.root.head?.completionMessage,
      skillUndo: skillUndo.root.head?.completionMessage,
    }).toEqual({
      listed: [
        { name: "linked", invoke: "linked" },
        { name: "review", invoke: "review" },
        { name: "undo", invoke: "skill:undo" },
      ],
      nested: false,
      farm: [{ name: "review", invoke: "review" }],
      typed: "/review the login",
      prompt: `${skillBlock("review", "Read the diff. Name risks.")}\n\nthe login`,
      reserved: "/undo leftover",
      skillUndo: `${skillBlock("undo", "Undo the last edit.")}\n\nleftover`,
    });
  });
});
