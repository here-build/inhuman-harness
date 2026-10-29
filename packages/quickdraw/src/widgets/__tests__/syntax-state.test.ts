import { autorun } from "mobx";
import { expect, test } from "vitest";

import {
  highlightCodeSync,
  setHighlightPolarity,
  syntaxPolarity,
  syntaxWarm,
  warmHighlighter,
} from "../internals/syntax.js";

/**
 * Ambient highlighter state is MobX-observable, not an invalidation counter.
 * Retained widgets read these inside a `reaction` data function; a plain
 * `let` is invisible to MobX, so the reaction never re-ran and a cold→warm
 * or dark→light flip left the cached subtree painted with the old palette.
 */
test("syntax polarity is observable and tracked by reactions", () => {
  setHighlightPolarity("dark");
  let ticks = 0;
  const seen: string[] = [];
  const stop = autorun(() => {
    seen.push(syntaxPolarity());
    ticks += 1;
  });
  try {
    setHighlightPolarity("dark"); // redundant write — still a set on the box
    setHighlightPolarity("light");
    setHighlightPolarity("dark");
    expect({
      trackedEveryWrite: ticks,
      sawLight: seen.includes("light"),
      endedDark: seen[seen.length - 1] === "dark",
    }).toEqual({ trackedEveryWrite: 3, sawLight: true, endedDark: true });
  } finally {
    stop();
  }
});

test("warming the highlighter flips the observable warmth", async () => {
  await warmHighlighter();
  expect(syntaxWarm()).toBe(true);
}, 60_000);

test("huge sources skip the tokenizer", async () => {
  await warmHighlighter();
  const source = Array.from({ length: 20_000 }, () => "const x = 1;").join("\n");
  const started = Date.now();
  const lines = highlightCodeSync(source, { lang: "typescript" });
  expect({
    lines: lines.length,
    ms: Date.now() - started < 80,
  }).toEqual({ lines: 20_000, ms: true });
}, 60_000);
