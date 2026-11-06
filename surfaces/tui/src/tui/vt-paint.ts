/**
 * Shell VT paint. Named ANSI slots take theme hue/chroma ({@link ANSI16_ROLE}
 * / {@link seedHueRgb}); 256/truecolor keep decoded H/C. Both pair with the
 * surrounding voice so the resolver recasts apparent lightness onto the rest
 * of the tape. Sequences never reach Text.content — {@link parseVtLines} ate
 * them.
 */
import { parseVtLines, type VtColor, type VtRun, type VtStyle } from "@inhuman.tools/harness-model/vt-text";
import type { Style } from "@inhuman.tools/quickdraw/buffer";
import { type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import type { Rgb } from "@inhuman.tools/quickdraw/lexicon";
import { displayWidth, splitAtWidth } from "@inhuman.tools/quickdraw/measure";
import { ANSI16_ROLE, ansi256ToRgb, seedHueRgb } from "@inhuman.tools/quickdraw/theme";
import { Text } from "@inhuman.tools/quickdraw/widgets";

export type VtVoice = {
  readonly role: NonNullable<Style["role"]>;
  readonly prominence: number;
};

function vtColorRgb(color: VtColor | undefined): Rgb | undefined {
  if (color === undefined) return undefined;
  if (color.type === "rgb") return { r: color.r, g: color.g, b: color.b };
  if (color.n < 16) return seedHueRgb(ANSI16_ROLE[color.n]!);
  return ansi256ToRgb(color.n);
}

function runStyle(style: VtStyle, voice: VtVoice): Style {
  const out: Style = { role: voice.role, prominence: voice.prominence };
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (style.strike) out.strike = true;
  const rgb = vtColorRgb(style.fg);
  if (rgb !== undefined) out.fgRgb = rgb;
  return out;
}

function copyRun(run: VtRun, text: string): VtRun {
  return text === run.text ? run : { text, style: run.style };
}

function wrapLine(runs: readonly VtRun[], width: number): VtRun[][] {
  const rows: VtRun[][] = [];
  let row: VtRun[] = [];
  let used = 0;
  const flush = (): void => {
    rows.push(row);
    row = [];
    used = 0;
  };
  for (const run of runs) {
    let rest = run.text;
    if (rest.length === 0 && row.length === 0) continue;
    while (rest.length > 0) {
      const room = width - used;
      if (room <= 0) {
        flush();
        continue;
      }
      const w = displayWidth(rest);
      if (w <= room) {
        row.push(copyRun(run, rest));
        used += w;
        rest = "";
        continue;
      }
      const [head, tail] = splitAtWidth(rest, room);
      if (head.length === 0) {
        if (used === 0) {
          const [one, more] = splitAtWidth(rest, Math.max(1, width));
          if (one.length > 0) row.push(copyRun(run, one));
          flush();
          rest = more;
        } else {
          flush();
        }
        continue;
      }
      row.push(copyRun(run, head));
      flush();
      rest = tail;
    }
  }
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

function runNodes(runs: readonly VtRun[], key: string, voice: VtVoice): LayoutNode[] {
  return runs.map((run, i) =>
    Text(run.text.length > 0 ? run.text : " ", {
      key: `${key}:${i}`,
      whiteSpace: "nowrap",
      style: runStyle(run.style, voice),
    }),
  );
}

export function VtText(
  text: string,
  opts: { readonly key: string; readonly width: number; readonly style: VtVoice },
): LayoutNode {
  const lines = parseVtLines(text);
  const width = Math.max(1, opts.width);
  const children: LayoutNode[] = [];
  for (const [i, line] of lines.entries()) {
    const source = line.length > 0 ? line : [{ text: "", style: {} }];
    const wrapped = wrapLine(source, width);
    for (const [j, piece] of wrapped.entries()) {
      const key = `${opts.key}:${i}:${j}`;
      const row = runNodes(piece, key, opts.style);
      children.push({
        type: "flex",
        key,
        style: { direction: "row" },
        children: row.length > 0 ? row : [Text(" ", { key: `${key}:empty`, whiteSpace: "nowrap" })],
      });
    }
  }
  if (children.length === 0) {
    children.push(Text(" ", { key: `${opts.key}:empty`, whiteSpace: "nowrap" }));
  }
  return {
    type: "flex",
    key: opts.key,
    style: { direction: "column", width },
    children,
  };
}
