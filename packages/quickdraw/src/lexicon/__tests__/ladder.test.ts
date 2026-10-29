import { expect, test } from "vitest";

import { FgP, fgProgress } from "../prominence.js";

test("FgP ladder strictly increasing; fgProgress continuous between brands", () => {
  const ladder = [FgP.whisper, FgP.ghost, FgP.rising, FgP.secondary, FgP.primary];
  expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
  expect(new Set(ladder).size).toBe(ladder.length);
  expect({
    t0: fgProgress(FgP.ghost, FgP.secondary, 0),
    t1: fgProgress(FgP.ghost, FgP.secondary, 1),
  }).toEqual({
    t0: FgP.ghost,
    t1: FgP.secondary,
  });
  expect(fgProgress(FgP.ghost, FgP.secondary, 0.5)).toBeCloseTo((FgP.ghost + FgP.secondary) / 2, 5);
});
