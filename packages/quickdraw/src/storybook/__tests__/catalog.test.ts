import { expect, test } from "vitest";

import { CATALOG, getStory } from "../catalog.js";
import {
  expandGoldenMatrix,
  filterGoldenMatrix,
  parseGoldenSlug,
  storySampleCount,
  storyTickSnapshots,
} from "../golden-matrix.js";
import { STORY_CHAPTERS } from "../index.js";
import { paintNode } from "../render.js";

test("catalog + golden-matrix SSOT", () => {
  const ids = CATALOG.map((s) => s.id);
  expect([...new Set(ids)]).toEqual(ids);

  expect({
    chapters: [...new Set(CATALOG.map((s) => s.category))],
    leads: {
      theme: CATALOG.find((s) => s.category === "theme")?.id,
      layout: CATALOG.find((s) => s.category === "layout")?.id,
      widgets: CATALOG.find((s) => s.category === "widgets")?.id,
    },
  }).toEqual({
    chapters: [...STORY_CHAPTERS],
    leads: {
      theme: "theme-region-dim",
      layout: "l-indication",
      widgets: "w-composer-chrome",
    },
  });

  const retired = new Set(["markdown", "highlight", "diff", "paint"]);
  expect({
    retiredIds: CATALOG.filter((s) => retired.has(s.category)).map((s) => s.id),
    themeRoleStrip: getStory("theme-role-strip"),
    missingFamily: CATALOG.filter((s) => s.family == null).map((s) => s.id),
    fxIds: CATALOG.filter((s) => s.category === "fx").map((s) => s.id),
  }).toEqual({
    retiredIds: [],
    themeRoleStrip: undefined,
    missingFamily: [],
    fxIds: ["fx-aurora", "fx-doom", "fx-gradient"],
  });

  expect(["w-button__s0__t0", "md-stream-prefix__s3__t0", "w-button", ""].map(parseGoldenSlug)).toEqual([
    { storyId: "w-button", sample: 0, tick: 0 },
    { storyId: "md-stream-prefix", sample: 3, tick: 0 },
    { storyId: "w-button", sample: 0, tick: 0 },
    null,
  ]);

  const matrix = expandGoldenMatrix(CATALOG);
  expect(new Set(matrix.map((s) => s.storyId)).size).toBe(CATALOG.length);

  const multi = getStory("w-multiline")!;
  const live = getStory("w-thinking-live")!;
  const stream = getStory("md-stream-prefix")!;
  expect({
    multiline: {
      samples: storySampleCount(multi),
      names: expandGoldenMatrix([multi]).map((c) => c.name),
    },
    thinkingLive: {
      samples: storySampleCount(live),
      ticks: storyTickSnapshots(live),
      cells: expandGoldenMatrix([live]).map((c) => c.sample),
    },
    streamPrefix: {
      samples: storySampleCount(stream),
      cells: expandGoldenMatrix([stream]).length,
    },
  }).toEqual({
    multiline: {
      samples: 4,
      names: ["w-multiline__s0__t0", "w-multiline__s1__t0", "w-multiline__s2__t0", "w-multiline__s3__t0"],
    },
    thinkingLive: {
      samples: 3,
      ticks: [0],
      cells: [0, 1, 2],
    },
    streamPrefix: { samples: 6, cells: 6 },
  });

  const names = matrix.map((s) => s.name);
  expect([...new Set(names)]).toEqual(names);

  const byStory = filterGoldenMatrix(matrix, { story: "w-multiline" });
  const md = filterGoldenMatrix(matrix, { category: "markdown" });
  const hl = filterGoldenMatrix(matrix, { category: "highlight" });
  const diff = filterGoldenMatrix(matrix, { category: "diff" });
  const paint = filterGoldenMatrix(matrix, { category: "paint" });
  expect({
    story: { ids: [...new Set(byStory.map((s) => s.storyId))], length: byStory.length },
    markdown: md.length > 0 && md.every((s) => s.storyId.startsWith("md-")),
    highlight: hl.every((s) => s.storyId.startsWith("hl-")),
    diff: diff.every((s) => s.storyId.startsWith("diff-")),
    paint: paint.every((s) => s.category === "buffer" || s.storyId.startsWith("paint-")),
  }).toEqual({
    story: { ids: ["w-multiline"], length: 4 },
    markdown: true,
    highlight: true,
    diff: true,
    paint: true,
  });

  expect(
    matrix.map((cell) => {
      const story = getStory(cell.storyId)!;
      const node = story.build({
        cols: 54,
        rows: 16,
        sample: cell.sample,
        tick: cell.tick,
      });
      return { name: cell.name, cells: paintNode(node, 56, 18).cells.length };
    }),
  ).toEqual(matrix.map((cell) => ({ name: cell.name, cells: 56 * 18 })));
});
