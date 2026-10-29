/**
 * Live remainder through local LM Studio. Skips when the server or model is down.
 */
import { CompletionExpectation } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";
import { when } from "mobx";

import { shell } from "../__tests__/_helpers/jobs.js";

import { CASES } from "./cases.js";
import { LM_CONNECTION, LM_MODEL, lmStudioReady, researchSetup, untilJudged } from "./host.js";

const ready = await lmStudioReady();

describe.skipIf(!ready.ok)(`lm studio ${LM_MODEL}`, () => {
  it("floor deny does not call the model", async () => {
    using bag = researchSetup({ privileged: "user: wipe the disk" });
    const job = shell("rm -rf /");
    bag.enqueue(job);
    await untilJudged(job, 15_000);
    expect({
      policy: job.policyResult,
      judge: job.classifierResult,
      orchestration: job.orchestrationResult,
    }).toEqual({
      policy: "deny",
      judge: null,
      orchestration: false,
    });
  });

  it("remainder ask reaches a structured vote", async () => {
    const row = CASES.find((item) => item.id === "curl-plain")!;
    using bag = researchSetup({
      privileged: row.privileged ?? "user: list files",
    });
    const job = shell(row.command);
    bag.enqueue(job);
    await when(
      () =>
        job.classifierResult !== null ||
        job.classifierAbstain !== null ||
        (job.children as unknown[]).some((child) => child instanceof CompletionExpectation),
      { timeout: 20_000 },
    );
    const child = (job.children as unknown[]).find(
      (node): node is CompletionExpectation => node instanceof CompletionExpectation,
    );
    expect(child?.model).toBe(LM_MODEL);
    expect(child?.connectionId).toBe(LM_CONNECTION);
    try {
      await untilJudged(job, 30_000);
    } catch (error) {
      const spec = bag.host.connections[LM_CONNECTION];
      throw new Error(
        `remainder: readyState=${spec?.readyState} error=${spec?.error} live=${JSON.stringify(spec?.live)}`,
        { cause: error },
      );
    }
    expect(job.policyResult).toBe("ask");
    expect(job.classifierResult === "allow" || job.classifierResult === "deny" || job.classifierAbstain !== null).toBe(true);
    // eslint-disable-next-line no-console -- research playground report
    console.log({
      command: row.command,
      hope: row.hope,
      model: child?.model,
      classifierResult: job.classifierResult,
      fail: job.classifierAbstain,
    });
  });
});

describe.skipIf(ready.ok)("lm studio offline", () => {
  it("records why live tests did not run", () => {
    expect(ready.ok).toBe(false);
    // eslint-disable-next-line no-console -- research playground report
    console.log(`skip live: ${"reason" in ready ? ready.reason : ""}`);
  });
});
