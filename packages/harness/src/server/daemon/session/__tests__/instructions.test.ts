import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withInstructions } from "../instructions.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instructions-")));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("withInstructions", () => {
  it("appends nothing when no instruction file exists", () => {
    const root = repo();
    expect(withInstructions("base", root)).toBe("base");
  });

  it("appends each file as a labeled block", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "use pnpm");
    const text = withInstructions("base", root);
    expect(text.startsWith("base\n\n")).toBe(true);
    expect(text).toContain(`Instructions from ${join(root, "AGENTS.md")}:\nuse pnpm`);
  });
});
