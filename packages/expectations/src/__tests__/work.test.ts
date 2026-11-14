import { DocumentContainer } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import type { SessionDocument } from "../shared/index.js";
import { TestExpectation, TestSessionRoot } from "./_helpers/test-host.js";

describe("work graph", () => {
  it("WorkExpectation.work is [this]", () => {
    const expectation = new TestExpectation({ connectionId: "c1" });
    expect(expectation.work).toEqual([expectation]);
  });

  it("attachDocument attaches a SessionDocument and exposes it via document and awareness", () => {
    const root = new TestSessionRoot();
    const doc = new DocumentContainer(root) as SessionDocument;
    const expectation = new TestExpectation({ connectionId: "c1" });
    expect(expectation.document).toBeNull();
    expectation.attachDocument(doc);
    expect(expectation.document).toBe(doc);
    expect(expectation.awareness).toBe(doc.awareness);
    doc.destroy();
  });
});
