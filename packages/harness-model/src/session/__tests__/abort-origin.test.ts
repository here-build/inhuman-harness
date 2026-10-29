import { describe, expect, it } from "vitest";

import { cancelOutcomeText, isAbortError, isTimeoutAbortReason } from "../abort-origin.js";

describe("cancelOutcomeText", () => {
  it("keeps timeout origin and leaves other aborts as cancelled", () => {
    const generic = new DOMException("This operation was aborted", "AbortError");
    expect({
      none: cancelOutcomeText(),
      empty: cancelOutcomeText(undefined),
      abortError: cancelOutcomeText(new DOMException("Aborted", "AbortError")),
      generic: cancelOutcomeText(generic),
      string: cancelOutcomeText("nope"),
      park: cancelOutcomeText("park"),
      timeoutError: cancelOutcomeText(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      evalTimeout: cancelOutcomeText(new Error("evaluation timed out after 90ms")),
      prefixed: cancelOutcomeText(new Error("Error: evaluation timed out after 50ms")),
      budget: cancelOutcomeText(new Error("execution budget exceeded: timed out")),
      abortish: isAbortError(generic),
      abortNamed: isAbortError(new Error("This operation was aborted")),
      notAbort: isAbortError(new Error("cancelled")),
    }).toEqual({
      none: "cancelled",
      empty: "cancelled",
      abortError: "cancelled",
      generic: "cancelled",
      string: "cancelled",
      park: "cancelled",
      timeoutError: "timed out",
      evalTimeout: "evaluation timed out after 90ms",
      prefixed: "evaluation timed out after 50ms",
      budget: "execution budget exceeded: timed out",
      abortish: true,
      abortNamed: true,
      notAbort: false,
    });
    expect(isTimeoutAbortReason(new Error("evaluation timed out after 1ms"))).toBe(true);
    expect(isTimeoutAbortReason(new Error("cancelled"))).toBe(false);
  });

  it("a timeout is a reason that says it timed out, not one that mentions a timeout", () => {
    expect(
      [
        "evaluation timed out",
        "Error: evaluation timed out after 50ms",
        "classifier timed out after 1500ms",
        "execution budget exceeded: timed out",
        "user cancelled: Timeout setting changed",
        "raise the timeout and retry",
        "timed out waiting? no, cancelled",
      ].map((message) => isTimeoutAbortReason(new Error(message))),
    ).toEqual([true, true, true, true, false, false, false]);
  });
});
