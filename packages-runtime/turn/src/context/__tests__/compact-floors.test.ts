/**
 * Preserve floors defaulted to 0 and replaced the in-flight exchange.
 * Floors must be >= 1; explicit /compact keeps more thread than mid-turn.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { CompletionExpectation, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { DEFAULT_COMPACT_KEEP_TURNS } from "../compact-floors.js";
import { keepFloors, sliceCompactEat, Transcript } from "../index.js";

function eat(rounds: number): Transcript {
  resetLocalIDs();
  const cells = [];
  for (let i = 0; i < rounds; i += 1) {
    const expectation = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`turn ${i}`,
    });
    expectation.totalTokens = 100 * (i + 1);
    expectation.responseText = "ok";
    cells.push(expectation, new SystemToolJob({ toolCallId: `t${i}`, name: "shell", argsJson: "{}" }));
  }
  return Transcript.fromCells(cells, 1000 * rounds);
}

test("empty inputs no longer collapse to a 0 floor", () => {
  const mid = keepFloors(null, {}, false);
  expect(mid.rounds).toBeGreaterThanOrEqual(1);
  expect(mid.userTurns).toBeGreaterThanOrEqual(1);

  const forced = keepFloors(null, {}, true);
  expect(forced.rounds).toBeGreaterThan(mid.rounds);
});

test("config floor is the dial; kv and context_need raise it", () => {
  expect(keepFloors(null, {}, false, 4).rounds).toBe(4);
  expect(keepFloors(null, { "compact.keep-turns": "6" }, false, 4).rounds).toBe(6);
  expect(keepFloors({ preserve: { rounds: 8 } }, {}, false, 2).rounds).toBe(8);
});

test("sub-1 and non-integer config values fall back to the default", () => {
  expect(keepFloors(null, {}, false, 0).rounds).toBe(DEFAULT_COMPACT_KEEP_TURNS.midTurn);
  expect(keepFloors(null, {}, true, 0).rounds).toBe(DEFAULT_COMPACT_KEEP_TURNS.explicit);
  expect(keepFloors(null, {}, false, -1).rounds).toBe(DEFAULT_COMPACT_KEEP_TURNS.midTurn);
  expect(keepFloors(null, {}, false, Number.NaN).rounds).toBe(DEFAULT_COMPACT_KEEP_TURNS.midTurn);
});

test("a single-round eat keeps everything — nothing moves to the prefix", () => {
  const sliced = sliceCompactEat(eat(1), keepFloors(null, {}, false));
  expect(sliced.prefix.cells.length).toBe(0);
  expect(sliced.keep.cells.length).toBeGreaterThan(0);
});

test("mid-turn floor preserves the in-flight round and prefixes the rest", () => {
  const sliced = sliceCompactEat(eat(6), keepFloors(null, {}, false));
  expect(sliced.prefix.cells.length).toBeGreaterThan(0);
  expect(sliced.keep.cells.length).toBeGreaterThan(0);
});

test("explicit /compact keeps at least as much as mid-turn", () => {
  const six = eat(6);
  const mid = sliceCompactEat(six, keepFloors(null, {}, false));
  const forced = sliceCompactEat(six, keepFloors(null, {}, true));
  expect(forced.keep.cells.length).toBeGreaterThanOrEqual(mid.keep.cells.length);
});
