import { expect, test } from "vitest";

import { rasterLayout } from "../../runtime/raster.js";
import { Diff } from "../diff.js";

const prefix = Array.from({ length: 45 }, (_, i) => `pre-${i}`).join("\n");
const suffix = Array.from({ length: 20 }, (_, i) => `post-${i}`).join("\n");
const oldLine = "const resetInSec = raw.resetInSec ?? remaining.resetAt;";
const newLine = "const resetInSec = raw.resetInSec ?? raw.resetsAt;";
const old = `${prefix}\n${oldLine}\nconst exhausted = raw.status === "exhausted";\n${suffix}\n`;
const next = `${prefix}\n${newLine}\nconst exhausted = raw.status === "exhausted";\n${suffix}\n`;
const spanOld = `${oldLine}\nconst exhausted = raw.status === "exhausted";\n`;
const spanNew = `${newLine}\nconst exhausted = raw.status === "exhausted";\n`;

test("painted Diff numbers are file lines after elision, and lineStart shifts a span", () => {
  const full = rasterLayout(
    Diff({
      old,
      new: next,
      path: "opencode-go.ts",
      width: 120,
      hideHeader: true,
      noHighlight: true,
      key: "full",
    }),
    120,
    24,
  );
  const span = rasterLayout(
    Diff({
      old: spanOld,
      new: spanNew,
      path: "opencode-go.ts",
      width: 120,
      hideHeader: true,
      noHighlight: true,
      key: "span",
    }),
    120,
    12,
  );
  const shifted = rasterLayout(
    Diff({
      old: spanOld,
      new: spanNew,
      path: "opencode-go.ts",
      width: 120,
      hideHeader: true,
      noHighlight: true,
      lineStart: 46,
      key: "shift",
    }),
    120,
    12,
  );
  expect({
    full: {
      file: full.some((row) => row.includes("46")),
      elide: full.some((row) => row.includes("unchanged")),
    },
    span: {
      origin: span.some((row) => row.includes("▌1 ") || row.includes(" 1 ")),
      file: span.some((row) => row.includes("46")),
    },
    shifted: {
      file: shifted.some((row) => row.includes("46")),
      origin: shifted.some((row) => row.includes("▌1 ") || /^\s*1 /.test(row)),
    },
  }).toEqual({
    full: { file: true, elide: true },
    span: { origin: true, file: false },
    shifted: { file: true, origin: false },
  });
});
