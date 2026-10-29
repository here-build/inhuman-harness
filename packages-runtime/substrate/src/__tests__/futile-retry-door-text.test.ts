// futileRetryDoor text reports the FACT (same result, different arguments), frames the
// interpretation CONDITIONALLY, and prescribes NOTHING — never "give your best final answer",
// which is outcome fine-tuning, not teaching. ~60% of the door's real-world firings are WORKING
// tools truthfully returning empty (e.g. "No objects found"); asserting "the tool looks degraded
// or rate-limited" as fact and telling the model to abandon a recoverable search once vetoed the
// winning query outright and leaked a fabricated diagnosis into a user-facing answer.

import { describe, expect, it } from "vitest";

import { futileRetryDoor } from "../doors.js";

describe("futileRetryDoor — fact-only, conditionally-framed, no outcome prescription (C2/B2)", () => {
  const door = futileRetryDoor("srv_search");

  // A negative-only test cannot distinguish a correctly-reworded assertion from a deleted one —
  // an empty door would satisfy every `not.toContain` below. Absence of a lie is not the presence
  // of the truth: assert BOTH that the removed over-claims stay removed, AND that the conditional
  // framing that replaced them is actually present.
  it("says the RIGHT thing (conditional, fact-first) and not the wrong thing (diagnosis, outcome-prescription)", () => {
    const rendered = `${door.fact} ${door.reason} ${door.script}`.toLowerCase();

    // WHAT IT MUST NOT SAY — the two over-claims that were removed.
    // "the tool looks degraded" ASSERTED a diagnosis the medium cannot make: a tool returning the
    // same result may be perfectly healthy and simply have nothing to give.
    expect(rendered).not.toContain("the tool looks degraded");
    expect(rendered).not.toContain("the tool is degraded");
    // "give your best final answer" was OUTCOME FINE-TUNING — steering the model to stop working and
    // guess, which is not teaching, it is nudging toward a plausible-sounding surrender.
    expect(rendered).not.toContain("give your best final answer");

    // WHAT IT MUST SAY — the replacement, positively pinned. Deleting the door's text entirely (or
    // reverting to a bare refusal) now FAILS here rather than passing on an absence.
    expect(rendered).toContain("if"); // conditional, never a diagnosis stated as fact
    expect(rendered).toContain("degraded"); // the possibility is still named — it is a real one
    // ...and so is the OTHER possibility, which is the whole point of the rewording: an empty result
    // is very often the true answer, and the medium must not tell the model otherwise.
    expect(rendered).toMatch(/real|working/);
    // It must still hand back a usable next move rather than a verdict.
    expect(rendered).toMatch(/change the argument|different route|arguments/);
  });

  it("fact names only the observable: same result, different arguments — no diagnosis", () => {
    expect(door.fact).toContain("srv_search");
    expect(door.fact).toMatch(/same result/i);
    expect(door.fact).toMatch(/different argument/i);
  });

  it("reason frames BOTH possibilities conditionally — degraded-tool AND legitimate-empty-answer — prescribing neither", () => {
    expect(door.reason).toMatch(/if/i); // conditional framing, not an assertion
    const reason = door.reason.toLowerCase();
    expect(reason).toContain("degraded");
    expect(reason).toContain("real");
    expect(reason).toContain("working");
    expect(reason).toContain("what need to change");
  });

  it("script prescribes changing arguments or route — never abandoning the search", () => {
    expect(door.script.toLowerCase()).not.toContain("stop retrying");
    expect(door.script.toLowerCase()).not.toContain("best final answer");
    expect(door.script.toLowerCase()).toMatch(/change|different route/);
  });
});
