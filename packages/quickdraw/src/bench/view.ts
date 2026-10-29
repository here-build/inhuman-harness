/**
 * Pure view: Model → buffer paint.
 * Runs on the **render (main)** thread only.
 */

import type { FpsStats } from "./host.js";
import type { Model } from "./model.js";
import { type Buffer, clear, createBuffer, put, type Style } from "../buffer/index.js";
import { FgP } from "../lexicon/index.js";

export function paint(model: Model, stats: FpsStats, into?: Buffer): Buffer {
  const w = Math.max(40, model.cols);
  const h = Math.max(10, model.rows);
  const buf = into && into.width === w && into.height === h ? into : createBuffer(w, h);
  clear(buf);

  // header
  const header = ` quickdraw bench │ tick=${model.tick} │ burn=${model.burnMs}ms │ ${model.paused ? "PAUSED" : "live"} `;
  put(buf, 0, 0, pad(header, w), { role: "accent", prominence: FgP.primary, bold: true });

  // stats line
  const statsLine = ` fps=${stats.fps.toFixed(1)} frame=${stats.frameMs.toFixed(1)}ms gen=${stats.lastGen} drop≈${stats.snapshotsDropped} │ keys: j/k scroll  space pause  b/B burn  a burst  q quit `;
  put(buf, 0, 1, pad(statsLine, w), { role: "foreground", prominence: FgP.secondary });

  // split: log (left) + panel (right)
  const panelW = Math.min(28, Math.floor(w * 0.3));
  const logW = w - panelW - 1;
  const bodyTop = 2;
  const bodyH = h - 3;
  const visible = bodyH;

  // log region
  for (let row = 0; row < visible; row++) {
    const li = model.scroll + row;
    const y = bodyTop + row;
    if (li < 0 || li >= model.lines.length) {
      put(buf, 0, y, pad("", logW), {});
      continue;
    }
    const style: Style =
      li % 17 === 0 ? { role: "warning", prominence: FgP.primary } : { role: "foreground", prominence: FgP.primary };
    put(buf, 0, y, pad(model.lines[li]!.slice(0, logW), logW), style);
  }

  // divider
  for (let row = 0; row < visible; row++) {
    put(buf, logW, bodyTop + row, "│", { role: "border", prominence: FgP.ghost });
  }

  // side panel
  const px = logW + 1;
  put(buf, px, bodyTop, pad(" PANEL", panelW), {
    role: "accent",
    prominence: FgP.primary,
    bold: true,
  });
  put(buf, px, bodyTop + 1, pad(` lines ${model.lines.length}`, panelW), {
    role: "foreground",
    prominence: FgP.primary,
  });
  put(buf, px, bodyTop + 2, pad(` scroll ${model.scroll}`, panelW), {
    role: "foreground",
    prominence: FgP.primary,
  });
  put(buf, px, bodyTop + 3, pad(` size ${w}x${h}`, panelW), {
    role: "foreground",
    prominence: FgP.primary,
  });
  const t = new Date(model.now).toISOString().slice(11, 23);
  put(buf, px, bodyTop + 5, pad(` time ${t}`, panelW), {
    role: "muted",
    prominence: FgP.ghost,
  });

  // fake sparkline from tick
  let spark = " ";
  for (let i = 0; i < Math.max(0, panelW - 2); i++) {
    const v = (Math.sin((model.tick + i) * 0.15) + 1) * 0.5;
    spark += " ▁▂▃▄▅▆▇█"[Math.min(8, Math.floor(v * 9))]!;
  }
  // `accent` for now — no dedicated `data` role until a second data surface
  // exists to justify one (plan: explicit non-commitment).
  put(buf, px, bodyTop + 7, pad(spark.slice(0, panelW), panelW), {
    role: "accent",
    prominence: FgP.primary,
  });

  const configLabel: Style = { role: "muted", prominence: FgP.ghost };
  put(buf, px, bodyTop + 9, pad(" logic=worker", panelW), configLabel);
  put(buf, px, bodyTop + 10, pad(" paint=main", panelW), configLabel);
  put(buf, px, bodyTop + 11, pad(" target=30fps", panelW), configLabel);

  // footer
  put(
    buf,
    0,
    h - 1,
    pad(` ${model.scroll + 1}-${Math.min(model.lines.length, model.scroll + visible)}/${model.lines.length} `, w),
    { role: "foreground", prominence: FgP.secondary },
  );

  return buf;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}
