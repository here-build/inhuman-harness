/**
 * An unfinished hold is a lost bet — it becomes TEXT, never an executable
 * tool call. Covers the two abort paths that end a hold without a close
 * marker: maxBufferChars overflow and EOS-while-holding. Also covers a
 * false-positive hold (looked like an open marker, never became one).
 *
 * Law: every non-ground state has a defined abort fate.
 * Aborting a capture commits the held span to text output. It must never
 * commit to an executable tool call. A tool_call_end may still appear at the
 * EOS assemble for a span independently recovered from the (now-text) buffer,
 * but only ever with partial:true and blanked arguments — never executable.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { runStream, expectSequence, drop, finish } from "./stream-harness.js";

/** No tool_call_end without partial:true — i.e. nothing executable escaped. */
function assertNoExecutableToolCalls(events: Array<{ type: string }>): void {
  for (const e of events) {
    if (e.type === "tool_call_end") {
      expect(
        (e as { partial?: boolean }).partial,
        `non-partial (executable) tool_call_end leaked: ${JSON.stringify(e)}`,
      ).toBe(true);
      // Stream events are typed as {type} only; abort-hold still carries arguments on the wire.
      // @ts-expect-error arguments is not on the event type
      expect(e.arguments).toBe("{}");
    }
  }
}

describe("abort-a-hold: never executable", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("overflow mid-hold: even a well-formed, fully-closed span never becomes an executable call", async () => {
    // Single chunk, genuinely closed <tool_call>...</tool_call> — but the
    // whole span exceeds maxBufferChars before the overflow check ever sees
    // the close marker already sitting inside `hold`. Must NOT become an
    // executable tool call at EOS (recoveryText must not re-carry this span
    // for the assemble to re-discover a "closed" match from).
    const bigArg = "A".repeat(200);
    const markup = `<tool_call>\n{"name":"leak","arguments":{"secret":"${bigArg}"}}\n</tool_call>\nDone.`;
    const events = await runStream([markup], {
      dialect: "hermes",
      maxBufferChars: 40,
    });
    assertNoExecutableToolCalls(events);
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    // The whole markup — open marker, args, close marker — is painted as text.
    expect(allText).toContain("<tool_call>");
    expect(allText).toContain("</tool_call>");
    expect(allText).toContain("Done");
    expectSequence(events, [{ type: "error", messageIncludes: "maxBufferChars" }, finish("stop")]);
  });

  it("overflow mid-hold with a live-started call: start is dropped with reason aborted, never reaches end", async () => {
    // First chunk is enough for step() to name-certain-start "write_file"
    // (under maxBufferChars); the second chunk is what pushes the hold over
    // the limit while still open.
    const opening = `<tool_call>\n{"name":"write_file","arguments":{"path":"a","content":"`;
    const bigArg = "B".repeat(500);
    const events = await runStream([opening, bigArg], {
      dialect: "hermes",
      maxBufferChars: 100,
    });
    assertNoExecutableToolCalls(events);
    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts.length).toBeGreaterThan(0);
    expectSequence(events, [drop("aborted", { name: "write_file" })]);
  });

  it("EOS mid-hold, name-certain: a call recovered from a genuinely truncated (never-closed) span is dropped, never painted as text", async () => {
    // JSON body is complete, but </tool_call> never arrives — dialect-level
    // truncation, independent of the abort paths above. step() already
    // parsed the name ("get_weather") live, so this span reached
    // name-certainty (the FST's "inside" state) before EOS — under the
    // name-certainty law it is machinery, bound to call-or-drop, and MUST
    // NEVER also be painted as prose (that would double-account the same
    // characters as both dropped and text — the exact violation C1's span
    // ledger forbids; see conservation.test.ts's "[truncated-at-eos]" case,
    // which asserts the same scenario as dropped-only, zero overlap).
    const events = await runStream(['Look:\n<tool_call>\n{"name":"get_weather","arguments":{"city":"SF"}}'], {
      dialect: "hermes",
    });
    assertNoExecutableToolCalls(events);
    // The live-started attempt is dropped (never reaches end)...
    expectSequence(events, [drop("truncated", { name: "get_weather" })]);
    // ...and if the assemble independently recovers the same call, it must
    // surface as partial, not as a second live/executable end.
    for (const e of events) {
      if (e.type === "tool_call_end") {
        expect(e.partial).toBe(true);
      }
    }
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(allText).toContain("Look");
    // Never painted: the name-certain span is dropped machinery, not prose.
    expect(allText).not.toContain("<tool_call>");
    expect(allText).not.toContain("get_weather");
  });

  it("EOS mid-hold, never name-certain: an incomplete marker prefix aborts to text, never a drop", async () => {
    // "<tool_ca" is a proper prefix of "<tool_call>" that never completes
    // before EOS — the FST is still in maybe_open (bounded speculative
    // lookahead, T4), and never reached "inside"/name-certainty (no name
    // was ever parsed, no tool_call_start ever emitted). Law: a lost bet on
    // an incomplete marker resolves to TEXT, never a drop — exactly the
    // HTML5 tokenizer's rule for '<' followed by a non-continuing sequence:
    // emit '<' (and everything held with it) as character tokens and
    // reconsume. This is the "abort commits to text" behaviour the
    // name-certain case above used to (wrongly) protect; it belongs here.
    const events = await runStream(["Note: <tool_ca"], { dialect: "hermes" });
    assertNoExecutableToolCalls(events);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_call_drop")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(allText).toBe("Note: <tool_ca");
  });

  it("EOS mid-hold with unparseable truncated body: dropped, no tool call at all", async () => {
    const events = await runStream(['Sure.\n<tool_call>\n{"name":"get_weather","arguments":{"city":"SF"'], {
      dialect: "hermes",
    });
    assertNoExecutableToolCalls(events);
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    expectSequence(events, [drop("truncated", { name: "get_weather" })]);
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(allText).toContain("Sure");
  });

  it("false-positive hold: text that looked like an open marker but never completed becomes plain text", async () => {
    // "<tool_c" is a proper prefix of "<tool_call>" — held speculatively —
    // but the stream ends without ever completing the marker.
    const events = await runStream(["Here is some math: 2 < tool_calc(x)"], {
      dialect: "hermes",
    });
    assertNoExecutableToolCalls(events);
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(0);
    expect(events.filter((e) => e.type === "tool_call_drop")).toHaveLength(0);
    const allText = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(allText).toContain("2 < tool_calc(x)");
  });
});
