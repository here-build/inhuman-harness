import { describe, expect, it } from "vitest";

import { resist, swipeRelease } from "../row-swipe.js";

const both = { leading: true, trailing: true };
const trailingOnly = { leading: false, trailing: true };
const width = 320;
const action = 84;

describe("swipeRelease", () => {
  it("closes a drag that never reached the button", () => {
    expect(swipeRelease(0, 0, width, action, both)).toBe("closed");
    expect(swipeRelease(-20, -0.2, width, action, both)).toBe("closed");
  });

  it("parks on the button once half of it is out, and runs it on a full swipe or a flick", () => {
    expect(swipeRelease(-50, 0, width, action, both)).toBe("open-trailing");
    expect(swipeRelease(-30, -0.5, width, action, both)).toBe("open-trailing");
    expect(swipeRelease(-200, 0, width, action, both)).toBe("commit-trailing");
    expect(swipeRelease(-100, -1.2, width, action, both)).toBe("commit-trailing");
    expect(swipeRelease(50, 0, width, action, both)).toBe("open-leading");
    expect(swipeRelease(200, 0, width, action, both)).toBe("commit-leading");
  });

  it("ignores a side that has no action", () => {
    expect(swipeRelease(200, 1, width, action, trailingOnly)).toBe("closed");
    expect(swipeRelease(-200, -1, width, action, { leading: true, trailing: false })).toBe("closed");
  });

  it("does not open a side the finger has not crossed into", () => {
    expect(swipeRelease(8, -0.8, width, action, both)).toBe("closed");
    expect(swipeRelease(-8, 0.8, width, action, both)).toBe("closed");
  });
});

describe("resist", () => {
  it("moves freely inside the range and slows past either end", () => {
    expect(resist(-40, -320, 0)).toBe(-40);
    expect(resist(-420, -320, 0)).toBeCloseTo(-342);
    expect(resist(40, -320, 0)).toBeCloseTo(8.8);
  });
});
