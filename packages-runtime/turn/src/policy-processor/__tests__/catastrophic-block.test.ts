/**
 * Catastrophic shell commands are a floor `block` in the shipped defaults. No permission mode
 * lifts a block: yolo runs a soft `deny`, but not this; auto with a standing bash grant skips
 * `ask`, but not this; manual never puts it to a human.
 */
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { settled, shell, TIMEOUT } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const CATASTROPHIC = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf --no-preserve-root /",
  "sudo rm -rf /",
  "mkfs.ext4 /dev/sda1",
  "wipefs -a /dev/sda",
  "shred -n 3 /dev/sda",
  "dd if=/dev/zero of=/dev/sda",
  "chmod -R 777 /",
  "chown -R me ~",
] as const;

describe("catastrophic commands are blocked in every mode", () => {
  for (const mode of ["yolo", "auto", "manual"] as const) {
    it(`${mode}: block is final`, async () => {
      using bag = setup({ policy: mode, policyProgram: reasonableDefaultsSource, judgeAskProgram: "" });
      const jobs = CATASTROPHIC.map((command) => shell(command));
      for (const job of jobs) bag.enqueue(job);
      await when(() => jobs.every((job) => job.policyResult !== null), { timeout: TIMEOUT });
      expect(
        jobs.map((job) => ({
          policy: job.policyResult,
          decision: job.licenseDecision,
          needsHuman: job.needsHuman,
        })),
      ).toEqual(CATASTROPHIC.map(() => ({ policy: "block", decision: false, needsHuman: false })));
    });
  }

  it("yolo still runs a soft deny, which is the point of the split", async () => {
    using bag = setup({ policy: "yolo", policyProgram: reasonableDefaultsSource });
    const soft = shell("sudo ls");
    const hard = shell("rm -rf /");
    bag.enqueue(soft);
    bag.enqueue(hard);
    await settled(soft);
    await when(() => hard.policyResult !== null, { timeout: TIMEOUT });
    expect({
      soft: { policy: soft.policyResult, ran: soft.orchestrationResult },
      hard: { policy: hard.policyResult, ran: hard.orchestrationResult },
    }).toEqual({
      soft: { policy: "deny", ran: true },
      hard: { policy: "block", ran: false },
    });
  });
});
