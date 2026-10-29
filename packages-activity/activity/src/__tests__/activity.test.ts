import { describe, expect, it } from "vitest";

import {
  clampChars,
  CONTEXT_NEED_DESCRIPTION,
  CONTEXT_NEED_INPUT_SCHEMA,
  CONTEXT_NEED_TOOL_NAME,
  isTitledOnlyCompletion,
  METADATA_SAME_ROUND_TEXT,
  normalizeContextNeed,
  normalizeMetadata,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  spokenResponseText,
  UPDATE_METADATA_DESCRIPTION,
  UPDATE_METADATA_INPUT_SCHEMA,
} from "../index.js";

const NO_FOLLOWUP = new Set(["context_need"]);

describe("spokenResponseText", () => {
  it.each([
    ["  hello ", "hello"],
    ["<think>plan</think>", ""],
    ["<thinking>a\nb</thinking> done", "done"],
    ["<reasoning x='1'>a</reasoning>\n", ""],
    ["<think>a</thinking> kept", "<think>a</thinking> kept"],
  ])("%j -> %j", (input, want) => {
    expect(spokenResponseText(input)).toBe(want);
  });
});

describe("clampChars / normalizeMetadata", () => {
  it("clamps by code point", () => {
    expect(clampChars("👍👎✨", 2)).toBe("👍👎");
    expect(clampChars("abc", 5)).toBe("abc");
  });

  it("trims and clamps to the limits; description defaults to empty", () => {
    const got = normalizeMetadata({
      current_turn_title: ` ${"t".repeat(SESSION_TITLE_MAX_CHARS + 9)} `,
      current_turn_description: "d".repeat(SESSION_DESCRIPTION_MAX_CHARS + 9),
    });
    expect(got.title).toHaveLength(SESSION_TITLE_MAX_CHARS);
    expect(got.description).toHaveLength(SESSION_DESCRIPTION_MAX_CHARS);
    expect(normalizeMetadata({ current_turn_title: "x" }).description).toBe("");
  });
});

describe("isTitledOnlyCompletion", () => {
  it.each([
    ["empty prose plus only update_metadata", ["update_metadata"], "", true],
    ["prose plus metadata is not titled-only", ["update_metadata"], "done", false],
    ["thinking only counts as no prose", ["update_metadata"], "<think>x</think>", true],
    ["empty prose plus only task remainder verbs", ["task__create", "task__start"], "", true],
    ["context_need alone is not a titled-only follow-up", ["context_need"], "", false],
    ["context_need beside metadata still follows up", ["context_need", "update_metadata"], "", true],
    ["a real tool in the same round is not titled-only", ["update_metadata", "read_file"], "", false],
    ["no calls", [], "", false],
  ] as const)("%s", (_name, names, prose, want) => {
    expect(
      isTitledOnlyCompletion(
        { responseText: prose, responseCalls: names.map((name) => ({ name, isSideChannel: name !== "read_file" })) },
        NO_FOLLOWUP,
      ),
    ).toBe(want);
  });

  it("by default context_need alone asks for no round; an explicit empty set restores it", () => {
    const chunk = { responseText: "", responseCalls: [{ name: "context_need", isSideChannel: true }] };
    expect(isTitledOnlyCompletion(chunk)).toBe(false);
    expect(isTitledOnlyCompletion(chunk, new Set())).toBe(true);
    expect(
      isTitledOnlyCompletion({ responseText: "", responseCalls: [{ name: "other_meta", isSideChannel: true }] }),
    ).toBe(true);
  });
});

describe("tool text", () => {
  it("description carries the note", () => {
    expect(UPDATE_METADATA_DESCRIPTION).toBe(
      `Record this turn's title and a short description. ${METADATA_SAME_ROUND_TEXT} Do not address the user.`,
    );
  });

  it("schema requires the title only", () => {
    expect(UPDATE_METADATA_INPUT_SCHEMA.required).toEqual(["current_turn_title"]);
    expect(Object.keys(UPDATE_METADATA_INPUT_SCHEMA.properties)).toEqual([
      "current_turn_title",
      "current_turn_description",
    ]);
  });
});

describe("context_need", () => {
  it("pins the name and the description byte for byte", () => {
    expect(CONTEXT_NEED_TOOL_NAME).toBe("context_need");
    expect(CONTEXT_NEED_DESCRIPTION).toBe(
      "Declare what the next stretch of work needs from working context. min_remaining_tokens is a conservative request for free tokens, not an estimate of how much context remains. preserve and focus name what should survive if the runtime reshapes older context. Set current_phase_settled when the current reasoning phase has reached a clean boundary. One-way control signal: do not wait for a result, do not infer whether context was reshaped, and do not use this tool to guess runtime capacity.",
    );
  });

  it("schema lists the four fields with their descriptions", () => {
    expect(Object.keys(CONTEXT_NEED_INPUT_SCHEMA.properties)).toEqual([
      "min_remaining_tokens",
      "preserve",
      "focus",
      "current_phase_settled",
    ]);
    expect(CONTEXT_NEED_INPUT_SCHEMA.properties.preserve.properties.rounds.description).toBe(
      "Keep at least this many recent tool rounds.",
    );
    expect(CONTEXT_NEED_INPUT_SCHEMA.properties.focus.description).toBe(
      "Information to emphasize if older context is reorganized.",
    );
  });

  it("normalizes valid args", () => {
    expect(
      normalizeContextNeed({
        min_remaining_tokens: 500_000_000,
        preserve: { user_turns: 2, rounds: 99_999 },
        focus: `  ${"f".repeat(500)} `,
        current_phase_settled: true,
      }),
    ).toEqual({
      min_remaining_tokens: 100_000_000,
      preserve: { user_turns: 2, rounds: 10_000 },
      focus: "f".repeat(400),
      current_phase_settled: true,
    });
    expect(normalizeContextNeed({ current_phase_settled: true, focus: "  ", preserve: {} })).toEqual({
      current_phase_settled: true,
    });
  });

  it.each([
    ["not an object", "x"],
    ["array", []],
    ["neither tokens nor settled", { focus: "a" }],
    ["negative tokens", { min_remaining_tokens: -1 }],
    ["fractional tokens", { min_remaining_tokens: 1.5 }],
    ["settled false", { current_phase_settled: false }],
    ["bad preserve", { min_remaining_tokens: 1, preserve: { rounds: "2" } }],
    ["bad focus", { min_remaining_tokens: 1, focus: 3 }],
  ])("rejects %s", (_name, raw) => {
    expect(normalizeContextNeed(raw)).toBeNull();
  });
});
