import { expect, test } from "vitest";

import { parseToolOutcome } from "../tool-outcome.js";

test("parses failure codes and drops fields outside the outcome schema", () => {
  expect(
    parseToolOutcome(
      JSON.stringify({ ok: false, text: "needs a person", code: "interaction_required", note: "ignored" }),
    ),
  ).toEqual({ ok: false, text: "needs a person", code: "interaction_required" });
});
