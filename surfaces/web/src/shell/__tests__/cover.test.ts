import { describe, expect, it } from "vitest";

import { armCover, confirmCover, seatForAsk, throttleMs } from "../cover.js";

describe("cover", () => {
  it("Enter on a throttled cover does not write", () => {
    const seat = seatForAsk({ phase: "draft", leafId: null }, "leaf-1", false, throttleMs(2000));
    expect(seat.phase).toBe("cover_throttled");
    expect(confirmCover(seat, "leaf-1")).toBe(false);
  });

  it("armed Enter writes only the captured leaf", () => {
    const armed = armCover(seatForAsk({ phase: "draft", leafId: null }, "leaf-1", false, 1000));
    expect(confirmCover(armed, "leaf-1")).toBe(true);
    expect(confirmCover(armed, "leaf-2")).toBe(false);
  });

  it("an empty draft arms immediately, and a zero kernel throttle skips the wait", () => {
    expect(seatForAsk({ phase: "draft", leafId: null }, "leaf", true, 1000).phase).toBe("cover_armed");
    expect(seatForAsk({ phase: "draft", leafId: null }, "leaf", false, throttleMs(0)).phase).toBe("cover_armed");
  });

  it("the same leaf does not re-arm", () => {
    const throttled = seatForAsk({ phase: "draft", leafId: null }, "leaf", false, 1000);
    expect(seatForAsk(throttled, "leaf", true, 1000)).toBe(throttled);
  });
});
