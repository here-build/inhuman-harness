import { syncing } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { Job, walkWork, WorkContainer } from "../shared/index.js";
import { homeJobs, PewJudge, StoredJob } from "./_helpers/test-jobs.js";

@syncing("test:PlainWork")
class PlainWork extends WorkContainer {
  get work(): readonly WorkContainer[] {
    return [this];
  }
}

function contour(): Job {
  const job = new StoredJob();
  job.walkBoundary = true;
  return job;
}

describe("collectors", () => {
  it("jobs expands non-boundary children and stops at walkBoundary", () => {
    const parent = contour();
    const open = new StoredJob();
    const leaf = new StoredJob();
    open.children.push(leaf);
    const nested = contour();
    const hidden = new StoredJob();
    nested.children.push(hidden);
    parent.children.push(open, nested);

    expect(parent.jobs).toEqual([open, leaf, nested]);
    expect(nested.jobs).toEqual([hidden]);
  });

  it("a node's background classifies it; a boundary's inner flags stay inside", () => {
    const parent = contour();
    const nested = contour();
    nested.background = true;
    const innerFg = new StoredJob();
    const innerBg = new StoredJob();
    innerBg.background = true;
    nested.children.push(innerFg, innerBg);
    parent.children.push(nested);

    expect(parent.foregroundJobs).toEqual([]);
    expect(parent.backgroundJobs).toEqual([nested]);
    expect(nested.foregroundJobs).toEqual([innerFg]);
    expect(nested.backgroundJobs).toEqual([innerBg]);
  });

  it("collectors skip non-Job children; work and walkWork still yield them", () => {
    using home = homeJobs();
    const parent = contour();
    home.root.declared.push(parent);
    const job = new StoredJob();
    const judge = new PewJudge({ connectionId: "c1" });
    (job.children as Array<StoredJob | PewJudge>).push(judge);
    parent.children.push(job);

    expect(parent.jobs).toEqual([job]);
    expect([...walkWork(parent)]).toEqual([job, judge]);

    const plain = new PlainWork();
    (parent.children as Array<StoredJob | PlainWork>).push(plain);
    expect(parent.jobs).toEqual([job]);
    expect([...parent.work]).toEqual([job, plain]);
    expect([...walkWork(parent)]).toEqual([job, judge, plain]);
  });

  it("walkWork descends through a walkBoundary", () => {
    const parent = contour();
    const nested = contour();
    const inner = new StoredJob();
    nested.children.push(inner);
    parent.children.push(nested);
    expect(parent.jobs).toEqual([nested]);
    expect([...walkWork(parent)]).toEqual([nested, inner]);
  });
});
