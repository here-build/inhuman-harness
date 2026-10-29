import { describe, expect, it } from "vitest";

import { PewTestHost, TestExpectation } from "./_helpers/test-host.js";

describe("entity done writes", () => {
  it("construction requires a non-empty connectionId", () => {
    expect(() => new TestExpectation({ connectionId: "" })).toThrow(/connectionId is required/);
  });

  it("succeed is first-writer-wins: a later fail is a no-op, never a throw", () => {
    const host = new PewTestHost();
    const expectation = host.mint();
    expect(expectation.succeed("settled", "", "null", { result: { value: "a" } })).toBe(true);
    expect(expectation.fail("cancel", "late", "null")).toBe(false);
    expect(expectation.outcome).toBe("successful");
    expect(expectation.resultValue).toBe("a");
    host[Symbol.dispose]();
  });

  it("fail with endCause cancel is failed — not a fourth state", () => {
    const host = new PewTestHost();
    const expectation = host.mint();
    expect(expectation.fail("cancel", "terminate", "null")).toBe(true);
    expect(expectation.outcome).toBe("failed");
    expect(expectation.endCause).toBe("cancel");
    expect({ started: expectation.startedAtMs, ended: expectation.endedAtMs != null, duration: expectation.durationMs() }).toEqual({
      started: null,
      ended: true,
      duration: null,
    });
    host[Symbol.dispose]();
  });

  it("clocks are write-once; duration is derived", () => {
    const host = new PewTestHost();
    const expectation = host.mint();
    expectation.markStarted(1000);
    expectation.markStarted(9000);
    expectation.markEnded(1500);
    expectation.markEnded(9000);
    expect({ started: expectation.startedAtMs, ended: expectation.endedAtMs, duration: expectation.durationMs() }).toEqual({
      started: 1000,
      ended: 1500,
      duration: 500,
    });
    host[Symbol.dispose]();
  });

  it("applySettlement runs for void-shaped results (settlement is a wrapper, not a bare value)", () => {
    const host = new PewTestHost();
    let applied = 0;
    class VoidExpectation extends TestExpectation {
      override applySettlement(): void {
        applied += 1;
      }
    }
    const id = host.register("test", null);
    const expectation = host.mint(new VoidExpectation({ connectionId: id }));
    expect(expectation.succeed("settled", "", "null", { result: undefined as never })).toBe(true);
    expect(applied).toBe(1);
    host[Symbol.dispose]();
  });

  it("await fulfills with the outcome; failure is not a rejection", async () => {
    const host = new PewTestHost();
    const ok = host.mint();
    const bad = host.mint();
    const pendingOk = ok.then((outcome) => outcome);
    const pendingBad = bad.then((outcome) => outcome);
    ok.succeed("settled", "", "null");
    bad.fail("crash", "boom", "null");
    await expect(pendingOk).resolves.toBe("successful");
    await expect(pendingBad).resolves.toBe("failed");
    host[Symbol.dispose]();
  });
});
