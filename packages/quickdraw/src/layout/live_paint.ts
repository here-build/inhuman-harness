/**
 * Live paint — predetermined motion owned by the render layer.
 *
 * Logic declares **intent** (`spinner` / `elapsed` / `countdown` / `quota`); paint
 * resolves glyphs and labels from wall clock. Present reads {@link LiveDemand}
 * from the Frame to choose Hz — fps-on-demand, not a global fixed aesthetic loop.
 *
 * Braille frames, spin rates, and duration formatting live **here only**.
 * Callers never pass tick indices or braille strings.
 */

import type { Positioned } from "./types.js";

/** Named spinner profiles — semantics, not glyphs. */
export type SpinnerProfile = "thinking" | "tool" | "working";

/**
 * Subscription window for the Cmd/Ctrl status overlay. Paint owns remaining
 * duration from {@link resetAt}; producers never send a spelled string.
 */
export type ChromeQuotaWindow = {
  remainingPercent: number;
  /** Unix seconds when this window resets. */
  resetAt?: number;
};

/**
 * Live decoration kind on a paint op / gutter.
 * - spinner: single-cell rotating glyph
 * - elapsed: compact duration from startedAt (label text)
 * - countdown: remaining seconds until retryUntilMs
 * - quota: remaining windows from resetAt (status-rail overlay)
 * - birth: opacity wavefront over source text (W is host-stepped)
 */
export type LivePaint =
  | {
      kind: "spinner";
      profile: SpinnerProfile;
      /** Target present Hz for this decoration */
      hz: number;
    }
  | {
      kind: "elapsed";
      startedAt: number;
      /** Prefix e.g. "thinking · " */
      prefix?: string;
      /** Stem before ` · duration`. Default `thinking`. */
      label?: string;
      hz: number;
    }
  | {
      kind: "countdown";
      untilMs: number;
      hz: number;
    }
  | {
      kind: "quota";
      windows: readonly ChromeQuotaWindow[];
      /** Static occupancy prefix, e.g. `10k/500k`. Paint joins it with remaining. */
      prefix?: string;
      hz: number;
    }
  | {
      kind: "birth";
      /** Host frontier key (usually the stream's layout key). */
      siteId: string;
      /** Stream ink mass T. */
      T: number;
      /** This line's start on the stream axis. */
      offset: number;
      /** Prominence left of W. */
      target: number;
      birthFloor: number;
      falloff: number;
      tipWindow: number;
      /**
       * 0 — host arms present from {@link birthFrontierLive}, not this op.
       * A non-zero hz here would keep ticking after W catches T.
       */
      hz: number;
    };

export type LiveDemand = {
  /** Max Hz among all live ops in the frame (0 = nothing live). */
  maxHz: number;
  /** Counts by kind (debug / metrics). */
  spinners: number;
  elapsed: number;
  quota: number;
  birth: number;
};

/** Default Hz per profile — present takes max across frame. */
export const SPINNER_HZ: Record<SpinnerProfile, number> = {
  thinking: 12,
  tool: 12,
  working: 10,
};

/** Glyph alphabets — paint-only; never export to model/logic APIs. */
const SPINNER_GLYPHS: Record<SpinnerProfile, string> = {
  thinking: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  tool: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  working: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
};

export function spinnerLive(profile: SpinnerProfile = "working"): Extract<LivePaint, { kind: "spinner" }> {
  return {
    kind: "spinner",
    profile,
    hz: SPINNER_HZ[profile],
  };
}

export function elapsedLive(
  startedAt: number,
  opts?: { prefix?: string; label?: string; hz?: number },
): Extract<LivePaint, { kind: "elapsed" }> {
  return {
    kind: "elapsed",
    startedAt,
    prefix: opts?.prefix,
    label: opts?.label,
    hz: opts?.hz ?? 2, // 2Hz is enough for second-granularity labels
  };
}

/** Layout measure for {@link formatRetryCountdown}; 999 is the width cap. */
export const RETRY_COUNTDOWN_MEASURE = "Failed to request; retrying in 999 seconds";

export function formatRetryCountdown(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return `Failed to request; retrying in ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function retryCountdownLive(untilMs: number): Extract<LivePaint, { kind: "countdown" }> {
  return {
    kind: "countdown",
    untilMs,
    hz: 2,
  };
}

/** 1Hz is enough for minute-rounding remaining labels. */
export function quotaLive(
  windows: readonly ChromeQuotaWindow[],
  opts?: { hz?: number; prefix?: string },
): Extract<LivePaint, { kind: "quota" }> {
  const prefix = (opts?.prefix ?? "").trim();
  return {
    kind: "quota",
    windows,
    ...(prefix === "" ? {} : { prefix }),
    hz: opts?.hz ?? 1,
  };
}

/** Compact token count: `999`, `1.5k`, `10k`, `500k`. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const x = Math.round(n);
  if (x < 1000) return `${x}`;
  const k = x / 1000;
  if (k < 10) {
    const tenths = (Math.round(k * 10) / 10).toFixed(1);
    return tenths.endsWith(".0") ? `${tenths.slice(0, -2)}k` : `${tenths}k`;
  }
  return `${Math.round(k)}k`;
}

/** `10k/500k`. Empty when neither used nor a window exists. A known window paints `0/500k`. */
export function formatContextOccupancy(used: number, limit: number): string {
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const hasUsed = Number.isFinite(used) && used > 0;
  if (!hasLimit && !hasUsed) return "";
  if (!hasLimit) return formatTokenCount(used);
  return `${formatTokenCount(Number.isFinite(used) && used > 0 ? used : 0)}/${formatTokenCount(limit)}`;
}

/** Occupancy prefix joined with live remaining, e.g. `10k/500k · 51% left for 5 hours`. */
export function formatHeldStatus(prefix: string, windows: readonly ChromeQuotaWindow[], nowMs: number): string {
  const occupancy = prefix.trim();
  const quota = formatQuotaWindows(windows, nowMs);
  if (occupancy === "") return quota;
  return quota === "" ? occupancy : `${occupancy} · ${quota}`;
}

/**
 * Narrow rails drop the spelled quota and keep occupancy. Occupancy is the
 * shorter chip (`10k/500k`); the full hint is `occupancy · 51% left for …`.
 * A rail with no occupancy has nothing shorter to fall back to.
 */
export function formatHeldStatusFit(
  prefix: string,
  windows: readonly ChromeQuotaWindow[],
  nowMs: number,
  maxColumns: number,
  measure: (text: string) => number,
): string {
  const full = formatHeldStatus(prefix, windows, nowMs);
  if (maxColumns <= 0 || measure(full) <= maxColumns) return full;
  const occupancy = prefix.trim();
  if (occupancy === "" || occupancy === full) return full;
  return measure(occupancy) <= maxColumns ? occupancy : full;
}

export function birthLive(opts: {
  siteId: string;
  T: number;
  offset: number;
  target: number;
  birthFloor: number;
  falloff: number;
  tipWindow: number;
}): Extract<LivePaint, { kind: "birth" }> {
  return {
    kind: "birth",
    siteId: opts.siteId,
    T: opts.T,
    offset: opts.offset,
    target: opts.target,
    birthFloor: opts.birthFloor,
    falloff: opts.falloff,
    tipWindow: opts.tipWindow,
    hz: 0,
  };
}

/** Resolve spinner glyph for wall clock (ms). */
export function resolveSpinnerGlyph(profile: SpinnerProfile, nowMs: number): string {
  const frames = SPINNER_GLYPHS[profile] ?? SPINNER_GLYPHS.working;
  if (frames.length === 0) return "·";
  const hz = SPINNER_HZ[profile] ?? 10;
  const i = Math.floor((Math.max(0, nowMs) * hz) / 1000) % frames.length;
  return frames[i] ?? frames[0]!;
}

/** Compact duration — paint-side only. */
export function formatElapsedCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 1) return "<1s";
  if (s < 60) {
    // In-motion: always one tenth so `3.0s` does not collapse to `3s`
    // and shift the ghost overlay.
    return `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Spelled remaining duration. Same grammar as connect.scm `paint-reset`:
 * nearest minute; skip a leftover 1 minute at hour scale; 59 minutes rounds
 * up; days keep leftover hours, not minutes.
 */
export function formatRemainingSpelled(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";
  const s = Math.max(0, Math.round(remainingMs / 1000));
  const mins = s === 0 ? 0 : Math.max(1, Math.trunc((s + 30) / 60));
  if (mins === 0) return "";
  if (mins < 60) return countWord(mins, "minute");
  if (mins < 1440) {
    const h = Math.trunc(mins / 60);
    const m = mins % 60;
    if (m === 0 || m === 1) return hoursPhrase(h);
    if (m === 59) return hoursPhrase(h + 1);
    return `${countWord(h, "hour")} and ${countWord(m, "minute")}`;
  }
  const d = Math.trunc(mins / 1440);
  const h = Math.trunc((mins % 1440) / 60);
  if (h === 0) return countWord(d, "day");
  return `${countWord(d, "day")} and ${countWord(h, "hour")}`;
}

export function formatQuotaWindows(windows: readonly ChromeQuotaWindow[], nowMs: number): string {
  const bits: string[] = [];
  for (const window of windows) {
    const bit = formatQuotaWindow(window, nowMs);
    if (bit !== "") bits.push(bit);
  }
  return bits.join(" · ");
}

function formatQuotaWindow(window: ChromeQuotaWindow, nowMs: number): string {
  if (!Number.isFinite(window.remainingPercent)) return "";
  const left = `${Math.round(Math.max(0, window.remainingPercent))}%`;
  if (window.resetAt == null || !Number.isFinite(window.resetAt)) return left;
  // A reset deadline expires the snapshot, not just its countdown. Keep the
  // window hidden until the provider reports fresh usage; assuming 100% here
  // would also be wrong if another client has already consumed the new window.
  if (window.resetAt * 1000 <= nowMs) return "";
  const until = formatRemainingSpelled(window.resetAt * 1000 - nowMs);
  return until === "" ? left : `${left} left for ${until}`;
}

function countWord(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function hoursPhrase(h: number): string {
  return h >= 24 ? countWord(Math.trunc(h / 24), "day") : countWord(h, "hour");
}

/** Resolve live op to display string at nowMs. Birth is style, not a label. */
export function resolveLiveText(live: LivePaint, nowMs: number): string {
  if (live.kind === "spinner") {
    return resolveSpinnerGlyph(live.profile, nowMs);
  }
  if (live.kind === "birth") return "";
  if (live.kind === "quota") {
    return formatHeldStatus(live.prefix ?? "", live.windows, nowMs);
  }
  if (live.kind === "countdown") {
    return formatRetryCountdown(live.untilMs, nowMs);
  }
  const elapsed = Math.max(0, nowMs - live.startedAt);
  const label = live.label ?? "thinking";
  const body = elapsed < 500 ? label : `${label} · ${formatElapsedCompact(elapsed)}`;
  return live.prefix == null ? body : `${live.prefix}${formatElapsedCompact(elapsed)}`;
}

/** Scan paint order for live demand (after layout). */
export function collectLiveDemand(paintOrder: readonly Positioned[]): LiveDemand {
  let maxHz = 0;
  let spinners = 0;
  let elapsed = 0;
  let quota = 0;
  let birth = 0;
  for (const pos of paintOrder) {
    for (const op of pos.paint) {
      if (op.kind !== "live") continue;
      maxHz = Math.max(maxHz, op.live.hz);
      switch (op.live.kind) {
        case "spinner": {
          spinners += 1;
          break;
        }
        case "elapsed":
        case "countdown": {
          elapsed += 1;
          break;
        }
        case "quota": {
          quota += 1;
          break;
        }
        default:
          birth += 1;
      }
    }
  }
  return { maxHz, spinners, elapsed, quota, birth };
}
