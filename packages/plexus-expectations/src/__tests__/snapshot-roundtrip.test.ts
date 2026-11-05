import { DocumentContainer, model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import {
  Job,
  type JobEffectOwner,
  type JobResolution,
  type UnknownOutcomeRecovery,
  WorkContainer,
  WorkExpectation,
} from "../shared/index.js";

@model("test:SnapshotJob")
class SnapshotJob extends Job<string, string> {
  override readonly owner: JobEffectOwner = "session-runtime";
  override readonly intent = "";
  override readonly checkpoint = "";
  override readonly dispatch = "";
  override readonly settlement = "";
  override readonly cancel = "";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-queued";
  override readonly unknownNote = "";
  override readonly intentRequired = false;

  @state accessor customPayload: string = "";

  override get result(): JobResolution<string, string> | null {
    if (this.endedAtMs == null) return null;
    return { status: "fulfilled", value: this.customPayload };
  }
}

@model("test:SnapshotExpectation")
class SnapshotExpectation extends WorkExpectation<{ value: string }, { note: string }> {
  @state accessor memo: string = "";

  override applySettlement(result: { value: string }): void {
    this.memo = result.value;
  }
}

@model("test:SnapshotRoot")
class SnapshotRoot extends WorkContainer {
  @state.childList accessor jobs: Job[] = [];
  @state.childList accessor expectations: WorkExpectation[] = [];

  get work(): readonly WorkContainer[] {
    return [...this.jobs, ...this.expectations];
  }
}

describe("DocumentContainer snapshot & hydration round-trip", () => {
  it("serializes complex Job and WorkExpectation graph and hydrates sibling refs and settlements identically", async () => {
    const root = new SnapshotRoot();
    const container = new DocumentContainer(root);

    const jobA = new SnapshotJob();
    jobA.customPayload = "payload-A";

    const jobB = new SnapshotJob();
    jobB.customPayload = "payload-B";
    jobB.stampAfter([jobA]);

    const jobC = new SnapshotJob();
    jobC.customPayload = "payload-C";

    const jobD = new SnapshotJob();
    jobD.customPayload = "payload-D";
    jobD.stampAfter([jobB]);

    jobC.registerJob(jobD);

    const exp1 = new SnapshotExpectation({ connectionId: "conn-1" });

    root.jobs.push(jobA, jobB, jobC);
    root.expectations.push(exp1);

    jobA.markStarted(1000);
    jobA.markComplete(1500);

    exp1.markStarted(1100);
    exp1.succeed("settled", "ok", JSON.stringify({ note: "report-1" }), { result: { value: "settled-val" } });

    expect(jobB.afterReleased).toBe(true);
    expect(jobD.afterReleased).toBe(false);
    expect(exp1.isDone).toBe(true);

    const snapshot = container.toSnapshot();
    const serializedJson = JSON.stringify(snapshot);
    const parsedSnapshot = JSON.parse(serializedJson);

    const hydratedContainer = DocumentContainer.fromSnapshot<SnapshotRoot>(parsedSnapshot);
    const hydratedRoot = hydratedContainer.root;

    expect(hydratedRoot).toBeInstanceOf(SnapshotRoot);
    expect(hydratedRoot.jobs).toHaveLength(3);
    expect(hydratedRoot.expectations).toHaveLength(1);

    const [hA, hB, hC] = hydratedRoot.jobs as [SnapshotJob, SnapshotJob, SnapshotJob];
    const [hExp1] = hydratedRoot.expectations as [SnapshotExpectation];

    expect(hA.uuid).toBe(jobA.uuid);
    expect(hB.uuid).toBe(jobB.uuid);
    expect(hC.uuid).toBe(jobC.uuid);
    expect(hExp1.uuid).toBe(exp1.uuid);

    expect(hA.completed).toBe(true);
    expect(hA.startedAtMs).toBe(1000);
    expect(hA.endedAtMs).toBe(1500);
    expect(hA.durationMs()).toBe(500);
    expect(hA.customPayload).toBe("payload-A");

    expect(hB.after).toHaveLength(1);
    expect(hB.after[0]).toBe(hA);
    expect(hB.afterReleased).toBe(true);

    expect(hC.children).toHaveLength(1);
    const hD = hC.children[0] as SnapshotJob;
    expect(hD.uuid).toBe(jobD.uuid);
    expect(hD.customPayload).toBe("payload-D");
    expect(hD.parent).toBe(hC);
    expect(hD.after).toHaveLength(1);
    expect(hD.after[0]).toBe(hB);
    expect(hD.afterReleased).toBe(false);

    expect(hExp1.outcome).toBe("successful");
    expect(hExp1.endCause).toBe("settled");
    expect(hExp1.endDetail).toBe("ok");
    expect(hExp1.memo).toBe("settled-val");
    expect(hExp1.report).toEqual({ note: "report-1" });
    expect(hExp1.isDone).toBe(true);

    await expect(hA).resolves.toBe("payload-A");
    await expect(hExp1).resolves.toBe("successful");

    hB.markComplete(2000);
    expect(hD.afterReleased).toBe(true);
  });
});
