/**
 * Layout / select — userSelect as a cell law, and serializeSelection
 * (painted cells are a lie).
 */

import { createBuffer } from "../../buffer/index.js";
import { extendSelection, layout, paintFrame, serializeSelection, startSelection } from "../../layout/index.js";
import { FgP } from "../../lexicon/index.js";
import { ComposerFrame, expandWidgetPriors, Text, ThinkingStream, Diff } from "../../widgets/index.js";
import { markdownToLayout } from "../../widgets/internals/markdown-expand.js";
import type { Story } from "../types.js";

function paintedLines(buf: { cells: { ch: string }[]; width: number; height: number }, max = 6): string[] {
  const out: string[] = [];
  for (let y = 0; y < buf.height && out.length < max; y++) {
    let row = "";
    for (let x = 0; x < buf.width; x++) {
      row += buf.cells[y * buf.width + x]?.ch ?? " ";
    }
    const t = row.replace(/\s+$/u, "");
    if (t.length > 0) out.push(t);
  }
  return out;
}

function copyAll(
  node: ReturnType<typeof expandWidgetPriors>,
  w: number,
  h: number,
): { painted: string[]; copied: string } {
  const frame = layout(node, { w, h });
  const buf = createBuffer(w, h);
  paintFrame(frame, buf);
  const sel = extendSelection(startSelection({ col: 0, row: 0 }, "line"), { col: w - 1, row: h - 1 })!;
  const copied = serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
  return { painted: paintedLines(buf), copied };
}

const DIFF_OLD = ["function greet(name: string) {", '  return "Hello, " + name;', "}"].join("\n");

const DIFF_NEW = ["function greet(name: string) {", "  return `Hello, ${name}!`;", "}"].join("\n");

const TABLE_MD = `| check | status | ms |
|---|---|---|
| compile | ok | 812 |
`;

export const SELECT_STORIES: Story[] = [
  {
    id: "l-user-select",
    name: "userSelect",
    category: "layout",
    family: "select",
    description: "text / contain / none — chrome never copies; composer drag stays in the text column",
    build: (ctx) => {
      const w = Math.min(48, ctx.cols);
      return {
        type: "flex",
        style: { direction: "column", gap: 1, width: w },
        children: [
          Text("transcript · userSelect:text", {
            style: { role: "muted", prominence: FgP.ghost },
          }),
          Text("selectable body — drag lights this", {
            userSelect: "text",
            style: { role: "foreground" },
          }),
          Text("composer · userSelect:contain (text column only)", {
            style: { role: "muted", prominence: FgP.ghost },
          }),
          ComposerFrame(
            {
              inputValue: "draft stays inside the box",
              cursor: 5,
              mark: 0,
              placeholder: "Type…",
              hotkeys: [{ key: "Enter", action: "send" }],
            },
            { key: "us-composer", width: Math.min(40, w) },
          ),
          Text("thought · userSelect:none (click collapses, never copies)", {
            style: { role: "muted", prominence: FgP.ghost },
          }),
          ThinkingStream(
            {
              text: "hidden chain",
              live: false,
              collapsed: true,
              seal: "sealed",
              durationMs: 1200,
            },
            { key: "us-thought" },
          ),
        ],
      };
    },
  },
  {
    id: "l-serialize",
    name: "Serialize copy",
    category: "layout",
    family: "select",
    description: "painted ▌ / │ are a lie — copy is git-format / compact markdown table",
    sampleCount: 2,
    build: (ctx) => {
      const w = Math.min(56, Math.max(36, ctx.cols));
      const h = 14;
      const which = ctx.sample % 2;
      const prior =
        which === 0
          ? Diff({
              old: DIFF_OLD,
              new: DIFF_NEW,
              path: "greet.ts",
              language: "typescript",
              mode: "unified",
              lineDiffType: "word-alt",
              width: w,
              key: "ser-diff",
            })
          : markdownToLayout(TABLE_MD, { key: "ser-table" });
      const { painted, copied } = copyAll(expandWidgetPriors(prior, { width: w }), w, h);
      const muted = {
        role: "muted" as const,
        prominence: FgP.ghost,
      };
      return {
        type: "box",
        style: { padding: 1, width: w },
        children: [
          Text(which === 0 ? "diff · painted" : "table · painted", {
            style: { bold: true, role: "foreground" },
          }),
          ...painted.slice(0, 5).map((line, i) =>
            Text(line, {
              key: `paint:${i}`,
              whiteSpace: "nowrap" as const,
              style: { role: "code" },
            }),
          ),
          Text("copy · serializeSelection", {
            style: { bold: true, role: "foreground" },
          }),
          ...copied
            .split("\n")
            .slice(0, 6)
            .map((line, i) =>
              Text(line.length > 0 ? line : " ", {
                key: `copy:${i}`,
                whiteSpace: "nowrap" as const,
                style: muted,
              }),
            ),
        ],
      };
    },
  },
];
