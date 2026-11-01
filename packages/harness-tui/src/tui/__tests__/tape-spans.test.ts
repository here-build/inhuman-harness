import { expect, test } from "vitest";

import { clusterThoughtClock, filterFusedTools, groupTapeSpans, type TapeItem } from "../tape-spans.js";

test.each([
  {
    name: "screenshot replay: remaining tools cut the thought glue",
    items: [
      { kind: "user", node: "prompt" },
      { kind: "speech", node: "speech1", thought: null },
      { kind: "tool", node: "glob" },
      { kind: "tool", node: "list_dir" },
      { kind: "thought-only", node: "t-7.6s" },
      { kind: "tool", node: "read_readme" },
      { kind: "tool", node: "read_pkg" },
      { kind: "thought-only", node: "t-4.3s" },
      { kind: "speech", node: "speech2", thought: null },
      { kind: "tool", node: "read_bin" },
    ] satisfies TapeItem<string>[],
    fused: undefined,
    spans: [
      { kind: "user", node: "prompt" },
      { kind: "speech", node: "speech1" },
      { kind: "tools", nodes: ["glob", "list_dir"] },
      { kind: "thoughts", nodes: ["t-7.6s"] },
      { kind: "tools", nodes: ["read_readme", "read_pkg"] },
      { kind: "thoughts", nodes: ["t-4.3s"] },
      { kind: "speech", node: "speech2" },
      { kind: "tools", nodes: ["read_bin"] },
    ],
  },
  {
    name: "compact omits fused tools so thoughts glue across known-safe effects",
    items: [
      { kind: "thought-only", node: "t1" },
      { kind: "tool", node: "glob" },
      { kind: "tool", node: "read" },
      { kind: "thought-only", node: "t2" },
      { kind: "tool", node: "write" },
      { kind: "thought-only", node: "t3" },
      { kind: "tool", node: "edit" },
      { kind: "speech", node: "s", thought: null },
    ] satisfies TapeItem<string>[],
    fused: new Set(["glob", "read"]),
    spans: [
      { kind: "thoughts", nodes: ["t1", "t2"] },
      { kind: "tools", nodes: ["write"] },
      { kind: "thoughts", nodes: ["t3"] },
      { kind: "tools", nodes: ["edit"] },
      { kind: "speech", node: "s" },
    ],
  },
  {
    name: "a speech-bearing completion's thought sits in the gap before that speech",
    items: [
      { kind: "thought-only", node: "t1" },
      { kind: "speech", node: "s1", thought: "t2" },
      { kind: "tool", node: "read" },
    ] satisfies TapeItem<string>[],
    fused: undefined,
    spans: [
      { kind: "thoughts", nodes: ["t1", "t2"] },
      { kind: "speech", node: "s1" },
      { kind: "tools", nodes: ["read"] },
    ],
  },
  {
    name: "user prompt flushes a pending gap",
    items: [
      { kind: "speech", node: "s1", thought: null },
      { kind: "tool", node: "a" },
      { kind: "user", node: "next" },
      { kind: "speech", node: "s2", thought: "t" },
    ] satisfies TapeItem<string>[],
    fused: undefined,
    spans: [
      { kind: "speech", node: "s1" },
      { kind: "tools", nodes: ["a"] },
      { kind: "user", node: "next" },
      { kind: "thoughts", nodes: ["t"] },
      { kind: "speech", node: "s2" },
    ],
  },
])("$name", ({ items, fused, spans }) => {
  const input = fused === undefined ? items : filterFusedTools(items, (node) => fused.has(node));
  expect(groupTapeSpans(input)).toEqual(spans);
});

test("cluster thought clock sums sealed members; live origin ticks the sum", () => {
  const liveAt = 100_000;
  const now = 102_000;
  expect({
    live: clusterThoughtClock(
      [
        { live: false, startedAt: 1, durationMs: 7_600 },
        { live: false, startedAt: 2, durationMs: 4_300 },
        { live: true, startedAt: liveAt, durationMs: 500 },
      ],
      now,
    ),
    sealed: clusterThoughtClock([
      { live: false, startedAt: 1, durationMs: 7_600 },
      { live: false, startedAt: 2, durationMs: 4_300 },
    ]),
  }).toEqual({
    live: {
      live: true,
      startedAt: liveAt - 11_900,
      durationMs: 11_900 + 2_000,
    },
    sealed: {
      live: false,
      startedAt: undefined,
      durationMs: 11_900,
    },
  });
});
