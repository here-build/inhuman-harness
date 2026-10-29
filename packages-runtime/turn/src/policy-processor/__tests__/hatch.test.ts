/**
 * Floor approve is allow-side in every mode. An in-workspace write ask in auto goes to the ask judge.
 * A hatch (download-exec: `npx`, `bunx`, `pnpm dlx`) is never covered by a grant. A literal `allow`
 * program is the ask judge's shortcut and never licenses a soft-deny. This file pins the join.
 */
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { settled, shell, TIMEOUT, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = reasonableDefaultsSource;

const snap = (job: ReturnType<typeof shell>) => ({
  policyResult: job.policyResult,
  classifierResult: job.classifierResult,
  orchestrationResult: job.orchestrationResult,
  code: job.licenseDetail.code,
});

describe("auto join", () => {
  it("floor approve runs; ask goes to the ask judge; soft-deny needs a soft-deny sink", async () => {
    using auto = setup({
      policy: "auto",
      unattended: true,
      policyProgram: FLOOR,
      judgeAskProgram: "allow",
      backoffMs: () => 0,
    });
    const approve = shell("git status");
    const ask = write("src/a.ts");
    const soft = write("package.json");
    for (const job of [approve, ask, soft]) auto.enqueue(job);
    await Promise.all([settled(approve), settled(ask), settled(soft)]);

    using manual = setup({ policy: "manual", policyProgram: FLOOR, judgeAskProgram: "allow" });
    const manualApprove = shell("git status");
    manual.enqueue(manualApprove);
    await settled(manualApprove);

    expect({ approve: snap(approve), ask: snap(ask), soft: snap(soft), manual: snap(manualApprove) }).toEqual({
      approve: { policyResult: "policyApprove", classifierResult: null, orchestrationResult: true, code: null },
      ask: { policyResult: "ask", classifierResult: "allow", orchestrationResult: true, code: null },
      // no user words ask for it, and unattended there is no one to ask: denied, as interaction_required
      soft: {
        policyResult: "deny",
        classifierResult: "deny",
        orchestrationResult: false,
        code: "interaction_required",
      },
      manual: { policyResult: "policyApprove", classifierResult: null, orchestrationResult: true, code: null },
    });
  });

  it("a hatch is not covered by a grant and goes to the judge", async () => {
    const grant = {
      id: "g1",
      scope: "session" as const,
      scopeKey: "s-lic",
      subject: { kind: "command" as const, argv0: "npx", spine: [], args: [] },
      createdAtMs: 0,
      expiresAtMs: null,
      source: "prompt" as const,
      label: "npx",
    };
    using bag = setup({
      policy: "manual",
      policyProgram: FLOOR,
      judgeAskProgram: "allow",
      grants: [grant],
    });
    const hatch = shell("npx tsc");
    bag.enqueue(hatch);
    await when(() => hatch.policyResult !== null, { timeout: TIMEOUT });
    expect({
      policy: hatch.policyResult,
      hatch: hatch.hatch,
      grantedBy: hatch.grantedBy,
      human: hatch.needsHuman,
    }).toEqual({
      policy: "ask",
      hatch: true,
      grantedBy: null,
      human: true,
    });
  });

  it("a write ask in manual covers; the classifier does not start", async () => {
    using manual = setup({ policy: "manual", policyProgram: FLOOR, judgeAskProgram: "allow" });
    const ask = write("src/a.ts");
    const deny = write("package.json");
    manual.enqueue(ask);
    manual.enqueue(deny);
    await when(() => ask.policyResult === "ask" && deny.policyResult === "deny", { timeout: TIMEOUT });
    expect(
      [ask, deny].map((job) => [job.classifierResult, job.classifierAbstain, job.needsHuman, job.orchestrated]),
    ).toEqual([
      [null, null, true, false],
      [null, null, true, false],
    ]);
  });
});
