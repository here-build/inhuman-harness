/**
 * Hatch is computed from name + argsJson. Download-exec only.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { SystemToolJob } from "../jobs/SystemToolJob.js";

beforeEach(() => resetLocalIDs());

function leaf(name: string, args: Record<string, unknown>) {
  return new SystemToolJob({
    name,
    argsJson: JSON.stringify(args),
  });
}

const rows: readonly [string, Record<string, unknown>, boolean][] = [
  ["shell", { command: "npm run test" }, false],
  ["shell", { command: "timeout npm run x" }, false],
  ["shell", { command: "bash -c 'npm run x'" }, false],
  ["shell", { command: "env X=1 npm run y" }, false],
  ["shell", { command: "npx tsc" }, true],
  ["shell", { command: "timeout npx tsc" }, true],
  ["shell", { command: "bunx tsc" }, true],
  ["shell", { command: "pnpm dlx tsc" }, true],
  ["shell", { command: "yarn dlx tsc" }, true],
  ["shell", { command: "uvx ruff" }, true],
  ["shell", { command: "pnpm run dlx" }, false],
  ["shell", { command: "cargo run" }, false],
  ["shell", { command: "git commit -m x" }, false],
  ["shell", { command: "ls" }, false],
  ["shell", { command: "ls", description: "npx tsc" }, false],
  ["shell", { command: "npx tsc", description: "list files" }, true],
  ["write_file", { path: "package.json" }, false],
  ["write_file", { path: "AGENTS.md" }, false],
  ["write_file", { path: ".vscode/settings.json" }, false],
  ["write_file", { path: "src/a.ts" }, false],
  ["read_file", { path: "package.json" }, false],
  ["mcp__mail__search", { command: "npx tsc" }, false],
];

describe("hatch", () => {
  it("matches download-exec; description is not the command", () => {
    for (const [name, args, hatch] of rows) {
      expect({ name, args, hatch: leaf(name, args).hatch }).toEqual({ name, args, hatch });
    }
  });
});
