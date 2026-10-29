import { describe, expect, it } from "vitest";

import { clampFinishIn, repairFinish } from "../finish.js";

describe("repairFinish", () => {
  it("preserves aborted even when toolsFound", () => {
    expect(repairFinish("repair", "aborted", true)).toBe("aborted");
    expect(repairFinish("repair", "cancelled", true)).toBe("aborted");
    expect(repairFinish("repair", "abort", true)).toBe("aborted");
  });

  it("preserves length / error / content_filter with tools", () => {
    expect(repairFinish("repair", "length", true)).toBe("length");
    expect(repairFinish("repair", "error", true)).toBe("error");
    expect(repairFinish("repair", "content_filter", true)).toBe("content_filter");
  });

  it("still promotes stop → tool_calls when tools found", () => {
    expect(repairFinish("repair", "stop", true)).toBe("tool_calls");
    expect(repairFinish("repair", null, true)).toBe("tool_calls");
  });
});

describe("clampFinishIn", () => {
  it("maps cancelled/abort → aborted", () => {
    expect(clampFinishIn("cancelled")).toBe("aborted");
    expect(clampFinishIn("abort")).toBe("aborted");
    expect(clampFinishIn("aborted")).toBe("aborted");
  });
});
