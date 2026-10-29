/**
 * Present profiles — sexy under budget.
 *
 *   local → 120fps, truecolor, full flourish
 *   ssh   → 30fps, ansi256 preferred, sparse flourish
 *
 * This is the depth SOURCE hosts read: `resolvePresentConfig().colorDepth`
 * feeds straight into `attuneTheme({depth})` (quickdraw-layout). When no
 * probe ran, the fallback is `guessColorDepth(env)` — an honest env read
 * (NO_COLOR → mono included), never a blind "ansi256 is probably fine".
 *
 * Env:
 *   QD_PROFILE=auto|local|ssh
 *   QD_FPS=<number>            force present rate
 *   QD_COLOR=auto|truecolor|ansi256|ansi16|mono
 *   QD_FLOURISH=full|sparse|off
 *   QD_SYNC=auto|0|1           (handled by host; config only prefers)
 *   NO_COLOR=<any>             honored via guessColorDepth when unprobed
 */

import { guessColorDepth, type ColorDepth } from "../capabilities/index.js";

export type Transport = "local" | "ssh";
export type ProfileName = "auto" | "local" | "ssh";
export type FlourishMode = "full" | "sparse" | "off";
export type ColorMode = "auto" | "truecolor" | "ansi256" | "ansi16" | "mono";

export type PresentConfig = {
  /** Resolved transport class (never auto). */
  profile: Transport;
  targetFps: number;
  colorDepth: ColorDepth;
  flourish: FlourishMode;
  /** Aesthetic clock Hz (braille / live tick). 0 = off. */
  flourishHz: number;
  /** Prefer DEC 2026 when terminal supports it. */
  preferSync2026: boolean;
  /** How colorDepth was chosen. */
  colorSource: "forced" | "profile" | "probe" | "default";
  /** Human summary for teardown log. */
  label: string;
};

export type ResolvePresentOpts = {
  env?: NodeJS.ProcessEnv;
  /** Probed terminal depth (before demotion). */
  probedDepth?: ColorDepth;
  /** Probed sync 2026 support. */
  probedSync2026?: boolean;
};

/** SSH-ish signals — default Profile S. */
export function detectTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  if (env.QD_PROFILE === "local") return "local";
  if (env.QD_PROFILE === "ssh") return "ssh";
  // explicit auto / unset
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "ssh";
  // mosh / remote terminal hints
  if (env.LC_SSH || env.REMOTEHOST) return "ssh";
  return "local";
}

function parseProfile(env: NodeJS.ProcessEnv): ProfileName {
  const v = (env.QD_PROFILE ?? "auto").toLowerCase();
  if (v === "local" || v === "ssh" || v === "auto") return v;
  return "auto";
}

function parseFlourish(env: NodeJS.ProcessEnv, profile: Transport): FlourishMode {
  const v = (env.QD_FLOURISH ?? "").toLowerCase();
  if (v === "full" || v === "sparse" || v === "off") return v;
  return profile === "local" ? "full" : "sparse";
}

function parseColorMode(env: NodeJS.ProcessEnv): ColorMode {
  const v = (env.QD_COLOR ?? "auto").toLowerCase();
  if (v === "auto" || v === "truecolor" || v === "ansi256" || v === "ansi16" || v === "mono") {
    return v;
  }
  return "auto";
}

/** mono is the floor: never promoted by a max cap, never itself a cap that promotes color. */
function depthRank(d: ColorDepth): number {
  if (d === "truecolor") return 3;
  if (d === "ansi256") return 2;
  if (d === "ansi16") return 1;
  return 0;
}

/** Cap depth to a maximum (e.g. ssh caps truecolor → 256). */
export function demoteDepth(have: ColorDepth, max: ColorDepth): ColorDepth {
  return depthRank(have) <= depthRank(max) ? have : max;
}

/** Aesthetic live-lane Hz (bgFx / birth / progress). Below this, stream chrome starves (glyphs freeze). */
export const DEFAULT_FLOURISH_HZ = 30;

/**
 * Live present host Hz (stream chrome + aesthetic clock injection).
 * Default **30fps** for general live behaviors (DEFAULT_LIVE_HZ).
 * Spinner glyphs still derive from wall clock at DEFAULT_SPIN_HZ inside paint
 * when callers use spinTick — this rate is "how often live lane fires".
 */
function flourishHz(mode: FlourishMode, profile: Transport): number {
  if (mode === "off") return 0;
  if (mode === "sparse") return profile === "ssh" ? 15 : 20;
  return profile === "local" ? DEFAULT_FLOURISH_HZ : 20;
}

/**
 * Resolve present config from env + probe.
 * Host applies preferSync2026 against actual probe flags separately.
 */
export function resolvePresentConfig(opts: ResolvePresentOpts = {}): PresentConfig {
  const env = opts.env ?? process.env;
  const profileName = parseProfile(env);
  const profile: Transport = profileName === "auto" ? detectTransport(env) : profileName;

  const fpsEnv = env.QD_FPS?.trim();
  const targetFps = fpsEnv
    ? Math.max(1, Math.min(240, Number(fpsEnv) || (profile === "local" ? 120 : 30)))
    : profile === "local"
      ? 120
      : 30;

  const colorMode = parseColorMode(env);
  const flourish = parseFlourish(env, profile);
  // No probe run (host skipped detectCapabilities) → fall back to the same
  // honest env guess capabilities uses, not a blind "ansi256 is probably
  // fine": this is what lets NO_COLOR reach mono even without a TTY probe.
  const probed = opts.probedDepth ?? guessColorDepth(env);

  let colorDepth: ColorDepth;
  let colorSource: PresentConfig["colorSource"];

  if (colorMode !== "auto") {
    colorDepth = colorMode;
    colorSource = "forced";
  } else if (profile === "ssh") {
    // SSH: cap at ansi256 even if terminal claims truecolor (wire budget)
    colorDepth = demoteDepth(probed, "ansi256");
    colorSource = opts.probedDepth ? "probe" : "profile";
  } else {
    colorDepth = probed;
    colorSource = opts.probedDepth ? "probe" : "default";
  }

  const preferSync2026 = env.QD_SYNC === "0" ? false : env.QD_SYNC === "1" ? true : opts.probedSync2026 !== false;

  return {
    profile,
    targetFps,
    colorDepth,
    flourish,
    flourishHz: flourishHz(flourish, profile),
    preferSync2026,
    colorSource,
    label: `${profile}@${targetFps}fps ${colorDepth} flourish=${flourish}`,
  };
}
