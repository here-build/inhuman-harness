import { expect, test } from "vitest";

import {
  compactPinDraft,
  dropOldestPastThenFarthestFuture,
  neighborColumnHeight,
  prepareRewindNeighbors,
  rewindNeighborSlots,
} from "../rewind-chrome.js";

test("each edge caps at two; leftover is the outer T", () => {
  expect({
    tip: rewindNeighborSlots(0, 9),
    preLast: rewindNeighborSlots(1, 3),
    deep: rewindNeighborSlots(5, 5),
    first: rewindNeighborSlots(4, 0),
  }).toEqual({
    tip: { ahead: 0, behind: 2 },
    preLast: { ahead: 1, behind: 2 },
    deep: { ahead: 2, behind: 2 },
    first: { ahead: 2, behind: 0 },
  });
});

test("compact pin is first line; ellipsis only when multiline", () => {
  expect({
    multi: compactPinDraft("  rotate\nthe secret  "),
    single: compactPinDraft("  rotate the secret  "),
  }).toEqual({
    multi: "rotate…",
    single: "rotate the secret",
  });
});

test("dropOldestPastThenFarthestFuture peels oldest behind, then farthest ahead", () => {
  const past = [
    { key: "a", text: "a" },
    { key: "b", text: "b" },
    { key: "c", text: "c" },
  ];
  const future = [
    { key: "d", text: "d" },
    { key: "e", text: "e" },
  ];
  expect({
    height: neighborColumnHeight(3),
    keepOne: dropOldestPastThenFarthestFuture(past, future, 3),
    none: dropOldestPastThenFarthestFuture(past, future, 0),
    all: dropOldestPastThenFarthestFuture(past, future, 20),
  }).toEqual({
    height: 7,
    keepOne: {
      past: [],
      future: [{ key: "d", text: "d" }],
    },
    none: { past: [], future: [] },
    all: { past, future },
  });
});

test("behind stack T-joins the outer top when more remain", () => {
  const node = prepareRewindNeighbors(
    [
      { key: "older", text: "older" },
      { key: "near", text: "near\nextra" },
    ],
    40,
    "rewind:behind",
    { side: "behind", moreOuter: true },
  );
  const frames = chromeOf(node);
  expect({
    drafts: frames.map((frame) => frame.draft),
    joinTop: frames.map((frame) => frame.joinTop === true),
    omitTop: frames.map((frame) => frame.omitTop === true),
    joinBottom: frames.map((frame) => frame.joinBottom === true),
  }).toEqual({
    drafts: ["older", "near…"],
    joinTop: [true, false],
    omitTop: [false, true],
    joinBottom: [true, false],
  });
});

test("ahead stack T-joins the outer bottom when more remain", () => {
  const node = prepareRewindNeighbors(
    [
      { key: "near", text: "near" },
      { key: "far", text: "far" },
    ],
    40,
    "rewind:ahead",
    { side: "ahead", moreOuter: true },
  );
  const frames = chromeOf(node);
  expect({
    joinTop: frames.map((frame) => frame.joinTop === true),
    joinBottom: frames.map((frame) => frame.joinBottom === true),
  }).toEqual({
    joinTop: [false, false],
    joinBottom: [true, true],
  });
});

function chromeOf(node: unknown): Array<{
  draft?: string;
  joinTop?: boolean;
  omitTop?: boolean;
  joinBottom?: boolean;
}> {
  if (typeof node !== "object" || node === null) return [];
  const rec = node as {
    type?: string;
    draft?: string;
    joinTop?: boolean;
    omitTop?: boolean;
    joinBottom?: boolean;
    children?: unknown[];
  };
  const self = rec.type === "chrome_frame" ? [rec] : [];
  if (!Array.isArray(rec.children)) return self;
  return self.concat(rec.children.flatMap((child) => chromeOf(child)));
}
