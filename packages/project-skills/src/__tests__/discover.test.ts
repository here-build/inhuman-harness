/**
 * Discovery walks gentlemen then courtesy drawers, cwd to git root, then
 * user homes. Farm symlink is skipped; a real Claude drawer is not.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { discoverProjectSkills, expandSkillPrompt } from "../index.js";

const BODY = `---
name: review
description: Review the diff. Use when the user asks to review.
---

Read the diff. Name risks.
`;

function writeSkill(root: string, drawer: readonly string[], name: string, body = BODY): string {
  const dir = join(root, ...drawer, name);
  mkdirSync(dir, { recursive: true });
  const location = join(dir, "SKILL.md");
  writeFileSync(location, body.replace(/^name: review/m, `name: ${name}`));
  return location;
}

describe("discoverProjectSkills", () => {
  it("lists one-level agents and claude drawers, skips farm and nested, walks to git root, qualifies collisions", async () => {
    const repo = await mkdtemp(join(tmpdir(), "harness-skills-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeSkill(nested, [".agents", "skills"], "review");
    writeSkill(nested, [".agents", "skills"], "mismatch", BODY.replace("name: review", "name: other"));
    mkdirSync(join(nested, ".agents", "skills", "engineering", "tdd"), { recursive: true });
    writeFileSync(
      join(nested, ".agents", "skills", "engineering", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: TDD.\n---\nRed green.\n",
    );
    const other = await mkdtemp(join(tmpdir(), "harness-skills-link-"));
    writeSkill(other, [".agents", "skills"], "linked");
    mkdirSync(join(nested, ".agents", "skills"), { recursive: true });
    symlinkSync(join(other, ".agents", "skills", "linked"), join(nested, ".agents", "skills", "linked"));
    writeSkill(
      repo,
      [".claude", "skills"],
      "review",
      "---\nname: review\ndescription: Root Claude review.\n---\nRoot Claude.\n",
    );
    writeSkill(
      repo,
      [".agents", "skills"],
      "root-only",
      "---\nname: root-only\ndescription: Repo-root agents skill.\n---\nFrom root.\n",
    );

    const farm = await mkdtemp(join(tmpdir(), "harness-skills-farm-"));
    mkdirSync(join(farm, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(farm, ".claude", "skills", "review", "SKILL.md"), BODY);
    symlinkSync(join(farm, ".claude"), join(farm, ".agents"));

    const home = await mkdtemp(join(tmpdir(), "harness-skills-home-"));
    writeSkill(
      home,
      [".agents", "skills"],
      "review",
      "---\nname: review\ndescription: User agents review.\n---\nUser agents.\n",
    );
    writeSkill(
      home,
      [".config", "agents", "skills"],
      "personal",
      "---\nname: personal\ndescription: XDG personal skill.\n---\nXDG.\n",
    );
    writeSkill(
      home,
      [".claude", "skills"],
      "review",
      "---\nname: review\ndescription: User Claude review.\n---\nUser Claude.\n",
    );
    writeSkill(nested, [".claude", "skills"], "review");
    writeSkill(nested, [".cursor", "skills"], "review");
    writeSkill(
      nested,
      [".codex", "skills"],
      "review",
      "---\nname: review\ndescription: Codex review.\n---\nCodex review.\n",
    );
    writeSkill(
      nested,
      [".grok", "skills"],
      "first-run",
      "---\nname: first-run\ndescription: Grok first-run skill.\n---\nGrok first-run.\n",
    );
    writeSkill(
      home,
      [".cursor", "skills"],
      "pretty",
      "---\nname: pretty\ndescription: User cursor pretty skill.\n---\nPretty.\n",
    );
    writeSkill(
      nested,
      [".agents", "skills"],
      "undo",
      "---\nname: undo\ndescription: Skill undo.\n---\nSkill undo body.\n",
    );

    const listed = discoverProjectSkills(nested, home, new Set(["undo"]));
    const farmListed = discoverProjectSkills(farm, null);
    const at = (invoke: string, body: string) => {
      const row = listed.find((skill) => skill.invoke === invoke);
      return {
        prompt: `/${invoke} leftover`,
        derived: `<skill name="${row?.name}" location="${row?.location}">\n${body}\n</skill>\n\nleftover`,
      };
    };
    const reviews = listed.filter((row) => row.name === "review");
    const userAgents = expandSkillPrompt("/agents:review leftover", listed, new Set(["undo"]));
    const qualifiedClaude = expandSkillPrompt("/claude:review leftover", listed, new Set(["undo"]));
    const bare = expandSkillPrompt("/personal leftover", listed, new Set(["undo"]));
    const winner = expandSkillPrompt("/review leftover", listed, new Set(["undo"]));
    const hostKept = expandSkillPrompt("/undo leftover", listed, new Set(["undo"]));
    const skillEscape = expandSkillPrompt("/skill:undo leftover", listed, new Set(["undo"]));
    const skillBare = expandSkillPrompt("/skill:review leftover", listed, new Set(["undo"]));
    const cursorCopy = expandSkillPrompt("/cursor:review leftover", listed, new Set(["undo"]));
    const codex = expandSkillPrompt("/codex:review leftover", listed, new Set(["undo"]));
    const grok = expandSkillPrompt("/first-run leftover", listed, new Set(["undo"]));
    const pretty = expandSkillPrompt("/pretty leftover", listed, new Set(["undo"]));

    const orphan = await mkdtemp(join(tmpdir(), "harness-skills-orphan-"));
    const child = join(orphan, "app");
    mkdirSync(child, { recursive: true });
    writeSkill(
      orphan,
      [".agents", "skills"],
      "parent-only",
      "---\nname: parent-only\ndescription: Parent of a non-git tree.\n---\nParent.\n",
    );
    writeSkill(
      child,
      [".agents", "skills"],
      "child-only",
      "---\nname: child-only\ndescription: Child of a non-git tree.\n---\nChild.\n",
    );

    expect({
      names: listed.map((row) => row.name),
      reviewInvokes: reviews.map((row) => row.invoke),
      undo: listed.filter((row) => row.name === "undo").map((row) => row.invoke),
      nested: listed.some((row) => row.name === "tdd"),
      farm: farmListed.map((row) => row.name),
      winner,
      userAgents,
      claude: qualifiedClaude,
      unique: bare,
      hostKept,
      skillEscape,
      skillBare,
      cursorCopy,
      codex,
      grok,
      pretty,
      orphan: discoverProjectSkills(child, null).map((row) => row.name),
    }).toEqual({
      names: [
        "first-run",
        "linked",
        "personal",
        "pretty",
        "review",
        "review",
        "review",
        "review",
        "review",
        "root-only",
        "undo",
      ],
      reviewInvokes: ["review", "codex:review", "claude:review", "agents:review", "claude:review-2"],
      undo: ["skill:undo"],
      nested: false,
      farm: ["review"],
      winner: at("review", "Read the diff. Name risks."),
      userAgents: at("agents:review", "User agents."),
      claude: at("claude:review", "Root Claude."),
      unique: at("personal", "XDG."),
      hostKept: { prompt: "/undo leftover", derived: null },
      skillEscape: at("skill:undo", "Skill undo body."),
      skillBare: (() => {
        const row = listed.find((skill) => skill.name === "review");
        return {
          prompt: "/skill:review leftover",
          derived: `<skill name="review" location="${row?.location}">\nRead the diff. Name risks.\n</skill>\n\nleftover`,
        };
      })(),
      cursorCopy: { prompt: "/cursor:review leftover", derived: null },
      codex: at("codex:review", "Codex review."),
      grok: at("first-run", "Grok first-run."),
      pretty: at("pretty", "Pretty."),
      orphan: ["child-only"],
    });
  });
});
