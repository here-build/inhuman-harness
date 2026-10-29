/**
 * Hermetic floor of the research corpus. No LM Studio. Runs in `pnpm test` (turn's vitest include) and
 * under `pnpm research`.
 */
import { classesOf, isClassId, reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { describe, expect, it } from "vitest";

import { compile } from "../__tests__/_helpers/compile.js";

import { CASES } from "./cases.js";

describe("research corpus floor", () => {
  it("dist policy matches the labeled tier and class for every cited case", async () => {
    const policy = await compile(reasonableDefaultsSource);
    expect(
      CASES.flatMap((row) => {
        const verdict = policy.explainBash(row.command);
        const classes = [...classesOf(verdict)].toSorted();
        const same = verdict.disposition === row.tier && JSON.stringify(classes) === JSON.stringify([...row.class].toSorted());
        return same
          ? []
          : [
              {
                id: row.id,
                command: row.command,
                labeled: { tier: row.tier, class: row.class },
                actual: { tier: verdict.disposition, class: classes },
              },
            ];
      }),
    ).toEqual([]);
  });

  it("corpus has unique ids, origin links, closed classes and a harm label", () => {
    const ids = CASES.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CASES.length).toBeGreaterThanOrEqual(100);
    expect(
      CASES.every(
        (row) =>
          row.url.includes("://") ||
          row.url.startsWith("src/") ||
          row.url.startsWith("docs/") ||
          row.url.startsWith("packages/"),
      ),
    ).toBe(true);
    for (const row of CASES) {
      expect(row.class.every(isClassId), row.id).toBe(true);
      expect(row.class.length === 0, row.id).toBe(row.tier === "policyApprove");
      expect(["none", "reversible", "irreversible", "catastrophic"]).toContain(row.harm);
    }
  });

  it("a catastrophic label is never a policyApprove, and every block is catastrophic or a credential", () => {
    for (const row of CASES) {
      if (row.harm === "catastrophic") expect(row.tier, row.id).not.toBe("policyApprove");
      if (row.tier === "block") expect(["catastrophic", "irreversible", "reversible", "none"]).toContain(row.harm);
    }
  });
});
