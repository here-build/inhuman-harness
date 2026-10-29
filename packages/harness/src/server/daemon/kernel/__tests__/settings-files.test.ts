import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfigJson } from "../../../schemas/well-known.js";
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
