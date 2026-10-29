/**
 * Default-suite runner: every JSON under fixtures/** is a test case.
 * Tests import sources via package alias / relative src paths (not dist/).
 */
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

import { assertFixtureFloor, loadAllFixtures, runFixtureCase } from "./harness.js";

const fixturesRoot = fileURLToPath(new URL("fixtures", import.meta.url));
const all = loadAllFixtures();

describe("fixtures/** (default suite)", () => {
  it("categories.json floor — non-empty, every category has cases", () => {
    assertFixtureFloor();
  });
  for (const { path, case: fx } of all) {
    const label = relative(fixturesRoot, path);
    it(label, async () => {
      await runFixtureCase(fx);
    });
  }
});
