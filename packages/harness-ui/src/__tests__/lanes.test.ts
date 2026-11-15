import { describe, expect, it } from "vitest";

import { solveLaneSlots, type LaneSlotInput, type LaneSlotOutput } from "../positioning/lanes.js";

describe("solveLaneSlots", () => {
  it.each<{
    name: string;
    inputs: readonly LaneSlotInput[];
    gap?: number;
    expected: readonly LaneSlotOutput[];
  }>([
    {
      name: "aligns separated notes to their beat rows and stretches down to spanBottom",
      inputs: [
        { id: "n1", startTop: 20, naturalHeight: 60, spanBottom: 220 },
        { id: "n2", startTop: 260, naturalHeight: 50, spanBottom: 420 },
      ],
      expected: [
        { id: "n1", top: 20, height: 200 },
        { id: "n2", top: 260, height: 160 },
      ],
    },
    {
      name: "pushes colliding notes below previous notes plus gap",
      inputs: [
        { id: "n1", startTop: 0, naturalHeight: 140, spanBottom: 100 },
        { id: "n2", startTop: 90, naturalHeight: 80, spanBottom: 300 },
      ],
      gap: 16,
      expected: [
        { id: "n1", top: 0, height: 140 },
        { id: "n2", top: 156, height: 144 },
      ],
    },
    {
      name: "preserves model span feet down to the last beat bottom",
      inputs: [{ id: "model", startTop: 40, naturalHeight: 48, spanBottom: 520 }],
      expected: [{ id: "model", top: 40, height: 480 }],
    },
  ])("$name", ({ inputs, gap, expected }) => {
    expect(solveLaneSlots(inputs, gap)).toEqual(expected);
  });
});
