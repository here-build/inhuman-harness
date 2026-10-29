import { expect, test } from "vitest";

import { createBirthFrontier, stepBirthFrontier, wavefrontProminence } from "../birth.js";

test("short newest line chases T immediately", () => {
  const t0 = 1_000;
  let state = stepBirthFrontier(createBirthFrontier(), { T: 4, nowMs: t0 });
  expect(state.W).toBe(0);
  state = stepBirthFrontier(state, { T: 4, nowMs: t0 + 200 });
  expect(state.W).toBeGreaterThan(0);
  expect(state.W).toBeLessThanOrEqual(4);
});

test("wavefront far past W dissolves to zero", () => {
  expect(wavefrontProminence(40, 0, 8, 0.72)).toBeLessThan(1 / 255);
});

test("a wrap that shrinks T restarts W from the left", () => {
  const t0 = 1_000;
  let state = stepBirthFrontier(createBirthFrontier(), { T: 80, nowMs: t0 });
  expect(state.W).toBeGreaterThan(50);
  state = stepBirthFrontier(state, { T: 6, nowMs: t0 + 16 });
  expect(state.W).toBeLessThan(6);
});

test("frozen T coasts the tip-window lag at carried impulse", () => {
  const t0 = 1_000;
  let state = stepBirthFrontier(createBirthFrontier(), { T: 80, nowMs: t0 });
  const parked = state.W;
  state = stepBirthFrontier(state, { T: 80, nowMs: t0 + 100 });
  const d1 = state.W - parked;
  state = stepBirthFrontier(state, { T: 80, nowMs: t0 + 200 });
  const d2 = state.W - (parked + d1);
  state = stepBirthFrontier(state, { T: 80, nowMs: t0 + 400 });
  expect({
    parked,
    equalSteps: Math.abs(d1 - d2) < 0.01,
    finished: state.W,
  }).toEqual({
    parked: 68,
    equalSteps: true,
    finished: 80,
  });
});
