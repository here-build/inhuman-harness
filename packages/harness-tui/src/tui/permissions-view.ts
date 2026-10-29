/**
 * `/permissions`: what the session may do right now, as text. A pure view-model (data in, lines out)
 * beside a thin surface builder; Tea does the RPC glue. Read-only except revoke.
 *
 * Sections: mode and the resolver each class gets, stored grants, acknowledgements (flags in force and
 * stored acks), and the answer to `/permissions <command | path | mcp:server/tool>`.
 */
import {
  CLASS_IDS,
  collectAckFlags,
  distAuthorization,
  type AuthCluster,
  type AuthMode,
  type AuthTier,
  type ClassId,
  type GrantRow,
  type LayerName,
  type Layers,
  type Resolver,
  resolveCall,
  isLive,
} from "@inhuman.tools/harness-model";
import { CLASSES } from "@inhuman.tools/policy/floor";

import { UiNode } from "../interpreter/uiCapability.js";

/** The cluster a class lives in, for the table lookup (everything not named is a shell class). */
const CLUSTER_OF: Readonly<Partial<Record<ClassId, AuthCluster>>> = {
  "envelope-read": "read",
  "envelope-write": "write",
  "protected-file": "write",
  "workspace-write": "write",
  "mcp-lookup": "mcp",
  "mcp-action": "mcp",
};

export type ExplainOutcome = {
  readonly tier: string;
  readonly outcome: string;
  readonly reason: string;
  readonly resolver: { readonly kind: string; readonly layer: string } | null;
  readonly ack: {
    readonly flags: readonly { readonly label: string; readonly why?: string; readonly layer: string }[];
    readonly satisfiedBy: { readonly label: string } | null;
  } | null;
};

export type PermissionsInput = {
  readonly mode: AuthMode;
  readonly layers: Layers;
  readonly grants: readonly GrantRow[];
  readonly acks: readonly GrantRow[];
  readonly nowMs: number;
  /** `/permissions <probe>`: the typed probe and what `policy/explain` said (or why it could not). */
  readonly explain?: { readonly probe: string; readonly outcome: ExplainOutcome | null; readonly error?: string };
  /** Problems the layers have (from `policy/config-get`). */
  readonly warnings?: readonly string[];
};

export type Revoke = {
  readonly method: "grant/revoke" | "ack/revoke";
  readonly params: { readonly id: string };
};

export type PermissionsRevocable = { readonly label: string; readonly detail: string; readonly revoke: Revoke };

export type PermissionsView = {
  readonly lines: readonly string[];
  /** One entry per stored grant and ack, in the order they are listed. */
  readonly revocable: readonly PermissionsRevocable[];
};

const BADGE: Readonly<Record<LayerName, string>> = {
  dist: "dist",
  managed: "managed",
  user: "user",
  project: "project",
  session: "session",
};

export function resolverText(resolver: Resolver): string {
  return resolver.kind === "judge" ? `judge (deny: ${resolver.onDeny}, fail: ${resolver.onFail})` : resolver.kind;
}

/** What a class resolves to for one tier, with the layer that decided. */
export function classResolution(
  layers: Layers,
  mode: AuthMode,
  id: ClassId,
  tier: AuthTier,
): { readonly resolver: Resolver; readonly layer: LayerName } {
  const { resolver, layer } = resolveCall(layers, {
    mode,
    cluster: CLUSTER_OF[id] ?? "bash",
    tier,
    classes: [id],
    unattended: false,
  });
  return { resolver, layer };
}

/** An acknowledgement flag's match as words: `date`, `mcp gmail/send_email`, `class: Publishes`, `tool: x`. */
export function flagMatchText(match: ReturnType<typeof collectAckFlags>[number]["match"]): string {
  if ("class" in match) {
    const known = (CLASSES as Readonly<Record<string, { readonly label: string } | undefined>>)[match.class];
    return `class: ${known?.label ?? match.class}`;
  }
  if ("mcp" in match) {
    const account = match.account === undefined ? "" : ` (${match.account})`;
    return `mcp ${match.mcp}/${match.tool ?? "*"}${account}`;
  }
  if ("tool" in match) return `tool: ${match.tool}`;
  return `\`${match.command.join(" ")}\``;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function expiryText(row: GrantRow, nowMs: number): string {
  if (row.expiresAtMs === null) return row.scope === "session" ? "when the session ends" : "never";
  if (!isLive(row, nowMs)) return `expired ${day(row.expiresAtMs)}`;
  const days = Math.ceil((row.expiresAtMs - nowMs) / 86_400_000);
  return `${day(row.expiresAtMs)} (${days <= 1 ? "<1 day" : `${days} days`})`;
}

function storedLine(row: GrantRow, nowMs: number): string {
  return `${row.scope.padEnd(7)} ${row.label} · created ${day(row.createdAtMs)} · expires ${expiryText(row, nowMs)} · ${row.source}`;
}

export function permissionsView(input: PermissionsInput): PermissionsView {
  const { mode, layers, nowMs } = input;
  const lines: string[] = [];
  const revocable: PermissionsRevocable[] = [];
  lines.push(`Mode: ${mode}`);
  if (input.warnings !== undefined && input.warnings.length > 0) {
    for (const warning of input.warnings) lines.push(`! ${warning}`);
  }
  lines.push("", "Resolution per class (soft-deny / ask):");
  const labelWidth = Math.max(...CLASS_IDS.map((id) => CLASSES[id].label.length));
  for (const id of CLASS_IDS) {
    const deny = classResolution(layers, mode, id, "deny");
    const ask = classResolution(layers, mode, id, "ask");
    lines.push(
      `  ${CLASSES[id].label.padEnd(labelWidth)} ${resolverText(deny.resolver)} [${BADGE[deny.layer]}] / ${resolverText(ask.resolver)} [${BADGE[ask.layer]}]`,
    );
  }

  lines.push("", `Stored grants (${input.grants.length}):`);
  if (input.grants.length === 0) lines.push("  none");
  for (const row of input.grants) {
    lines.push(`  ${storedLine(row, nowMs)}`);
    revocable.push({
      label: row.label,
      detail: `grant · ${row.scope} · ${expiryText(row, nowMs)}`,
      revoke: { method: "grant/revoke", params: { id: row.id } },
    });
  }

  const flags = collectAckFlags({ ...layers, dist: layers.dist ?? distAuthorization() });
  lines.push("", `Acknowledgements — flags in force (${flags.length}):`);
  if (flags.length === 0) lines.push("  none");
  for (const flag of flags) {
    const what = flagMatchText(flag.match);
    const modes = flag.modes === undefined ? "" : ` · modes ${flag.modes.join(",")}`;
    lines.push(`  ${what} [${BADGE[flag.layer]}]${flag.why === undefined ? "" : ` — ${flag.why}`}${modes}`);
  }
  lines.push(`Stored acknowledgements (${input.acks.length}):`);
  if (input.acks.length === 0) lines.push("  none");
  for (const row of input.acks) {
    lines.push(`  ${storedLine(row, nowMs)}`);
    revocable.push({
      label: row.label,
      detail: `acknowledgement · ${row.scope} · ${expiryText(row, nowMs)}`,
      revoke: { method: "ack/revoke", params: { id: row.id } },
    });
  }

  lines.push("", "Explain: /permissions <command | path | mcp:server/tool>");
  const explain = input.explain;
  if (explain !== undefined) {
    lines.push(`  ${explain.probe}`);
    if (explain.outcome === null) lines.push(`  ${explain.error ?? "no answer"}`);
    else lines.push(...explainLines(explain.outcome).map((line) => `  ${line}`));
  }
  return { lines, revocable };
}

export function explainLines(out: ExplainOutcome): string[] {
  const lines = [
    `${out.tier} → ${out.outcome}${out.resolver === null ? "" : ` · ${out.resolver.kind} [${out.resolver.layer}]`}`,
    out.reason,
  ];
  if (out.ack !== null) {
    const what = out.ack.flags.map((flag) => flag.label).join(", ");
    lines.push(
      out.ack.satisfiedBy === null
        ? `Needs acknowledgement: ${what}`
        : `Acknowledged: ${what} (${out.ack.satisfiedBy.label})`,
    );
    for (const flag of out.ack.flags) if (flag.why !== undefined) lines.push(`"${flag.why}" [${flag.layer}]`);
  }
  return lines;
}

export type Probe =
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "path"; readonly cluster: "read" | "write"; readonly path: string }
  | { readonly kind: "mcp"; readonly server: string; readonly tool: string };

/**
 * `mcp:server/tool` is an MCP call; `read <path>` / `write <path>` or a bare path (starting `/`, `~`, `.`)
 * is a file (a bare path is a write); anything else is a shell command.
 */
export function parseProbe(text: string): Probe | null {
  const raw = text.trim();
  if (raw === "") return null;
  const mcp = /^mcp:([^/\s]+)\/(\S+)$/.exec(raw);
  if (mcp !== null) return { kind: "mcp", server: mcp[1]!, tool: mcp[2]! };
  const file = /^(read|write)\s+(\S.*)$/.exec(raw);
  if (file !== null) return { kind: "path", cluster: file[1] as "read" | "write", path: file[2]!.trim() };
  if (/^[/~.]\S*$/.test(raw)) return { kind: "path", cluster: "write", path: raw };
  return { kind: "shell", command: raw };
}

function leaf(name: string, params: Record<string, unknown>, hotkey?: string): UiNode {
  return new UiNode(name, "", [], "ok", "", hotkey, [], [], [], "ui/resolve", { pending: "", ...params });
}

/**
 * The overlay: the view as its body, "Close" first so a bare Enter is harmless, then one row per
 * stored grant or ack (Enter on it revokes). Esc closes.
 */
export function permissionsSurface(view: PermissionsView): UiNode {
  const close = leaf("Close", { kind: "dismiss" });
  const rows = view.revocable.map(
    (row, index) =>
      new UiNode(`Revoke ${row.label}`, row.detail, [], "ok", "", undefined, [leaf("Revoke", { kind: "revoke", index })], [], [], null, {}),
  );
  const closeRow = new UiNode("Close", "", [], "ok", "", undefined, [close], [], [], null, {});
  return new UiNode(
    "Permissions",
    view.lines.join("\n"),
    [],
    "ok",
    "",
    undefined,
    [close],
    [leaf("Close", { kind: "dismiss" }, "escape")],
    [closeRow, ...rows],
    null,
    {},
  );
}
