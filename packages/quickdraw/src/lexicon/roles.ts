/**
 * Semantic roles — hue carries identity ("who is speaking"), never hierarchy.
 * Hierarchy is the lightness axis (tier × prominence); state changes move
 * along lightness, identity stays on hue. A disabled item is its role at
 * `whisper` prominence, not a different role.
 *
 * Roles group into five families (the metaphor system):
 *
 * - **voice**      — the content speaking: itself (`foreground`), as an aside
 *                    (`muted`), raised (`emphasis`), or verbatim (`code` —
 *                    azure, body-weight; unspecified / unhighlighted source).
 * - **furniture**  — the room: stagehand text (`chrome`), walls (`border`),
 *                    floors (`surface`). Distinguished from voices by tier
 *                    (recede), never by hue.
 * - **signal**     — states of the world, the absolute grammar: red = broken
 *                    (`error`), orange = caution (`warning`), green = go
 *                    (`success`), magenta = machine-in-flux (`running`) —
 *                    deliberately the one unnatural hue: a process-state
 *                    outside the natural world-state grammar — plus the two
 *                    unsupervised permission postures, which own their own
 *                    hues so they cannot steal warning/error: blue 211
 *                    classifier-on (`auto`), yellow 110 look-here (`attention`).
 * - **affordance** — where attention can go (`accent`). Links are
 *                    accent + underline; selection is accent-hued atmosphere
 *                    (see quickdraw-theme selection.ts).
 * - **delta**      — change itself (`diff_add`, `diff_del`): success/error hue
 *                    families at reading chroma, because diffs are read at
 *                    length while signals are glanced.
 */

export type SemanticRole =
  | "foreground"
  | "accent"
  | "error"
  | "warning"
  | "success"
  | "emphasis"
  | "muted"
  | "border"
  | "chrome"
  | "surface"
  | "code"
  | "diff_add"
  | "diff_del"
  | "running"
  | "auto"
  | "attention";

export type RoleFamily = "voice" | "furniture" | "signal" | "affordance" | "delta";

export const ROLE_FAMILY: Record<SemanticRole, RoleFamily> = {
  foreground: "voice",
  muted: "voice",
  emphasis: "voice",
  code: "voice",
  chrome: "furniture",
  border: "furniture",
  surface: "furniture",
  error: "signal",
  warning: "signal",
  success: "signal",
  running: "signal",
  auto: "signal",
  attention: "signal",
  accent: "affordance",
  diff_add: "delta",
  diff_del: "delta",
};

/** Every role, in declaration order. */
export const ALL_ROLES = Object.keys(ROLE_FAMILY) as readonly SemanticRole[];

/** Membership check for unvalidated strings (resolver guard). */
export const ROLES: ReadonlySet<string> = new Set(ALL_ROLES);
