import { syncing } from "@here.build/plexus";
import { computed } from "mobx";
import { describe, expect, it } from "vitest";

import { type JobResolution } from "../shared/index.js";
import { ContractJob, homeJobs, StoredJob } from "./_helpers/test-jobs.js";

describe("Job", () => {
  it("markComplete ends without inventing a start", () => {
    const job = new StoredJob();
    job.markComplete(2000);
    expect({
      started: job.startedAtMs,
      ended: job.endedAtMs,
      completed: job.completed,
      duration: job.durationMs(),
    }).toEqual({
      started: null,
      ended: 2000,
      completed: true,
      duration: null,
    });
  });

  it("markComplete seals completed and the end clock in one update", () => {
    const job = new StoredJob();
    using _home = homeJobs(job);
    const doc = job.__doc__;
    let updates = 0;
    doc?.on("update", () => updates++);
    job.markComplete(2000);
    expect({ updates, completed: job.completed, ended: job.endedAtMs }).toEqual({
      updates: 1,
      completed: true,
      ended: 2000,
    });
  });

  it("await fulfills undefined when the job ends and does not reject", async () => {
    const job = new StoredJob();
    const pending = job.then((value) => value);
    job.markComplete(2000);
    await expect(pending).resolves.toBeUndefined();
    await expect(job).resolves.toBeUndefined();
    await expect(Promise.resolve(job).then(() => "again")).resolves.toBe("again");
  });

  it("a subclass fulfills its value and rejects its reason", async () => {
    const ok = new NamedJob();
    const pendingOk = ok.then((value: string) => value);
    ok.markComplete(2000);
    await expect(pendingOk).resolves.toBe("ok");
    await expect(ok).resolves.toBe("ok");

    const bad = new NamedJob();
    bad.fail = true;
    const pendingBad = bad.then((value: string) => value);
    bad.markComplete(2000);
    await expect(pendingBad).rejects.toBe("nope");
    await expect(bad.catch((error: string) => error)).resolves.toBe("nope");

    const parent = new StoredJob();
    parent.registerJob(ok);
    parent.registerJob(bad);
    expect(parent.children).toEqual([ok, bad]);
  });
});

@syncing("test:NamedJob")
class NamedJob extends ContractJob<string, string> {
  fail = false;

  @computed
  override get result(): JobResolution<string, string> | null {
    if (this.endedAtMs == null) return null;
    if (this.fail) return { status: "rejected", reason: "nope" };
    return { status: "fulfilled", value: "ok" };
  }
}
