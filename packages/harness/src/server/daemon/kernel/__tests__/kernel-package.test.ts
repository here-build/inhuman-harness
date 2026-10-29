/** The kernel's own package.json: seeded with a real semver range, and healed when an older kernel recorded `workspace:`. */
import { expect, it } from "vitest";

import { healKernelDependencies, seedRange } from "../kernel-package.js";

const NAME = "@inhuman.tools/plugin-tasks";

it("seeds a missing plugin-tasks with the resolved range", () => {
  const deps: Record<string, string> = {};
  expect(healKernelDependencies(deps, () => "^0.1.0")).toBe(true);
  expect(deps).toEqual({ [NAME]: "^0.1.0" });
});

it("migrates a recorded workspace: spec and leaves real ranges alone", () => {
  const stale: Record<string, string> = { [NAME]: "workspace:*", other: "workspace:^" };
  expect(healKernelDependencies(stale, (name) => (name === NAME ? "^0.1.0" : "^2.0.0"))).toBe(true);
  expect(stale).toEqual({ [NAME]: "^0.1.0", other: "^2.0.0" });

  const fine: Record<string, string> = { [NAME]: "^0.3.0", extra: "1.2.3" };
  expect(healKernelDependencies(fine, () => "^9.9.9")).toBe(false);
  expect(fine).toEqual({ [NAME]: "^0.3.0", extra: "1.2.3" });
});

it("takes the range from the resolved package, falling back to ^0.1.0", () => {
  const found = ((id: string) => ({ version: id.startsWith(NAME) ? "0.4.2" : "x" })) as unknown as NodeJS.Require;
  expect(seedRange(NAME, found)).toBe("^0.4.2");
  const missing = (() => {
    throw new Error("nope");
  }) as unknown as NodeJS.Require;
  expect(seedRange(NAME, missing)).toBe("^0.1.0");
});

it("resolves the in-repo plugin-tasks to a caret range", () => {
  expect(seedRange(NAME)).toMatch(/^\^\d+\.\d+\.\d+/);
});
