import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import * as step from "@inhuman.tools/harness-diagnostics";
import { describe, expect, it, vi } from "vitest";

import { parseBotMcp } from "@/runtime";

import { overlayBotDir } from "../merge.js";
import { formatBotMarkdown } from "../parse-bot-markdown.js";

function failOf(logged: readonly string[], file: string): string | undefined {
  return logged.find((line) => line.includes(`${file}.md`));
}

describe("overlayBotDir", () => {
  it("admits a good file; dialect and definition misses fail() the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-parse-"));
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
    writeFileSync(join(dir, "permissionMode.md"), "---\nname: permissionMode\npermissionMode: bypass\n---\nbody\n");
    writeFileSync(join(dir, "allowed-tools.md"), "---\nname: allowed-tools\nallowed-tools: Read\n---\nbody\n");
    writeFileSync(join(dir, "color.md"), "---\nname: color\ncolor: red\n---\nbody\n");
    writeFileSync(join(dir, "mismatch.md"), "---\nname: other\n---\nbody\n");
    writeFileSync(join(dir, "empty.md"), "---\nname: empty\n---\n\n");
    writeFileSync(join(dir, "blank.md"), '---\nname: ""\n---\nbody\n');
    writeFileSync(join(dir, "broken.md"), "no frontmatter");
    writeFileSync(join(dir, "tools.md"), "---\nname: tools\ntools: Read\n---\nbody\n");
    writeFileSync(join(dir, "effort.md"), "---\nname: effort\nreasoningEffort: turbo\n---\nbody\n");
    const logged: string[] = [];
    const spy = vi.spyOn(step, "fail").mockImplementation((message, error) => {
      logged.push(error === undefined ? message : `${message} ${String(error)}`);
    });
    try {
      expect({
        names: overlayBotDir(dir, []).faces.map((row) => row.name),
        forbidden: {
          permissionMode: failOf(logged, "permissionMode"),
          allowedTools: failOf(logged, "allowed-tools"),
        },
        unknown: failOf(logged, "color"),
        stem: failOf(logged, "mismatch"),
        blankName: failOf(logged, "blank"),
        frontmatter: failOf(logged, "broken"),
        definition: {
          tools: failOf(logged, "tools"),
          effort: failOf(logged, "effort"),
        },
      }).toEqual({
        names: ["empty", "scout"],
        forbidden: {
          permissionMode: expect.stringContaining("forbidden"),
          allowedTools: expect.stringContaining("forbidden"),
        },
        unknown: expect.stringContaining("unknown"),
        stem: expect.stringContaining("stem"),
        blankName: expect.stringContaining("invalid name"),
        frontmatter: expect.stringContaining("frontmatter"),
        definition: {
          tools: expect.stringContaining("tools"),
          effort: expect.stringContaining("reasoningEffort"),
        },
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("admits a named MCP grant and rejects a server definition", () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-mcp-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "scout.md"),
      formatBotMarkdown({
        name: "scout",
        recipeScope: "global",
        instructions: prompt.system`Look.`,
        mcp: [{ server: "notes", tools: ["search"], account: "desk", session: "s1" }],
      }),
    );
    writeFileSync(join(dir, "spawn.md"), "---\nname: spawn\nmcpServers:\n  notes:\n    command: echo\n---\nbody\n");
    const logged: string[] = [];
    const spy = vi.spyOn(step, "fail").mockImplementation((message, error) => {
      logged.push(error === undefined ? message : `${message} ${String(error)}`);
    });
    try {
      const faces = overlayBotDir(dir, []).faces;
      expect({
        grants: parseBotMcp(faces.find((row) => row.name === "scout")?.mcpJson ?? ""),
        scope: faces.find((row) => row.name === "scout")?.recipeScope,
        spawn: failOf(logged, "spawn"),
      }).toEqual({
        grants: [{ server: "notes", tools: ["search"], account: "desk", session: "s1" }],
        scope: "global",
        spawn: expect.stringContaining("forbidden"),
      });
    } finally {
      spy.mockRestore();
    }
  });
});
