/**
 * Every exported Job kind declares its own effect contract. Live acceptance
 * fields are not durable proof; unknown outcome is not auto-retry.
 */
import { Job } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import * as session from "../index.js";

type JobClass = new () => Job;

const CONTRACT = [
  "owner",
  "intent",
  "checkpoint",
  "dispatch",
  "settlement",
  "cancel",
  "unknownRecovery",
  "unknownNote",
  "intentRequired",
] as const;

const RECOVERIES = new Set(["resume-queued", "resume-inner", "unknown-no-replay"]);

function jobClasses(): JobClass[] {
  return (Object.values(session) as unknown[]).filter(
    (value): value is JobClass => typeof value === "function" && value.prototype instanceof Job,
  );
}

function contractOf(Kind: JobClass): string | null {
  const job = new Kind();
  if (job.unknownRecovery === undefined) return null;
  return JSON.stringify(CONTRACT.map((field) => job[field]));
}

describe("job effects/recovery", () => {
  it("every exported job kind declares its own contract", () => {
    const classes = jobClasses();
    const parents = new Set(classes.map((Kind) => Object.getPrototypeOf(Kind) as unknown));
    const missing: string[] = [];
    const inherited: string[] = [];
    for (const Kind of classes) {
      const contract = contractOf(Kind);
      // An abstract intermediate states no contract; a leaf has to.
      if (contract == null) {
        if (!parents.has(Kind)) missing.push(Kind.name);
        continue;
      }
      const Parent = Object.getPrototypeOf(Kind) as JobClass;
      if (classes.includes(Parent) && contractOf(Parent) === contract) inherited.push(Kind.name);
    }
    expect({ missing, inherited, kinds: classes.length > 15 }).toEqual({ missing: [], inherited: [], kinds: true });
  });

  it("does not auto-retry a job that required durable intent", () => {
    const rows = jobClasses()
      .map((Kind) => ({ name: Kind.name, job: new Kind() }))
      .filter(({ job }) => job.unknownRecovery !== undefined);
    expect(rows.filter(({ job }) => !RECOVERIES.has(job.unknownRecovery)).map(({ name }) => name)).toEqual([]);
    expect(
      rows.filter(({ job }) => job.intentRequired && job.unknownRecovery === "resume-queued").map(({ name }) => name),
    ).toEqual([]);
  });
});
