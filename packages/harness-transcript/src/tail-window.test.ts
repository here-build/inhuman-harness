import { describe, expect, it } from "vitest";

import { FIRST_WINDOW, growWindow, STEP } from "./tail-window.js";

describe("growWindow", () => {
  it("lists more rounds of the unfolded turns first", () => {
    expect(growWindow(FIRST_WINDOW, 100, 5)).toEqual({ turns: 1, rounds: FIRST_WINDOW.rounds + STEP });
  });
  it("unfolds the next older turn once every unfolded round is listed", () => {
    expect(growWindow({ turns: 1, rounds: 20 }, 12, 5)).toEqual({ turns: 2, rounds: 20 + STEP });
  });
  it("stops at the first turn", () => {
    expect(growWindow({ turns: 5, rounds: 50 }, 40, 5)).toBeNull();
  });
});
