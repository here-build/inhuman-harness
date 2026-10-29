import { diffJson, type WorkflowFrame } from "@inhuman.tools/harness-model/session";
import { describe, expect, it } from "vitest";

import { type Feed, foldFrame } from "../workflow/feed.js";

const graph = (n: number) => ({
  roots: Array.from({ length: n }, (_, id) => ({ kind: "leaf", id })),
  edges: [],
  warnings: [],
});
const snapshot = (gen: number, seq: number, n: number, done = false): WorkflowFrame => ({
  kind: "snapshot",
  gen,
  seq,
  graph: graph(n),
  done,
});
const patch = (gen: number, seq: number, from: number, to: number, done = false): WorkflowFrame => ({
  kind: "patch",
  gen,
  seq,
  ops: diffJson(graph(from), graph(to)),
  done,
});
const feed = (frame: WorkflowFrame): Feed => {
  const next = foldFrame(null, frame);
  if (next === "resync") throw new Error("expected a feed");
  return next;
};

describe("foldFrame", () => {
  it("opens on a snapshot", () => {
    expect(foldFrame(null, snapshot(1, 1, 1))).toEqual({ gen: 1, seq: 1, graph: graph(1), done: false });
  });

  it("applies the next patch of the same run", () => {
    expect(foldFrame(feed(snapshot(1, 1, 1)), patch(1, 2, 1, 3))).toEqual({
      gen: 1,
      seq: 2,
      graph: graph(3),
      done: false,
    });
  });

  it("asks for a resync on a gap, a stale run, or a patch with nothing to apply to", () => {
    const open = feed(snapshot(2, 4, 1));
    expect(foldFrame(open, patch(2, 6, 1, 2))).toBe("resync");
    expect(foldFrame(open, patch(2, 4, 1, 2))).toBe("resync");
    expect(foldFrame(open, patch(1, 5, 1, 2))).toBe("resync");
    expect(foldFrame(null, patch(2, 5, 1, 2))).toBe("resync");
  });

  it("asks for a resync when a patch does not fit the graph", () => {
    const bad: WorkflowFrame = {
      kind: "patch",
      gen: 1,
      seq: 2,
      ops: [{ op: "replace", path: "/x/y", value: 1 }],
      done: false,
    };
    expect(foldFrame(feed(snapshot(1, 1, 1)), bad)).toBe("resync");
  });

  it("takes a new run's snapshot over the old one", () => {
    expect(foldFrame(feed(snapshot(1, 5, 3)), snapshot(2, 1, 1))).toEqual({
      gen: 2,
      seq: 1,
      graph: graph(1),
      done: false,
    });
  });

  it("carries done from the frame that says it", () => {
    const open = feed(snapshot(1, 1, 1));
    expect(foldFrame(open, patch(1, 2, 1, 1, true))).toMatchObject({ seq: 2, graph: graph(1), done: true });
    expect(foldFrame(null, snapshot(1, 9, 2, true))).toMatchObject({ done: true });
  });
});
