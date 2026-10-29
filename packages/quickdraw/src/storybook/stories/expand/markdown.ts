/**
 * Expand / markdown — SMD expander (`markdownToLayout`), not Markdown().
 * Sample strings are inlined (ported lightly from reference fixtures) — no harness imports.
 */

import { guardContent } from "../../../buffer/index.js";
import { FgP } from "../../../lexicon/index.js";
import { Text } from "../../../widgets/index.js";
import { createStreamingMarkdown, markdownToLayout } from "../../../widgets/internals/markdown-expand.js";
import type { Story } from "../../types.js";
import { Panel } from "../demo-atoms.js";

/** Sealed multi-block golden — headings, inline, list, fence. */
const MD_SEALED_GOLDEN = `# Diagnostic Report

Summary of the **run**: all checks passed with \`code\`.

## Steps

- Compile the project
- Run the test suite

## Code

\`\`\`ts
function ok(): true {
  return true
}
\`\`\`

Done.
`;

/** Table + ordered/unordered lists. */
const MD_TABLE_LIST = `## Inventory

| check | status | ms |
|---|---|---|
| compile | ok | 812 |
| test | ok | 4021 |
| lint | warn | 233 |

### Ordered

1. First
2. Second with **bold**
3. Third

### Unordered

- bullet a
- bullet b with \`code\`
`;

/**
 * Multi-chunk stream that rebuilds a sealed diagnostic-style doc.
 * Used with createStreamingMarkdown + progressive write() cuts.
 */
const MD_STREAM_CHUNKS: string[] = [
  "# ",
  "Stream Report\n\n",
  "Prefix of the **run**: all ",
  "checks passed, one _warning_ noted.\n\n",
  "## Steps\n\n",
  "1. Compile the project\n",
  "2. Run the test suite\n",
  "3. Collect timing\n\n",
  "## Code\n\n",
  "```ts\n",
  "const x = 1\nexport const ok = true\n",
  "```\n\n",
  "## Results\n\n",
  "| check | status |\n|---|---|\n",
  "| compile | ok |\n",
  "| test | ok |\n\n",
  "Done.\n",
];

/**
 * Markdown embedding ESC/CSI.
 *
 * Two chokepoints strip control sequences:
 *   1. markdown write → guardContent (BEFORE parser — CSI `[` is a link opener)
 *   2. buffer put → guardContent (paint; measure/layout stay aligned)
 *
 * Without (1): "before ⎋[2J after" paints as "before 2J after" (bracket eaten as link).
 * With spaces in the payload we prove spaces survive; mid-word CSI joins letters.
 */
const MD_EDGE_CSI_RAW = [
  "Safe text before.",
  "",
  "Spaces kept: before \u001B[2J after.",
  "",
  "Mid-word join: hello\u001B[1;31mworld.",
  "",
  "Inline code: `hello \u001B[2J world`.",
  "",
  "Bold + CSI: **bold \u001B[0m reset** still ends.",
  "",
  "```",
  "fence line \u001B[1;31mRED?\u001B[0m plain",
  "```",
].join("\n");

/** ESC → ⎋ so the demo never needs raw CSI in cells to be readable. */
function visibleEscapes(s: string): string {
  return s.replaceAll("\u001B", "⎋").replaceAll("\u009B", "CSI");
}

/**
 * Blockquote + strikethrough.
 * Middle bare `>` is a paragraph separator — we reify it as a bar-only gap
 * row so multi-line │ (incl. empty middle) stays visible/testable.
 */
const MD_BLOCKQUOTE_STRIKE = `> quoted **line** with \`code\`
>
> second line still quoted

keep ~~remove~~ keep
`;

function streamPrefix(chunkCount: number): string {
  const n = Math.max(0, Math.min(chunkCount, MD_STREAM_CHUNKS.length));
  return MD_STREAM_CHUNKS.slice(0, n).join("");
}

export const MARKDOWN_STORIES: Story[] = [
  {
    id: "md-sealed-golden",
    name: "Markdown · sealed golden",
    category: "expand",
    family: "markdown",
    description: "Sealed multi-block MD: headings, paragraph with code/bold, list, fence",
    build: (ctx) =>
      Panel(
        [
          Text("markdownToLayout sealed", {
            key: "md-sg:lbl",
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          markdownToLayout(MD_SEALED_GOLDEN, { key: "md-sg:body" }),
        ],
        {
          key: "md-sg",
          title: "md-sealed-golden",
          width: Math.min(56, Math.max(24, ctx.cols)),
        },
      ),
  },
  {
    id: "md-table-list",
    name: "Markdown · table + lists",
    category: "expand",
    family: "markdown",
    description: "GFM-ish table plus ordered and unordered lists",
    build: (ctx) =>
      Panel(
        [
          Text("table · ol · ul", {
            key: "md-tl:lbl",
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          markdownToLayout(MD_TABLE_LIST, { key: "md-tl:body" }),
        ],
        {
          key: "md-tl",
          title: "md-table-list",
          width: Math.min(56, Math.max(24, ctx.cols)),
        },
      ),
  },
  {
    id: "md-stream-prefix",
    name: "Markdown · stream prefix",
    category: "expand",
    family: "markdown",
    description: "Progressive createStreamingMarkdown write() cuts via ctx.sample (no end)",
    sampleCount: 6, // cuts: 1, 3, 6, 10, 12, full
    build: (ctx) => {
      // discrete cut points so sample steps feel meaningful
      const cuts = [1, 3, 6, 10, 12, MD_STREAM_CHUNKS.length];
      const cut = cuts[ctx.sample % cuts.length]!;
      const prefix = streamPrefix(cut);

      const stream = createStreamingMarkdown({ key: "md-sp:live" });
      stream.write(prefix);
      // intentional: do not end() — partial/open frames
      const liveKids = stream.nodes();

      return Panel(
        [
          Text(`stream prefix ${cut}/${MD_STREAM_CHUNKS.length} chunks (sample)`, {
            key: "md-sp:hdr",
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          Text("— write() without end() —", {
            key: "md-sp:live-lbl",
            style: { role: "foreground", prominence: FgP.ghost },
          }),
          {
            type: "box",
            key: "md-sp:live-box",
            children:
              liveKids.length > 0
                ? liveKids
                : [
                    Text("(empty partial)", {
                      key: "md-sp:empty",
                      style: { role: "foreground", prominence: FgP.ghost },
                    }),
                  ],
          },
        ],
        {
          key: "md-sp",
          title: "md-stream-prefix",
          width: Math.min(56, Math.max(24, ctx.cols)),
        },
      );
    },
  },
  {
    id: "md-edge-csi",
    name: "Markdown · ESC/CSI edge",
    category: "expand",
    family: "markdown",
    description: "CSI `[` is a MD link opener — guard before parse; spaces kept, CSI gone",
    build: (ctx) => {
      const w = Math.min(56, Math.max(24, ctx.cols));
      // Spaced samples: without ingress guard, `[` is eaten and it *looks*
      // like spaces vanished ("before2Jafter"). With guard, spaces stay.
      const samples = [
        ["spaced", "before \u001B[2J after"],
        ["glued", "hello\u001B[1;31mworld"],
        ["sgr", "hi \u001B[1;31m there"],
      ] as const;
      return Panel(
        [
          Text("CSI contains `[` → MD link unless guardContent before parse", {
            key: "md-csi:lbl",
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          ...samples.flatMap(([label, raw], i) => [
            Text(`${label} raw: ${visibleEscapes(raw)}`, {
              key: `md-csi:r${i}`,
              style: { role: "code" },
            }),
            Text(`${label} safe: ${JSON.stringify(guardContent(raw))}`, {
              key: `md-csi:s${i}`,
              style: { role: "success" },
            }),
          ]),
          Text("— markdownToLayout (ingress-guarded) —", {
            key: "md-csi:sep",
            style: { role: "foreground", prominence: FgP.ghost },
          }),
          markdownToLayout(MD_EDGE_CSI_RAW, { key: "md-csi:body" }),
        ],
        {
          key: "md-csi",
          title: "md-edge-csi",
          width: w,
        },
      );
    },
  },
  {
    id: "md-blockquote-strike",
    name: "Markdown · blockquote + strike",
    category: "expand",
    family: "markdown",
    description: "Blockquote │ on every row + ~~strikethrough~~ (SGR 9)",
    build: (ctx) => {
      // Must fit in ctx.rows (shell subtracts demo chrome). Content:
      // title(1) + bq first/gap/second(3) + keep(1) + border/pad(4) = 9.
      // No extra label — long labels wrapped and ate the keep line.
      return Panel([markdownToLayout(MD_BLOCKQUOTE_STRIKE, { key: "md-bqs:body" })], {
        key: "md-bqs",
        title: "multi-row · strike SGR9",
        width: Math.min(48, Math.max(28, ctx.cols)),
        height: ctx.rows,
      });
    },
  },
  {
    id: "md-flow-margin",
    name: "Markdown · flow margin",
    category: "expand",
    family: "markdown",
    description: "1-cell gap between paragraphs, and when a table or quote sits mid-block",
    build: (ctx) =>
      Panel(
        [
          markdownToLayout(
            [
              "Lead paragraph before the quote.",
              "",
              "> quoted block that needs room",
              "",
              "Mid paragraph between quote and table.",
              "",
              "| col | n |",
              "|-----|---|",
              "| a   | 1 |",
              "",
              "Trail paragraph after the table.",
            ].join("\n"),
            { key: "md-flow:body" },
          ),
        ],
        {
          key: "md-flow",
          title: "flow margins",
          width: Math.min(48, Math.max(28, ctx.cols)),
        },
      ),
  },
  {
    id: "md-inline-rest",
    name: "Markdown · inline rest",
    category: "expand",
    family: "markdown",
    description: "link OSC 8 · HR · task checkboxes · image alt",
    build: (ctx) =>
      Panel(
        [
          markdownToLayout(
            [
              "See [docs](https://example.com/docs) and https://raw.example.",
              "",
              "---",
              "",
              "- [ ] open task",
              "- [x] done task",
              "",
              "![diagram](src.png)",
            ].join("\n"),
            { key: "md-rest:body" },
          ),
        ],
        {
          key: "md-rest",
          title: "inline rest",
          width: Math.min(52, Math.max(28, ctx.cols)),
        },
      ),
  },
];
