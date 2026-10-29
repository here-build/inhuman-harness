/**
 * ShadowStream — labeled, height-bounded, gradient-faded window over a live
 * text stream (`ShadowStream`, 2026-07-18).
 *
 * Render-side only: pure `LayoutNode` construction. Caller owns state cycle
 * and collapse. Not a "thinking" feature — any streaming process with a header
 * you want to peek-bound (thinking / searching / compiling / log tail).
 *
 * ## Dominating primitive
 *
 * Always rendered, always at `base` prominence. What changes is how much of
 * the stream is shown.
 *
 * ## Three states
 *
 * - `fully_collapsed` — only the primitive (`▸ thinking`).
 * - `peek` — the shadow window (default live render).
 * - `expanded` — `▾ primitive` + full lines (caller may wrap in a rule gutter).
 *
 * ## Peek shadow (two axes)
 *
 * Paint dissolves FG toward local surface / theme ground. Axes:
 *
 * 1. **Vertical age (lanes):** each body row is **full-width uniform** dim by
 *    age — oldest darkest, gradually de-dims toward newest (`kLine`). Older
 *    lanes never get a horizontal birth ramp.
 * 2. **Opacity wavefront:** host steps wavefront `W` on the newest line only.
 *    Full left of W, gradient after W. Older lanes never wait for W.
 * 3. **Squeeze oldest:** primitive at `base` + per-char horizontal dissolve
 *    on the oldest tail (`floor → shadowCap`).
 *
 * Peek always ghost-overlays the oldest visible line onto the primitive row.
 * One-line peek: that row is also the birth tip. Taller peeks: oldest
 * squeezes; middle lanes age; newest carries the wavefront.
 */

import { Text } from "./text.js";
import { BIRTH_FRONTIER_DEFAULTS, type LayoutNode, birthLive, type LivePaint } from "../layout/index.js";
import type { SemanticRole } from "../lexicon/index.js";
import { displayWidth, splitAtWidth } from "../measure/index.js";

export type ShadowStreamState = "fully_collapsed" | "peek" | "expanded";

export type ShadowStreamProps = {
  /** Dominating label — "thinking", "searching", a translation, … */
  primitive?: string;
  /** Stream body as string (split on `\n`) or pre-split lines. */
  lines?: string | readonly string[];
  state?: ShadowStreamState;
  width?: number;
  /** Peek window height in lines (default 3). */
  height?: number;
  /** Newest-line / primitive prominence (default 0.6). */
  base?: number;
  floor?: number;
  /** Horizontal fade ceiling on the squeezed oldest tail (default 0.4). */
  shadowCap?: number;
  /** Softest tip prominence after the wavefront. */
  birthFloor?: number;
  /** Rest lag of wavefront behind tip when hot. */
  tipWindow?: number;
  /** Role for all stream paint (default muted). */
  role?: SemanticRole;
  /**
   * Local surface the stream sits on — FG opacity dissolves toward this
   * furniture (e.g. `surface` + BgP.panel when inside a Panel), not theme
   * ground. Omit on transparent transcript cells (theme ground is correct).
   */
  surfaceRole?: SemanticRole;
  /** Solidity of surfaceRole (default 1 / solid). */
  surfaceProminence?: number;
  key?: string;
  collapsedIcon?: string;
  expandedIcon?: string;
  /** Live paint on the primitive (e.g. elapsed label). */
  primitiveLive?: LivePaint;
  /**
   * Newest-line opacity wavefront. Off by default — peek paints at age
   * prominence as-is. Pass true to crawl W on the newest line.
   */
  wavefront?: boolean;
  /**
   * When true, expanded body is left empty (caller supplies markdown etc.).
   * Default false: plain lines at base prominence.
   */
  expandedBodyExternal?: boolean;
};

/** Defaults match ShadowStream module attrs + birth-band audit pins. */
const SHADOW_STREAM_DEFAULTS = {
  primitive: "thinking",
  height: 3,
  base: 0.6,
  /** Full-width age floor for oldest lane (clearly dimmer than mid). */
  floor: 0.12,
  shadowCap: 0.4,
  birthFloor: BIRTH_FRONTIER_DEFAULTS.birthFloor,
  /** Vertical age: >1 = older lanes darker. */
  kLine: 1.25,
  kChar: 1.5,
  falloff: BIRTH_FRONTIER_DEFAULTS.falloff,
  gap: 3,
  ellipsis: "…",
  role: "muted" as SemanticRole,
  collapsedIcon: "▸",
  expandedIcon: "▾",
} as const;

type Norm = {
  primitive: string;
  lines: string[];
  state: ShadowStreamState;
  width: number;
  height: number;
  base: number;
  floor: number;
  shadowCap: number;
  birthFloor: number;
  tipWindow: number;
  role: SemanticRole;
  surfaceRole?: SemanticRole;
  surfaceProminence?: number;
  key: string;
  collapsedIcon: string;
  expandedIcon: string;
  primitiveLive?: LivePaint;
  wavefront: boolean;
  expandedBodyExternal: boolean;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/** Default tip window from layout width (aesthetic; distance still uses ink W). */
function defaultTipWindow(layoutWidth: number): number {
  const w = Math.max(8, layoutWidth);
  return Math.min(16, Math.max(8, Math.round(w / 4)));
}

function normalize(props: ShadowStreamProps): Norm {
  const d = SHADOW_STREAM_DEFAULTS;
  const width = Math.max(8, props.width ?? 48);
  const floor = clamp01(props.floor ?? d.floor);
  const birthFloor = clamp01(props.birthFloor ?? d.birthFloor);
  return {
    primitive: props.primitive ?? d.primitive,
    lines: toLines(props.lines),
    state: props.state ?? "peek",
    width,
    height: Math.max(1, props.height ?? d.height),
    base: clamp01(props.base ?? d.base),
    floor,
    shadowCap: clamp01(props.shadowCap ?? d.shadowCap),
    birthFloor,
    tipWindow: Math.max(1, props.tipWindow ?? defaultTipWindow(width)),
    role: props.role ?? d.role,
    surfaceRole: props.surfaceRole,
    surfaceProminence: props.surfaceProminence,
    key: props.key ?? "shadow",
    collapsedIcon: props.collapsedIcon ?? d.collapsedIcon,
    expandedIcon: props.expandedIcon ?? d.expandedIcon,
    primitiveLive: props.primitiveLive,
    wavefront: props.wavefront === true,
    expandedBodyExternal: props.expandedBodyExternal === true,
  };
}

function toLines(text: string | readonly string[] | undefined): string[] {
  if (text == null) return [];
  if (Array.isArray(text)) {
    return text.filter((l) => typeof l === "string" && l.length > 0);
  }
  if (typeof text !== "string") return [];
  return text.split("\n").filter((l) => l.length > 0);
}

/**
 * Vertical prominence by age: age 0 (newest) = base; older → floor over
 * height-1 steps, slightly exponential (`@k_line`).
 */
function ageProminence(age: number, opts: { height: number; base: number; floor: number; kLine?: number }): number {
  if (age <= 0) return opts.base;
  const denom = Math.max(opts.height - 1, 1);
  const t = Math.max(1 - age / denom, 0);
  const k = opts.kLine ?? SHADOW_STREAM_DEFAULTS.kLine;
  return opts.floor + (opts.base - opts.floor) * Math.pow(t, k);
}

/**
 * Horizontal prominence on the **oldest** squeeze tail: col 0 (left /
 * consumed) = floor, rising to shadowCap at region right edge (`kChar`).
 */
function charProminence(
  col: number,
  region: number,
  opts: { floor: number; shadowCap: number; kChar?: number },
): number {
  if (region <= 1) return opts.floor;
  const t = Math.min(col / (region - 1), 1);
  const k = opts.kChar ?? SHADOW_STREAM_DEFAULTS.kChar;
  return Math.min(opts.floor + (opts.shadowCap - opts.floor) * Math.pow(t, k), opts.shadowCap);
}

function textNode(
  content: string,
  key: string,
  role: SemanticRole,
  prominence: number,
  extra?: {
    live?: LivePaint;
    bold?: boolean;
    surfaceRole?: SemanticRole;
    surfaceProminence?: number;
  },
): LayoutNode {
  return Text(content, {
    key,
    whiteSpace: "nowrap",
    style: {
      role,
      prominence,
      bold: extra?.bold,
      surfaceRole: extra?.surfaceRole,
      surfaceProminence: extra?.surfaceRole ? (extra.surfaceProminence ?? 1) : undefined,
    },
    live: extra?.live,
  });
}

function surfaceExtra(p: Norm): {
  surfaceRole?: SemanticRole;
  surfaceProminence?: number;
} {
  if (!p.surfaceRole) return {};
  return {
    surfaceRole: p.surfaceRole,
    surfaceProminence: p.surfaceProminence ?? 1,
  };
}

/**
 * Keep the tail that fits `region` display columns; overflow prefix → `…`.
 */
function fitTail(line: string, region: number): string {
  const r = Math.max(1, region);
  if (displayWidth(line) <= r) return line;
  const keep = Math.max(r - 1, 0);
  const total = displayWidth(line);
  const drop = Math.max(total - keep, 0);
  const [, kept] = splitAtWidth(line, drop);
  return SHADOW_STREAM_DEFAULTS.ellipsis + kept;
}

type SpanOpts = {
  role: SemanticRole;
  key: string;
  surfaceRole?: SemanticRole;
  surfaceProminence?: number;
  /**
   * When false, one text node per grapheme (birth tip). Default true merges
   * equal-p runs (squeeze dissolve). Coalescing + 8-bit RGB made soft-tip
   * letters hop in lockstep clusters.
   */
  coalesce?: boolean;
  /**
   * Desync 8-bit fade steps per column so adjacent letters don't cross the
   * same RGB threshold on the same frame (cluster hop).
   */
  quantizeStagger?: boolean;
};

/**
 * Micro-offset so column `col` quantizes RGB on a different phase.
 * ~±½ of an 8-bit step over a typical muted fade span — invisible as
 * structure, enough to break lockstep hops.
 */
function staggerProminence(p: number, col: number): number {
  // Golden-ratio phase in [0,1)
  const phase = (col * 0.618_033_988_7) % 1;
  // ±~1/160 on prominence — enough that adjacent letters rarely share an
  // 8-bit RGB step boundary when W crawls (cluster hop → letter crawl).
  const delta = (phase - 0.5) * (1 / 80);
  return Math.min(1, Math.max(0, p + delta));
}

/** Coalesce adjacent equal-prominence grapheme runs into text nodes. */
function spansFromProminence(
  line: string,
  prominenceAtCol: (leadingCol: number, trailingDistFromEnd: number) => number,
  opts: SpanOpts,
): LayoutNode[] {
  const chars = [...line];
  if (chars.length === 0) return [];
  const inkW = displayWidth(line);
  const coalesce = opts.coalesce !== false;
  const stagger = opts.quantizeStagger === true;
  type Run = { text: string; p: number };
  const runs: Run[] = [];
  let col = 0;
  for (const g of chars) {
    const gW = displayWidth(g);
    // Trailing edge of this grapheme: distance from ink end.
    const trailingDist = Math.max(inkW - (col + gW), 0);
    let p = prominenceAtCol(col, trailingDist);
    if (stagger) p = staggerProminence(p, col);
    const last = runs.at(-1);
    if (coalesce && last && Math.abs(last.p - p) < 1e-6) {
      last.text += g;
    } else {
      runs.push({ text: g, p });
    }
    col += gW;
  }
  const surf = opts.surfaceRole
    ? {
        surfaceRole: opts.surfaceRole,
        surfaceProminence: opts.surfaceProminence ?? 1,
      }
    : {};
  return runs.map((run, i) => textNode(run.text, `${opts.key}:c${i}`, opts.role, run.p, surf));
}

/** Per-char horizontal fade on squeeze oldest tail (left→right dissolve). */
function fadeSpans(
  tail: string,
  region: number,
  opts: {
    role: SemanticRole;
    key: string;
    floor: number;
    shadowCap: number;
    surfaceRole?: SemanticRole;
    surfaceProminence?: number;
  },
): LayoutNode[] {
  return spansFromProminence(
    tail,
    (col) =>
      charProminence(col, region, {
        floor: opts.floor,
        shadowCap: opts.shadowCap,
      }),
    opts,
  );
}

/** Primitive + oldest (or only) body on one row — the ghost overlay. */
function headerRow(p: Norm, line: string, opts?: { streamBirth?: { T: number; offset: number } }): LayoutNode {
  const primW = displayWidth(p.primitive);
  const gap = SHADOW_STREAM_DEFAULTS.gap;
  const region = Math.max(p.width - primW - gap, 1);
  const tail = fitTail(line, region);
  const surf = surfaceExtra(p);
  const tailNodes = opts?.streamBirth
    ? [
        lineNode(p, tail, 0, `${p.key}:shadow`, {
          streamBirth: opts.streamBirth,
        }),
      ]
    : fadeSpans(tail, region, {
        role: p.role,
        key: `${p.key}:shadow`,
        floor: p.floor,
        shadowCap: p.shadowCap,
        ...surf,
      });
  return {
    type: "flex",
    key: `${p.key}:sq`,
    style: { direction: "row", gap: 0, width: p.width },
    children: [
      textNode(p.primitive, `${p.key}:prim`, p.role, p.base, {
        live: p.primitiveLive,
        bold: true,
        ...surf,
      }),
      textNode(" ".repeat(gap), `${p.key}:gap`, p.role, p.floor, surf),
      ...tailNodes,
    ],
  };
}

/**
 * Body line: full-width **uniform** age dim, or newest-line birth tip.
 * Older lanes never get horizontal birth ramps — only age.
 */
function lineNode(
  p: Norm,
  line: string,
  age: number,
  key: string,
  opts: {
    /** Newest line: declare birth; paint samples W. */
    streamBirth?: { T: number; offset: number };
  },
): LayoutNode {
  const surf = surfaceExtra(p);
  const targetP = ageProminence(age, p);
  if (!opts.streamBirth) {
    return textNode(line, key, p.role, targetP, surf);
  }
  return textNode(line, key, p.role, targetP, {
    ...surf,
    live: birthLive({
      siteId: p.key,
      T: opts.streamBirth.T,
      offset: opts.streamBirth.offset,
      target: targetP,
      birthFloor: p.birthFloor,
      falloff: BIRTH_FRONTIER_DEFAULTS.falloff,
      tipWindow: p.tipWindow,
    }),
  });
}

/** Newest-line mass. Offset 0 — W is local to this line. */
function newestStreamBirth(_p: Norm, body: readonly string[]): { T: number; offset: number } | undefined {
  if (body.length === 0) return undefined;
  const last = body.at(-1)!;
  return { T: displayWidth(last), offset: 0 };
}

function peekChildren(p: Norm): LayoutNode[] {
  const n = p.lines.length;
  const surf = surfaceExtra(p);
  if (n === 0) {
    return [
      textNode(p.primitive, `${p.key}:prim`, p.role, p.base, {
        live: p.primitiveLive,
        bold: true,
        ...surf,
      }),
    ];
  }

  const window = p.lines.slice(-p.height);
  const len = window.length;
  const oldest = window[0]!;
  const rest = window.slice(1);
  const birth = newestStreamBirth(p, window);

  if (rest.length === 0) {
    return [
      headerRow(p, oldest, {
        streamBirth: p.wavefront ? birth : undefined,
      }),
    ];
  }

  const restRows = rest.map((line, i) => {
    const age = len - 2 - i;
    const isNewest = age === 0;
    return lineNode(p, line, Math.max(age, 0), `${p.key}:l${i + 1}`, {
      streamBirth: isNewest && p.wavefront ? birth : undefined,
    });
  });
  return [headerRow(p, oldest), ...restRows];
}

/**
 * Pure LayoutNode tree for a ShadowStream.
 * Root is a column flex; does not wrap Indication — caller composes.
 */
export function ShadowStream(props: ShadowStreamProps = {}): LayoutNode {
  const p = normalize(props);
  let kids: LayoutNode[];

  const surf = surfaceExtra(p);
  switch (p.state) {
    case "fully_collapsed":
      kids = [
        textNode(`${p.collapsedIcon} ${p.primitive}`, `${p.key}:prim`, p.role, p.base, {
          live: p.primitiveLive,
          bold: true,
          ...surf,
        }),
      ];
      break;
    case "expanded":
      // No tip rubber-band — peek-only feature (audit S6).
      kids = [
        textNode(`${p.expandedIcon} ${p.primitive}`, `${p.key}:prim`, p.role, p.base, {
          live: p.primitiveLive,
          bold: true,
          ...surf,
        }),
      ];
      if (!p.expandedBodyExternal) {
        for (let i = 0; i < p.lines.length; i++) {
          kids.push(textNode(p.lines[i]!, `${p.key}:x${i}`, p.role, p.base, surf));
        }
      }
      break;
    case "peek":
      kids = peekChildren(p);
      break;
  }

  return {
    type: "flex",
    key: p.key,
    style: { direction: "column", gap: 0, width: p.width },
    children: kids,
  };
}
