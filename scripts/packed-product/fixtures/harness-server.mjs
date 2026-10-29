export const packageName = "@inhuman.tools/harness";
export const binName = "harness-daemon";
export const binPath = "./dist/server/bin.js";
export const exportPaths = [".", "./testkit"];
export const files = ["dist", "compact.scm", "compact.prompt", "src/server/defaults", "!**/__tests__"];
export const packedIncludes = [
  "src/server/defaults/compact.scm",
  "src/server/defaults/commands/connect.scm",
  "src/server/defaults/commands/model.scm",
  "src/server/defaults/commands/mcp.scm",
  "src/server/defaults/system-prompt/system-prompt.scm",
  "src/server/defaults/system-prompt/SYSTEM.md",
  "src/server/defaults/system-prompt/preamble.hbs",
  "src/server/defaults/system-prompt/tools.hbs",
  "compact.scm",
  "package.json",
];
export const packLabel = "harness";
export const barrel = "packages/harness/src/server/index.ts";
// The core's test door, by source alias (inside the core) and by package name (from a shell's tests).
export const testkitSpecifiers = ["@/server/testkit", "@inhuman.tools/harness/testkit"];
export const compositionNeedle = "/composition";
