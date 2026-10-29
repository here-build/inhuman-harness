import { Diff } from "../../widgets/index.js";
import type { Story } from "../types.js";

/** Small function rewrite — unified/split shared sample. */
const FN_OLD = ["function greet(name: string) {", '  return "Hello, " + name;', "}", ""].join("\n");

const FN_NEW = ["function greet(name: string) {", "  return `Hello, ${name}!`;", "}", ""].join("\n");

/** Single-line word-level edits (word-alt emphasis). */
const WORD_OLD = 'const label = "quick brown fox";\n';
const WORD_NEW = 'const label = "slow gray fox";\n';

/** Auto splits when every painted line fits a half-pane; FN_* does at ≥88. */
const SPLIT_WIDE = 88;

export const DIFF_STORIES: Story[] = [
  {
    id: "diff-unified-small",
    name: "Diff · unified small",
    category: "widgets",
    family: "priors",
    description: "Small function change, forced unified @ ctx.cols",
    build: (ctx) =>
      Diff({
        old: FN_OLD,
        new: FN_NEW,
        path: "greet.ts",
        language: "typescript",
        mode: "unified",
        width: Math.max(1, ctx.cols),
        key: "diff-unified-small",
      }),
  },
  {
    id: "diff-split",
    name: "Diff · split",
    category: "widgets",
    family: "priors",
    description: "Same content as unified, forced split (wide enough)",
    build: (ctx) =>
      Diff({
        old: FN_OLD,
        new: FN_NEW,
        path: "greet.ts",
        language: "typescript",
        mode: "split",
        // split halves need room; force mode split regardless of threshold
        width: Math.max(ctx.cols, 60),
        key: "diff-split",
      }),
  },
  {
    id: "diff-word-alt",
    name: "Diff · word-alt",
    category: "widgets",
    family: "priors",
    description: "lineDiffType word-alt on intra-line word edits",
    build: (ctx) =>
      Diff({
        old: WORD_OLD,
        new: WORD_NEW,
        path: "label.ts",
        language: "typescript",
        mode: "unified",
        lineDiffType: "word-alt",
        width: Math.max(1, ctx.cols),
        key: "diff-word-alt",
      }),
  },
  {
    id: "diff-empty",
    name: "Diff · empty",
    category: "widgets",
    family: "priors",
    description: "Both sides empty → (empty) state",
    build: (ctx) =>
      Diff({
        old: "",
        new: "",
        path: "empty.ts",
        mode: "unified",
        width: Math.max(1, ctx.cols),
        key: "diff-empty",
      }),
  },
  {
    id: "diff-auto-narrow",
    name: "Diff · auto narrow",
    category: "widgets",
    family: "priors",
    description: "mode auto; FN lines overflow a 40-col half-pane → unified",
    build: (ctx) => {
      const width = Math.min(ctx.cols, 40);
      return Diff({
        old: FN_OLD,
        new: FN_NEW,
        path: "greet.ts",
        language: "typescript",
        mode: "auto",
        width: Math.max(1, width),
        key: "diff-auto-narrow",
      });
    },
  },
  {
    id: "diff-auto-wide",
    name: "Diff · auto wide",
    category: "widgets",
    family: "priors",
    description: "mode auto; FN lines fit a wide half-pane → split",
    build: (ctx) => {
      const width = Math.max(ctx.cols, SPLIT_WIDE);
      return Diff({
        old: FN_OLD,
        new: FN_NEW,
        path: "greet.ts",
        language: "typescript",
        mode: "auto",
        width,
        key: "diff-auto-wide",
      });
    },
  },
];
