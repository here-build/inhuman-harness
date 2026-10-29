import { expect, test } from "vitest";

import { parseStatuslineRefresh } from "../KernelRoot.js";

test("parseStatuslineRefresh accepts round, turn, and ms durations", () => {
  expect({
    missing: parseStatuslineRefresh(undefined),
    round: parseStatuslineRefresh("round"),
    turn: parseStatuslineRefresh("turn"),
    fiveM: parseStatuslineRefresh("5m"),
    twoH: parseStatuslineRefresh("2h"),
    floor: parseStatuslineRefresh("1s"),
    junk: parseStatuslineRefresh("weekly"),
  }).toEqual({
    missing: { kind: "round" },
    round: { kind: "round" },
    turn: { kind: "turn" },
    fiveM: { kind: "interval", ms: 5 * 60_000 },
    twoH: { kind: "interval", ms: 2 * 3_600_000 },
    floor: { kind: "interval", ms: 5_000 },
    junk: { kind: "round" },
  });
});
