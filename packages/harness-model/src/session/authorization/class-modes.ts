/**
 * Per-class modes: the picker's three words for one class, written as authorization cells.
 *
 *   manual → `human`   auto → the dist auto judge   always → `allow`
 *
 * A class override holds in every permission mode; the session mode is the default for classes
 * without one. Risky classes never take `always`: they cap at `auto`, so the judge still runs.
 * Labels and the risky set copy `@inhuman.tools/policy` classes.ts (a parity test pins them).
 */
import {
  type AuthorizationConfig,
  type CellInput,
  type ClassId,
  MODES,
  type ModeTableInput,
  parseAuthorizationConfig,
} from "./config.js";
import { distAuthorization, type Resolver } from "./resolve.js";

export const CLASS_MODES = ["manual", "auto", "always"] as const;
export type ClassMode = (typeof CLASS_MODES)[number];

export const CLASS_LABELS: Readonly<Record<ClassId, string>> = {
  "destroy-catastrophic": "Destroys the machine or home",
  "destroy-local": "Discards local work",
  "vcs-history": "Rewrites history",
  privilege: "Elevates privilege",
  credential: "Touches credentials",
  "control-plane": "Changes the controls on the agent",
  "attack-shape": "Known attack shape",
  "policy-fault": "Policy fault",
  "package-install": "Installs packages",
  publish: "Publishes",
  "remote-write": "Changes remote state",
  "network-egress": "Uses the network",
  "exec-unknown": "Runs code the floor cannot see",
  unmodelled: "Not precisely modelled",
  "envelope-read": "Reads outside the workspace",
  "envelope-write": "Writes outside the workspace",
  "protected-file": "Writes a protected file",
  "workspace-write": "Writes in the workspace",
  "mcp-lookup": "MCP look-up",
  "mcp-action": "MCP action",
};

/** Classes `always` is refused for. Same set as `risky: true` in the policy taxonomy. */
export const CAPPED_CLASSES: ReadonlySet<ClassId> = new Set<ClassId>([
  "destroy-catastrophic",
  "destroy-local",
  "vcs-history",
  "privilege",
  "credential",
  "control-plane",
  "attack-shape",
  "policy-fault",
  "publish",
  "remote-write",
  "envelope-write",
]);

/** Picker groups, in display order. Every class sits in exactly one. */
export const CLASS_GROUPS: readonly { readonly title: string; readonly classes: readonly ClassId[] }[] = [
  { title: "Files", classes: ["workspace-write", "protected-file", "envelope-read", "envelope-write"] },
  { title: "Commands", classes: ["exec-unknown", "unmodelled", "package-install", "network-egress"] },
  { title: "MCP", classes: ["mcp-lookup", "mcp-action"] },
  { title: "Remote", classes: ["remote-write", "publish", "vcs-history"] },
  {
    title: "Dangerous",
    classes: [
      "destroy-local",
      "destroy-catastrophic",
      "privilege",
      "credential",
      "control-plane",
      "attack-shape",
      "policy-fault",
    ],
  },
];

export function allowedModes(id: ClassId): readonly ClassMode[] {
  return CAPPED_CLASSES.has(id) ? ["manual", "auto"] : CLASS_MODES;
}

export function capClassMode(id: ClassId, mode: ClassMode): ClassMode {
  return mode === "always" && CAPPED_CLASSES.has(id) ? "auto" : mode;
}

function cellOf(mode: ClassMode): CellInput {
  if (mode === "manual") return "human";
  if (mode === "always") return "allow";
  return distAuthorization().auto?.default ?? { judge: {} };
}

/** The word for a resolved cell. `deny` reads as manual: nothing here offers it. */
export function classModeOf(resolver: Resolver): ClassMode {
  if (resolver.kind === "allow") return "always";
  if (resolver.kind === "judge") return "auto";
  return "manual";
}

/** The override a layer holds for a class, when every mode table agrees on it. */
export function classOverrideIn(config: AuthorizationConfig | undefined, id: ClassId): ClassMode | null {
  const cells = MODES.map((mode) => config?.[mode]?.classes?.[id]);
  const first = cells[0];
  if (first === undefined || cells.some((cell) => JSON.stringify(cell) !== JSON.stringify(first))) return null;
  for (const mode of CLASS_MODES) if (JSON.stringify(cellOf(mode)) === JSON.stringify(first)) return mode;
  return null;
}

/** A copy of `config` with the class set to `mode` in every mode table, or cleared (`null`). Capped. */
export function withClassMode(
  config: AuthorizationConfig | undefined,
  id: ClassId,
  mode: ClassMode | null,
): AuthorizationConfig {
  const next: AuthorizationConfig = structuredClone(config ?? {});
  for (const key of MODES) {
    const table: ModeTableInput = { ...next[key] };
    const classes = { ...table.classes };
    if (mode === null) delete classes[id];
    else classes[id] = cellOf(capClassMode(id, mode));
    if (Object.keys(classes).length === 0) delete table.classes;
    else table.classes = classes;
    if (Object.keys(table).length === 0) delete next[key];
    else next[key] = table;
  }
  return next;
}

/** Turn any `allow` on a capped class into the auto judge. For layers a person wrote through a button. */
export function capAuthorization(config: AuthorizationConfig): AuthorizationConfig {
  let next = config;
  for (const id of CAPPED_CLASSES) {
    if (MODES.some((mode) => JSON.stringify(config[mode]?.classes?.[id]) === JSON.stringify("allow"))) {
      next = withClassMode(next, id, "auto");
    }
  }
  return next;
}

/** Parse a layer's text; an invalid or empty one is `{}`. */
export function layerConfig(text: string): AuthorizationConfig {
  const parsed = parseAuthorizationConfig(text);
  return parsed.ok ? parsed.config : {};
}

/**
 * The user layer with a per-project overlay on top: the overlay's class cells and mode defaults win,
 * its rules come first. Both layers are the user's own, so the result loosens like the user layer.
 */
export function overlayUserLayer(userText: string, projectText: string): string {
  if (projectText.trim() === "") return userText;
  const user = parseAuthorizationConfig(userText);
  // An invalid user layer stays invalid: an overlay must not hide the error and loosen.
  if (userText.trim() !== "" && !user.ok) return userText;
  const base: AuthorizationConfig = user.ok ? user.config : {};
  const top = layerConfig(projectText);
  const merged: AuthorizationConfig = { ...base };
  for (const mode of MODES) {
    const b = base[mode];
    const t = top[mode];
    if (t === undefined) continue;
    merged[mode] = { ...b, ...t, classes: { ...b?.classes, ...t.classes } };
  }
  if (top.rules !== undefined) merged.rules = [...top.rules, ...(base.rules ?? [])];
  return JSON.stringify(merged);
}
