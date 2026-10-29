import { describe, expect, it } from "vitest";

import { TestExpectation } from "./_helpers/test-host.js";

describe("work graph", () => {
  it("WorkExpectation.work is [this]", () => {
    const expectation = new TestExpectation({ connectionId: "c1" });
    expect(expectation.work).toEqual([expectation]);
  });
});
