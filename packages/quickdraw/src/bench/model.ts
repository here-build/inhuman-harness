/**
 * Experiment model: scrollable log + side panel + clock + optional CPU burn.
 * Shared types for worker and main (view runs on main).
 */

export type Msg =
  | { type: "tick"; now: number }
  | { type: "key"; key: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "append_burst"; count: number }
  | { type: "set_burn"; ms: number };

export type Model = {
  cols: number;
  rows: number;
  /** monologue log lines */
  lines: string[];
  scroll: number; // first visible line index
  now: number;
  tick: number;
  /** artificial load in update (ms busy-loop) to prove render isolation */
  burnMs: number;
  paused: boolean;
};

const MAX_LINES = 5000;

export function init(cols: number, rows: number): Model {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines.push(seedLine(i));
  }
  return {
    cols,
    rows,
    lines,
    scroll: 0,
    now: Date.now(),
    tick: 0,
    burnMs: 0,
    paused: false,
  };
}

function seedLine(i: number): string {
  return `[${String(i).padStart(4, "0")}] event payload ${"·".repeat((i % 40) + 1)} id=${(i * 2_654_435_761) >>> 0}`;
}

function busy(ms: number): void {
  if (ms <= 0) return;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* spin — intentional load on logic thread only */
  }
}

export function update(msg: Msg, model: Model): Model {
  if (model.burnMs > 0 && msg.type !== "set_burn") {
    busy(model.burnMs);
  }

  switch (msg.type) {
    case "resize":
      return { ...model, cols: msg.cols, rows: msg.rows };
    case "tick": {
      if (model.paused) return { ...model, now: msg.now };
      const nextTick = model.tick + 1;
      const line = seedLine(model.lines.length);
      const lines = model.lines.length >= MAX_LINES ? model.lines.slice(1).concat(line) : model.lines.concat(line);
      // auto-follow if near bottom
      const visible = Math.max(1, model.rows - 4);
      const atBottom = model.scroll >= lines.length - visible - 1;
      const scroll = atBottom ? Math.max(0, lines.length - visible) : model.scroll;
      return {
        ...model,
        now: msg.now,
        tick: nextTick,
        lines,
        scroll,
      };
    }
    case "key":
      return handleKey(msg.key, model);
    case "append_burst": {
      const extra: string[] = [];
      for (let i = 0; i < msg.count; i++) {
        extra.push(seedLine(model.lines.length + i));
      }
      let lines = model.lines.concat(extra);
      if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
      const visible = Math.max(1, model.rows - 4);
      return {
        ...model,
        lines,
        scroll: Math.max(0, lines.length - visible),
      };
    }
    case "set_burn":
      return { ...model, burnMs: Math.max(0, msg.ms) };
    default:
      return model;
  }
}

function handleKey(key: string, model: Model): Model {
  const visible = Math.max(1, model.rows - 4);
  const maxScroll = Math.max(0, model.lines.length - visible);
  switch (key) {
    case "q":
    case "\u0003": // ctrl-c
      // main handles exit; model unchanged
      return model;
    case " ":
      return { ...model, paused: !model.paused };
    case "j":
    case "\u001B[B": // down
      return { ...model, scroll: Math.min(maxScroll, model.scroll + 1) };
    case "k":
    case "\u001B[A": // up
      return { ...model, scroll: Math.max(0, model.scroll - 1) };
    case "g":
      return { ...model, scroll: 0 };
    case "G":
      return { ...model, scroll: maxScroll };
    case "b":
      // toggle 5ms burn on logic thread
      return { ...model, burnMs: model.burnMs > 0 ? 0 : 5 };
    case "B":
      return { ...model, burnMs: model.burnMs >= 20 ? 0 : 20 };
    case "a":
      return update({ type: "append_burst", count: 100 }, model);
    default:
      return model;
  }
}
