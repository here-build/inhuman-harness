import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { packageStrategyPath, resolveCompactStrategyPath } from "../index.js";
import { shippedPolicyFile } from "../policy-asset.js";

describe("resolveCompactStrategyPath", () => {
  it("resolves the package name to the shipped strategy", () => {
    const root = join(tmpdir(), "compact-strategy-unused");
    const shipped = packageStrategyPath();
    expect(resolveCompactStrategyPath("@inhuman.tools/harness/compact.scm", root)).toBe(shipped);
  });

  it("resolves policy-processor document tokens onto the shipped policy assets", () => {
    const root = join(tmpdir(), "compact-strategy-unused");
    const ask = shippedPolicyFile("auto-mode-ask.scm");
    expect(resolveCompactStrategyPath("@inhuman.tools/policy-processor/auto-mode-ask.scm", root)).toBe(ask);
    expect(() => resolveCompactStrategyPath("@inhuman.tools/judge-processor/auto-mode-judge.scm", root)).toThrow();
  });

  it("still fails an unknown package prefix through node resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-strategy-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "kernel", private: true }));
    expect(() => resolveCompactStrategyPath("@inhuman.tools/not-harness/compact.scm", root)).toThrow(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    );
  });
});
