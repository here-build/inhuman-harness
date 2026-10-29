// The FUTILITY DOOR's pure shape-logic (futility.ts + doors.ts futile/duplicate generators).
// The full MCP-wiring half (a real upstream + a real manifold server observing the advisory
// Note: blocks) lives in arrival-manifold (server.ts/manifold-tool.ts are binder-owned); this
// half tests `FutilityTracker` and `normalizeResultText` directly, with no MCP transport at all.

import { describe, expect, it } from "vitest";

import { FutilityTracker, normalizeResultText } from "../futility.js";

describe("normalizeResultText", () => {
  // C1 — digits are signal, not noise: `DIGIT_RUN` (a normalizer that once stripped every
  // digit run) collapsed `get_file_info`'s labels+digits body for three genuinely different
  // files (sizes 40435 / 810402 / 10266) into the SAME shape key, firing the futility door on
  // legitimately distinct results — and across a 178-trajectory audit it never caught a single
  // TRUE positive (every real positive was byte-identical prose with NO digits at all: ddg
  // bot-detection, "No objects found", empty memory). UUID / HEX_RUN / WHITESPACE stay — those
  // really are volatile per-request tokens, never the payload itself.
  it("digits are SIGNAL, not noise — three results differing only in digits stay distinct (C1)", () => {
    const a = normalizeResultText("name: report.pdf size: 40435 modified: 20260101");
    const b = normalizeResultText("name: report.pdf size: 810402 modified: 20260101");
    const c = normalizeResultText("name: report.pdf size: 10266 modified: 20260101");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("washes out UUIDs and long hex runs", () => {
    expect(normalizeResultText("request 550e8400-e29b-41d4-a716-446655440000 failed")).toBe(
      normalizeResultText("request 6ba7b810-9dad-11d1-80b4-00c04fd430c8 failed"),
    );
    expect(normalizeResultText("trace deadbeefcafebabefeed done")).toBe(normalizeResultText("trace done"));
  });

  it("keeps genuinely different prose distinct", () => {
    expect(normalizeResultText("no results found")).not.toBe(normalizeResultText("here are your results"));
  });
});

// Every test below calls `t.beginCall()` before each `record()` UNLESS a test's whole point is
// batching within one call (C1b) — `beginCall()` marks a new `run()`/program boundary (runner.ts
// calls it once per call, mirroring `attachmentSink.beginCall`), and a genuine ADAPTIVE retry
// (the model saw a bad result, then wrote a fresh call with different args) always crosses that
// boundary. Direct `record()`-without-`beginCall()` sequences below simulate that same-call
// batching deliberately, never accidentally.
describe("FutilityTracker (pure)", () => {
  it("queues one futile-retry door on the 3rd identical result across distinct args, ACROSS separate calls", () => {
    const t = new FutilityTracker();
    t.beginCall();
    t.record("srv_search", { q: "a" }, "no results");
    t.beginCall();
    t.record("srv_search", { q: "b" }, "no results");
    expect(t.drainPending()).toHaveLength(0);
    t.beginCall();
    t.record("srv_search", { q: "c" }, "no results");
    const drained = t.drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.door.code).toBe("envelope/futile-retry");
    expect(drained[0]!.tool).toBe("srv_search");
  });

  it("queues a duplicate-call door on identical (args,result) repeat ACROSS calls, and does not re-fire", () => {
    const t = new FutilityTracker();
    t.beginCall();
    t.record("srv_x", { q: "a" }, "body");
    t.beginCall();
    t.record("srv_x", { q: "a" }, "body");
    const first = t.drainPending();
    expect(first).toHaveLength(1);
    expect(first[0]!.door.code).toBe("envelope/duplicate-call");
    t.beginCall();
    t.record("srv_x", { q: "a" }, "body"); // still identical — no re-fire
    expect(t.drainPending()).toHaveLength(0);
  });

  it("re-fire gate RESETS once the result hash changes, allowing a later fresh fire", () => {
    const t = new FutilityTracker();
    t.beginCall();
    t.record("srv_x", { q: "a" }, "body");
    t.beginCall();
    t.record("srv_x", { q: "a" }, "body");
    t.drainPending(); // duplicate fired once
    t.beginCall();
    t.record("srv_x", { q: "a" }, "DIFFERENT"); // result changed — clears the gate
    t.beginCall();
    t.record("srv_x", { q: "a" }, "DIFFERENT"); // identical again → fires afresh
    const drained = t.drainPending();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.door.code).toBe("envelope/duplicate-call");
  });

  // C1b — statements within ONE program (one `run()` call, several statements the model wrote
  // WITHOUT having seen any of their results yet) must never count as retries against each
  // other: the door's whole premise is an INFORMED retry (model saw a bad result, then tried
  // again anyway). As a direct consequence, the door must never fire beneath a same-call batch
  // that also contains a real success — firing there would contradict the door's own
  // "the tool looks degraded" claim.
  it("(a) three identical results from ONE program's statements (no beginCall between them) fire NOTHING", () => {
    const t = new FutilityTracker();
    t.beginCall();
    // A single call issuing 3 sub-calls with different args, all returning the same (legitimately
    // empty) result — e.g. `(map (lambda (id) (tool :id id)) missing-ids)`. The model never saw
    // any of these results before writing the others; this is not a retry sequence.
    t.record("srv_search", { q: "a" }, "no results");
    t.record("srv_search", { q: "b" }, "no results");
    t.record("srv_search", { q: "c" }, "no results");
    expect(t.drainPending()).toHaveLength(0);
  });

  it("(b) a same-call batch that also contains a real success queues no door beneath it", () => {
    const t = new FutilityTracker();
    t.beginCall();
    t.record("srv_search", { q: "a" }, "no results");
    t.record("srv_search", { q: "b" }, "no results");
    t.record("srv_search", { q: "c" }, "no results"); // would have fired trigger 1 pre-C1b
    t.record("srv_search", { q: "d" }, "here are 3 real matches"); // a genuine success, same call
    expect(t.drainPending()).toHaveLength(0);
  });

  it("the SAME shape of retry still fires once it genuinely spans separate calls (the trigger is surgically narrowed, not disabled)", () => {
    const t = new FutilityTracker();
    t.beginCall();
    t.record("srv_search", { q: "a" }, "no results");
    t.beginCall();
    t.record("srv_search", { q: "b" }, "no results");
    t.beginCall();
    t.record("srv_search", { q: "c" }, "no results");
    expect(t.drainPending()).toHaveLength(1);
  });
});
