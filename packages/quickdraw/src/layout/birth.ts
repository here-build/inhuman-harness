/**
 * Opacity wavefront — present-clock motion, same plane as spinner.
 *
 *   W  = left edge of “solid” (wavefront)
 *   T  = newest-line ink mass (older peek lanes are age-dim only)
 *
 * Prominence is distance-from-W, never band-normalized:
 *
 *   p(x) = target · falloff^max(0, x − W)   (floored at birthFloor; 0 = ground)
 *
 * While T grows, chase A = T − tipWindow and record that catch-up speed as
 * impulse. When T is frozen (or sealed), A = T and W coasts at the carried
 * impulse — no gap ease-out, no settle ramp.
 *
 * Host steps W; paint samples it. Widget constructors do not bake per-char
 * prominence or rebuild on the present tick.
 */

/** Per-column opacity multiplier past W (`target · falloff^distance`). */
export const WAVEFRONT_FALLOFF = 0.8;

export type BirthFrontierDefaults = {
  /** Rest lag behind tip while ink is hot (cols). */
  tipWindow: number;
  /** Softest prominence far past the wavefront. 0 dissolves into terminal ground. */
  birthFloor: number;
  /**
   * Per-column opacity multiplier past W (`target · falloff^distance`).
   * Default 0.8 — gentler than φ⁻¹ without a progress-bar √ shape.
   */
  falloff: number;
  /** AA width at the wavefront (cols). */
  edgeWidth: number;
  /** Base catch-up speed (cols/s) when gap≈0. */
  baseColsPerSec: number;
  /** Extra cols/s per column of gap (T−W). Hot path only. */
  gapGain: number;
  /** Cap speed (cols/s). */
  maxColsPerSec: number;
};

export const BIRTH_FRONTIER_DEFAULTS: BirthFrontierDefaults = {
  tipWindow: 12,
  birthFloor: 0,
  falloff: WAVEFRONT_FALLOFF,
  edgeWidth: 1,
  baseColsPerSec: 8,
  gapGain: 2.4,
  maxColsPerSec: 96,
};

export type BirthFrontierState = {
  /** Wavefront position W (stream columns). */
  W: number;
  /** Ink tip mass T. */
  T: number;
  lastStepMs: number | null;
  sealed: boolean;
  /** Last time T grew (ms). */
  lastAdvanceMs: number | null;
  /** Carried catch-up speed (cols/s). Endgame coasts at this. */
  v: number;
};

export type BirthFrontierInput = {
  T: number;
  nowMs: number;
  sealed?: boolean;
};

export type BirthFrontierOpts = Partial<BirthFrontierDefaults>;

export function createBirthFrontier(init?: Partial<BirthFrontierState>): BirthFrontierState {
  const T = init?.T ?? 0;
  const tipW = BIRTH_FRONTIER_DEFAULTS.tipWindow;
  const W = init?.W ?? (T > 0 ? Math.max(0, T - tipW) : 0);
  return {
    W,
    T,
    lastStepMs: init?.lastStepMs ?? null,
    sealed: init?.sealed ?? false,
    lastAdvanceMs: init?.lastAdvanceMs ?? null,
    v: init?.v ?? (T > W ? wavefrontSpeed(T - W) : 0),
  };
}

export function birthFrontierLive(state: BirthFrontierState): boolean {
  if (state.T <= 0) return false;
  return state.W + 1e-6 < state.T;
}

/**
 * Hot-path catch-up speed (cols/s): grows with gap behind tip.
 * Endgame does not call this — it coasts at the carried impulse.
 */
export function wavefrontSpeed(gap: number, opts: BirthFrontierOpts = {}): number {
  const d = { ...BIRTH_FRONTIER_DEFAULTS, ...opts };
  const g = Math.max(0, gap);
  return Math.min(d.maxColsPerSec, Math.max(0, d.baseColsPerSec + d.gapGain * g));
}

/**
 * Prominence at continuous stream position `pos`.
 *
 * Absolute distance from wavefront — **not** normalized by (T−W).
 *
 *   p = target · falloff^max(0, pos − W) , floored at birthFloor
 *
 * `T` only gates “fully solid when wavefront has sealed past ink”.
 */
export function wavefrontProminence(
  pos: number,
  W: number,
  T: number,
  targetP: number,
  opts: BirthFrontierOpts = {},
): number {
  const d = { ...BIRTH_FRONTIER_DEFAULTS, ...opts };
  const target = clamp01(targetP);
  const floor = clamp01(d.birthFloor);
  if (T <= 0) return target;
  if (W >= T - 1e-9) return target;

  const w = Math.max(0, W);
  const dist = pos - w;
  if (dist <= 0) {
    const edgeW = Math.max(1e-6, d.edgeWidth);
    if (dist <= -edgeW) return target;
    const intoSolid = -dist / edgeW;
    const t = smoothstep01(intoSolid);
    const atEdge = Math.max(floor, target);
    return target * t + atEdge * (1 - t);
  }

  const base = Math.min(0.999, Math.max(1e-6, d.falloff));
  const raw = target * Math.pow(base, dist);
  return Math.max(floor, Math.min(target, raw));
}

/** Step wavefront. Pure. */
export function stepBirthFrontier(
  state: BirthFrontierState,
  input: BirthFrontierInput,
  opts: BirthFrontierOpts = {},
): BirthFrontierState {
  const d = { ...BIRTH_FRONTIER_DEFAULTS, ...opts };
  const T = Math.max(0, input.T);
  const nowMs = input.nowMs;
  const sealed = input.sealed === true || state.sealed;

  let W = state.W;
  let v = state.v ?? 0;
  let lastAdvanceMs = state.lastAdvanceMs;
  const tipGrew = T > state.T + 1e-9;
  const tipShrunk = T < state.T - 1e-9;

  if (tipGrew || lastAdvanceMs == null) lastAdvanceMs = nowMs;
  // New peek line: T drops to the overflow. Restart from the left; keep
  // impulse so the new line coasts at the speed the last one had.
  if (tipShrunk) W = 0;

  const frozen = sealed || !tipGrew;
  const lag = frozen || T <= d.tipWindow ? 0 : d.tipWindow;
  const A = Math.max(0, T - lag);

  if (state.lastStepMs == null) {
    W = sealed ? T : Math.max(0, T - d.tipWindow);
    v = wavefrontSpeed(T - W, d);
  } else {
    const dtSec = Math.min(0.25, Math.max(0, (nowMs - state.lastStepMs) / 1000));
    // Refresh impulse only while actually catching up. Parked-in-lag and
    // frozen ticks keep the last speed so endgame does not ease out.
    if ((!frozen && A > W) || v <= 0) v = wavefrontSpeed(T - W, d);
    if (dtSec > 0 && A > W) W = Math.min(A, W + v * dtSec);
  }

  W = clamp(W, 0, T);
  // SNAP-TO-T: 0.15 live / 0.5 sealed so `birthFrontierLive` (`W + 1e-6 < T`)
  // can go false. Without the snap, float crawl keeps that true and the
  // flourish timer never dies.
  if (T - W < (sealed ? 0.5 : 0.15)) W = T;

  return {
    W,
    T,
    lastStepMs: nowMs,
    sealed,
    lastAdvanceMs,
    v,
  };
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
