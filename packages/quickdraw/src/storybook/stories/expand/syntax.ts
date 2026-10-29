/**
 * Expand / syntax — internals/syntax.ts, not a public widget family.
 *
 * build is sync, so we fire-and-forget warmHighlighter() and use
 * highlightCodeSync in build. Before warm completes (or on unknown lang),
 * highlightCodeSync returns plain-text lines so goldens stay deterministic.
 */

import type { LayoutNode } from "../../../layout/index.js";
import {
  highlightCodeSync,
  runsToStyle,
  warmHighlighter,
  type HighlightLine,
} from "../../../widgets/internals/syntax.js";
import type { Story } from "../../types.js";
import { Panel } from "../demo-atoms.js";

// Fire-and-forget warm so subsequent builds can use colored tokens.
void warmHighlighter();

function linesToLayoutNodes(lines: HighlightLine[], opts?: { key?: string; maxLines?: number }): LayoutNode[] {
  const limit = opts?.maxLines === undefined ? lines.length : opts.maxLines;
  const slice = lines.slice(0, Math.max(0, limit));
  const keyBase = opts?.key;

  return slice.map((line, i) => {
    const lineKey = keyBase === undefined ? undefined : `${keyBase}:${i}`;
    if (line.length <= 1) {
      const run = line[0] ?? { text: "" };
      const node: Extract<LayoutNode, { type: "text" }> = {
        type: "text",
        content: run.text,
        whiteSpace: "nowrap",
        style: runsToStyle(run),
      };
      if (lineKey !== undefined) node.key = lineKey;
      return node;
    }
    const children = line.map((run, j) => {
      const node: Extract<LayoutNode, { type: "text" }> = {
        type: "text",
        content: run.text,
        whiteSpace: "nowrap",
        style: runsToStyle(run),
      };
      if (keyBase !== undefined) node.key = `${keyBase}:${i}:${j}`;
      return node;
    });
    const flex: Extract<LayoutNode, { type: "flex" }> = {
      type: "flex",
      style: { direction: "row", gap: 0 },
      children,
    };
    if (lineKey !== undefined) flex.key = lineKey;
    return flex;
  });
}

const TS_SAMPLE = [
  "type Point = { x: number; y: number };",
  "export function dist(a: Point, b: Point): number {",
  "  const dx = a.x - b.x;",
  "  return Math.hypot(dx, a.y - b.y);",
  "}",
].join("\n");

const JSON_SAMPLE = ["{", '  "name": "quickdraw",', '  "tier": 1,', '  "ready": true', "}"].join("\n");

// Scheme not in warm langs — highlight as javascript with lisp-ish body.
const SCHEME_SAMPLE = [
  "(define (fact n)",
  "  (if (<= n 1)",
  "      1",
  "      (* n (fact (- n 1)))))",
  "(fact 5)",
].join("\n");

const PLAIN_SAMPLE = ["plain line one", "plain line two"].join("\n");

const LONG_SAMPLE = Array.from({ length: 24 }, (_, i) => `const line${i} = ${i}; // sample`).join("\n");

function codePanel(
  title: string,
  code: string,
  opts: {
    lang?: string;
    key: string;
    width: number;
    maxLines?: number;
  },
): LayoutNode {
  const lines = highlightCodeSync(code, { lang: opts.lang });
  const nodes = linesToLayoutNodes(lines, {
    key: opts.key,
    maxLines: opts.maxLines,
  });
  return Panel(nodes, {
    title,
    width: opts.width,
    key: `${opts.key}:panel`,
  });
}

export const HIGHLIGHT_STORIES: Story[] = [
  {
    id: "hl-typescript",
    name: "TypeScript",
    category: "expand",
    family: "syntax",
    description: "Short TS sample via linesToLayoutNodes",
    build: (ctx) =>
      codePanel("TypeScript", TS_SAMPLE, {
        lang: "typescript",
        key: "hl-ts",
        width: Math.min(56, ctx.cols),
      }),
  },
  {
    id: "hl-json",
    name: "JSON",
    category: "expand",
    family: "syntax",
    description: "JSON sample with token colors when warm",
    build: (ctx) =>
      codePanel("JSON", JSON_SAMPLE, {
        lang: "json",
        key: "hl-json",
        width: Math.min(40, ctx.cols),
      }),
  },
  {
    id: "hl-scheme",
    name: "JS stand-in (lisp-ish)",
    category: "expand",
    family: "syntax",
    description: "Lisp-ish body highlighted as javascript — scheme is not in the warm set",
    build: (ctx) =>
      codePanel("Scheme-ish (js)", SCHEME_SAMPLE, {
        lang: "javascript",
        key: "hl-scheme",
        width: Math.min(48, ctx.cols),
      }),
  },
  {
    id: "hl-plain-fallback",
    name: "Plain fallback",
    category: "expand",
    family: "syntax",
    description: "Unknown lang forces plain path (stable goldens)",
    build: (ctx) =>
      codePanel("Plain fallback", PLAIN_SAMPLE, {
        lang: "not-a-real-lang-xyz",
        key: "hl-plain",
        width: Math.min(36, ctx.cols),
      }),
  },
  {
    id: "hl-max-lines",
    name: "maxLines clamp",
    category: "expand",
    family: "syntax",
    description: "Long code clamped via maxLines",
    build: (ctx) =>
      codePanel("maxLines=6", LONG_SAMPLE, {
        lang: "typescript",
        key: "hl-max",
        width: Math.min(48, ctx.cols),
        maxLines: 6,
      }),
  },
];
