/**
 * The fold gate: every corpus program, run to completion, reads the same through
 * the batch analysis and the incremental fold, and its graph has the shape the
 * program means. A live test holds a call open and reads the running leaf.
 */
import { TraceRegionFold, traceToRegions, type Region, type RegionGraph } from "@here.build/arrival-provenance";
import { isWorkflowLeafMeta, type WorkflowLeafMeta } from "@inhuman.tools/harness-model/session";
import { describe, expect, it } from "vitest";

import { WORKFLOWS, WorkflowClock, runWorkflow, type WorkflowName } from "../__stories__/workflow-world.js";

type Leaf = Extract<Region, { kind: "leaf" }>;
type Fanout = Extract<Region, { kind: "fanout" }>;
type Decision = Extract<Region, { kind: "decision" }>;

/** Every region under these, depth first, containers before their iterations' contents. */
function flatten(regions: readonly Region[]): Region[] {
  return regions.flatMap((region) => [region, ...(region.kind === "fanout" ? region.iterations.flatMap(flatten) : [])]);
}

const leavesOf = (regions: readonly Region[]) => flatten(regions).filter((r): r is Leaf => r.kind === "leaf");
const named = (regions: readonly Region[], name: string) => leavesOf(regions).filter((l) => metaOf(l).name === name);
const metaOf = (leaf: Leaf) => leaf.meta as WorkflowLeafMeta;
const hasEdge = (graph: RegionGraph, from: Leaf, to: Leaf) =>
  graph.edges.some((e) => e.from === from.id && e.to === to.id);

async function settle(name: WorkflowName) {
  const { source, script } = WORKFLOWS[name];
  const run = runWorkflow(source, script());
  await run.done;
  return { ...run, graph: traceToRegions(run.trace) };
}

describe("corpus", () => {
  for (const name of Object.keys(WORKFLOWS) as WorkflowName[]) {
    describe(name, () => {
      it("reads the same through the batch analysis and the fold", async () => {
        const { trace, graph } = await settle(name);
        expect(TraceRegionFold.fromTrace(trace)).toEqual(graph);
      });

      it("carries leaf meta on every leaf", async () => {
        const { graph } = await settle(name);
        const leaves = leavesOf(graph.roots);
        expect(leaves.length).toBeGreaterThan(0);
        for (const leaf of leaves) expect(isWorkflowLeafMeta(leaf.meta)).toBe(true);
      });

      it("keeps a cell for every leaf, settled", async () => {
        const { graph, cells } = await settle(name);
        for (const leaf of leavesOf(graph.roots)) {
          expect(cells.get(leaf.id)?.state).toBe(leaf.state === "rejected" ? "failed" : "ok");
        }
      });
    });
  }

  it("fanout: three leaf-only iterations, and the reviewer feeds the implementer", async () => {
    const { graph } = await settle("fanout");
    const fan = graph.roots.find((r): r is Fanout => r.kind === "fanout")!;
    expect(fan.iterations).toHaveLength(3);
    for (const iteration of fan.iterations) {
      expect(iteration).toHaveLength(1);
      expect(iteration[0]!.kind).toBe("leaf");
    }
    const [reviewer] = named(graph.roots, "reviewer");
    const [implementer] = named(graph.roots, "implementer");
    expect(hasEdge(graph, reviewer!, implementer!)).toBe(true);
    for (const explore of named(graph.roots, "explore")) expect(hasEdge(graph, explore, reviewer!)).toBe(true);
  });

  it("loop: a loop fanout with an iteration per pass", async () => {
    const { graph } = await settle("loop");
    const fan = flatten(graph.roots).find((r): r is Fanout => r.kind === "fanout")!;
    expect(fan.loop).toBe(true);
    expect(fan.iterations.length).toBeGreaterThanOrEqual(2);
  });

  it("branch: a decision with its condition", async () => {
    const { graph } = await settle("branch");
    const decisions = flatten(graph.roots).filter((r): r is Decision => r.kind === "decision");
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) expect(decision.condition).toEqual(expect.any(String));
  });

  it("filter: the verdicts keep some and drop some, and each survivor's port is fed by what was read", async () => {
    const { graph } = await settle("filter");
    const decision = flatten(graph.roots).find((r): r is Decision => r.kind === "decision" && r.label === "filter")!;
    const reads = named(graph.roots, "read_file");
    expect(reads).toHaveLength(3);
    // The verdicts are about the files that were read, in order: the empty one is dropped.
    expect(decision.verdicts).toEqual(reads.map((read, at) => ({ kept: at < 2, origins: [read.id] })));
    const porters = named(graph.roots, "porter");
    expect(porters).toHaveLength(2);
    for (const [at, porter] of porters.entries()) expect(hasEdge(graph, reads[at]!, porter)).toBe(true);
  });

  it("nested: in each iteration the scout comes before the lead and feeds it", async () => {
    const { graph } = await settle("nested");
    const fan = graph.roots.find((r): r is Fanout => r.kind === "fanout")!;
    expect(fan.iterations).toHaveLength(3);
    for (const iteration of fan.iterations) {
      const [scout, lead] = iteration as Leaf[];
      expect(metaOf(scout!).name).toBe("scout");
      expect(metaOf(lead!).name).toBe("lead");
      expect(hasEdge(graph, scout!, lead!)).toBe(true);
    }
  });

  it("tools: the failed shell is a rejected leaf, and the program still returns a value", async () => {
    const { graph, done } = await settle("tools");
    const [shell] = named(graph.roots, "shell");
    expect(shell!.state).toBe("rejected");
    expect(shell!.error).toContain("exit 1");
    expect(graph.roots.some((r) => r.kind === "output")).toBe(true);
    expect(String(await done)).toContain("PR 412: build failed");
  });
});

describe("live", () => {
  it("a held reviewer is a running leaf with its meta and its incoming edges", async () => {
    const { source, script } = WORKFLOWS.fanout;
    const base = script();
    const clock = new WorkflowClock();
    const run = runWorkflow(
      source,
      (call) => (call.name === "reviewer" ? { ...base(call), hold: "review" } : base(call)),
      clock,
    );
    await clock.held("review");

    const fold = new TraceRegionFold(run.trace);
    expect(fold.applyDelta()).toBeGreaterThan(0);
    const graph = fold.current();
    const [reviewer] = named(graph.roots, "reviewer");
    expect(reviewer!.state).toBe("running");
    expect(metaOf(reviewer!)).toMatchObject({ kind: "agent", verb: "agent/ask", name: "reviewer" });
    for (const explore of named(graph.roots, "explore")) expect(hasEdge(graph, explore, reviewer!)).toBe(true);
    expect(run.cells.get(reviewer!.id)?.state).toBe("live");
    expect(named(graph.roots, "implementer")).toHaveLength(0);

    clock.release("review");
    await run.done;
    fold.applyDelta();
    const settled = fold.current();
    expect(named(settled.roots, "reviewer")[0]!.state).toBe("resolved");
    expect(named(settled.roots, "implementer")[0]!.state).toBe("resolved");
    expect(settled).toEqual(traceToRegions(run.trace));
  });

  it("a held tool is running while the leaves before it are resolved", async () => {
    const { source, script } = WORKFLOWS.tools;
    const base = script();
    const clock = new WorkflowClock();
    const run = runWorkflow(
      source,
      (call) => (call.verb === "lint_project" ? { ...base(call), hold: "lint" } : base(call)),
      clock,
    );
    await clock.held("lint");

    const fold = new TraceRegionFold(run.trace);
    fold.applyDelta();
    const { roots } = fold.current();
    expect(named(roots, "github__get_pull_request")[0]!.state).toBe("resolved");
    expect(named(roots, "lint_project")[0]!.state).toBe("running");
    expect(named(roots, "shell")).toHaveLength(0);

    clock.releaseAll();
    await run.done;
  });

  it("an asking step shows its cell asking until released", async () => {
    const clock = new WorkflowClock();
    const run = runWorkflow(
      `(agent/ask "lead" "which branch?")`,
      () => ({ hold: "answer", asking: "waiting on a human", value: "main" }),
      clock,
    );
    await clock.held("answer");
    expect([...run.cells.values()]).toEqual([{ state: "asking", status: "waiting on a human" }]);
    clock.release("answer");
    await run.done;
    expect([...run.cells.values()]).toEqual([{ state: "ok", value: "main" }]);
  });
});
