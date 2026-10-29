/**
 * The Permissions view as data: what the session's mode does per class, the grants and acknowledgements
 * in force, and the Explain box. Pure rows from the daemon's answers; the component only paints them.
 * Resolutions are computed here from the layer texts with the model's own `resolveCall`, so they cannot
 * drift from what the daemon decides.
 */
import {
  CLASS_IDS,
  collectAckFlags,
  distAuthorization,
  layersOf,
  resolveCall,
  resolverWords,
  type AuthCluster,
  type AuthMode,
  type ClassId,
  type GrantRow,
  type LayerName,
  type Layers,
  type Resolver,
} from "@inhuman.tools/harness-model/session";

export type Request = (method: string, params: unknown) => Promise<unknown>;

export type LayerTexts = { readonly user: string; readonly project: string; readonly session: string };

export type PermissionsData = {
  readonly mode: AuthMode;
  readonly layers: LayerTexts;
  readonly warnings: readonly string[];
  readonly grants: readonly GrantRow[];
  readonly acks: readonly GrantRow[];
  readonly nowMs: number;
};

/** The cluster whose table row a class lives in. Shell-shaped classes sit in `bash`. */
export function clusterOf(id: ClassId): AuthCluster {
  switch (id) {
    case "envelope-read":
      return "read";
    case "envelope-write":
    case "protected-file":
    case "workspace-write":
      return "write";
    case "mcp-lookup":
    case "mcp-action":
      return "mcp";
    default:
      return "bash";
  }
}

export type Cell = {
  readonly kind: Resolver["kind"];
  readonly layer: LayerName;
  /** `allow`, `ask you`, `deny`, or `judge` with what a judge no / failure falls to. */
  readonly text: string;
  /** The same resolver spelled out in full, for a tooltip. */
  readonly title: string;
};

export type ClassRow = {
  readonly id: ClassId;
  readonly cluster: AuthCluster;
  readonly ask: Cell;
  readonly softDeny: Cell;
};

export function cellText(resolver: Resolver): string {
  return resolverWords(resolver).short;
}

export function layersFrom(texts: LayerTexts): Layers {
  return { ...layersOf(texts), dist: distAuthorization() };
}

export function classRows(layers: Layers, mode: AuthMode): ClassRow[] {
  const cell = (id: ClassId, tier: "ask" | "deny"): Cell => {
    const found = resolveCall(layers, {
      mode,
      cluster: clusterOf(id),
      tier,
      classes: [id],
      unattended: false,
    });
    return { kind: found.resolver.kind, layer: found.layer, text: cellText(found.resolver), title: resolverWords(found.resolver).full };
  };
  return CLASS_IDS.map((id) => ({ id, cluster: clusterOf(id), ask: cell(id, "ask"), softDeny: cell(id, "deny") }));
}

const DAY = 86_400_000;

/** `no expiry`, `expired`, or `in 6 days`. */
export function expiryText(row: Pick<GrantRow, "scope" | "expiresAtMs">, nowMs: number): string {
  if (row.expiresAtMs === null) return row.scope === "session" ? "until the session ends" : "no expiry";
  const left = row.expiresAtMs - nowMs;
  if (left <= 0) return "expired";
  if (left >= DAY) {
    const days = Math.ceil(left / DAY);
    return `in ${days} day${days === 1 ? "" : "s"}`;
  }
  if (left >= 3_600_000) return `in ${Math.floor(left / 3_600_000)} h`;
  return `in ${Math.max(1, Math.floor(left / 60_000))} min`;
}

export function createdText(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().slice(0, 10);
}

export type StoredRow = {
  readonly id: string;
  readonly kind: "grant" | "ack";
  readonly scope: GrantRow["scope"];
  readonly label: string;
  readonly created: string;
  readonly expires: string;
  readonly source: GrantRow["source"];
  /** Settings-file rows are edited in the file; only prompt-made rows revoke here. */
  readonly revocable: boolean;
};

export function storedRows(rows: readonly GrantRow[], kind: "grant" | "ack", nowMs: number): StoredRow[] {
  return rows.map((row) => ({
    id: row.id,
    kind,
    scope: row.scope,
    label: row.label,
    created: createdText(row.createdAtMs),
    expires: expiryText(row, nowMs),
    source: row.source,
    revocable: row.source === "prompt",
  }));
}

export type FlagRow = { readonly label: string; readonly why: string; readonly layer: LayerName };

export function flagRows(layers: Layers): FlagRow[] {
  return collectAckFlags(layers).map((flag) => ({
    label: flagLabel(flag.match),
    why: flag.why ?? "",
    layer: flag.layer,
  }));
}

function flagLabel(match: ReturnType<typeof collectAckFlags>[number]["match"]): string {
  if ("class" in match) return `any ${match.class} call`;
  if ("mcp" in match) {
    const account = match.account === undefined ? "" : ` (${match.account})`;
    return `${match.mcp}${account} · ${match.tool ?? "every tool"}`;
  }
  if ("tool" in match) return `tool ${match.tool}`;
  return `\`${match.command.join(" ")}\``;
}

export type PermissionsView = {
  readonly mode: AuthMode;
  readonly classes: readonly ClassRow[];
  readonly grants: readonly StoredRow[];
  readonly flags: readonly FlagRow[];
  readonly acks: readonly StoredRow[];
  readonly warnings: readonly string[];
};

export function permissionsView(data: PermissionsData): PermissionsView {
  const layers = layersFrom(data.layers);
  return {
    mode: data.mode,
    classes: classRows(layers, data.mode),
    grants: storedRows(data.grants, "grant", data.nowMs),
    flags: flagRows(layers),
    acks: storedRows(data.acks, "ack", data.nowMs),
    warnings: data.warnings,
  };
}

/** The revoke call for a row: acknowledgements and grants have their own methods. */
export function revokeRequest(
  row: Pick<StoredRow, "id" | "kind" | "scope">,
  sessionId: string | null,
): { readonly method: "ack/revoke" | "grant/revoke"; readonly params: Record<string, unknown> } {
  return {
    method: row.kind === "ack" ? "ack/revoke" : "grant/revoke",
    params: sessionId !== null && row.scope === "session" ? { id: row.id, sessionId } : { id: row.id },
  };
}

/** Revoke one row. `true` when the daemon took it. */
export async function revokeRow(
  request: Request,
  row: Pick<StoredRow, "id" | "kind" | "scope">,
  sessionId: string | null,
): Promise<boolean> {
  const sent = revokeRequest(row, sessionId);
  const result = await request(sent.method, sent.params);
  return isOk(result);
}

function isOk(result: unknown): boolean {
  return typeof result === "object" && result != null && "ok" in result && result.ok === true;
}

function rowsOf(result: unknown): GrantRow[] {
  if (typeof result !== "object" || result == null || !("rows" in result) || !Array.isArray(result.rows)) return [];
  return result.rows as GrantRow[];
}

function modeOf(value: unknown): AuthMode {
  return value === "manual" || value === "auto" || value === "yolo" ? value : "auto";
}

/** Read everything the view needs. A part whose port is missing or fails reads as empty, with a warning. */
export async function loadPermissions(ports: {
  readonly session: Request | null;
  readonly kernel: Request | null;
  readonly sessionId: string | null;
  readonly projectPath: string | null;
  readonly mode: unknown;
  readonly nowMs: number;
}): Promise<PermissionsData> {
  const warnings: string[] = [];
  const attempt = async <T>(
    label: string,
    port: Request | null,
    method: string,
    params: unknown,
    pick: (r: unknown) => T,
    empty: T,
  ): Promise<T> => {
    if (port === null) return empty;
    try {
      return pick(await port(method, params));
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : "not available"}`);
      return empty;
    }
  };
  const who = {
    ...(ports.sessionId === null ? {} : { sessionId: ports.sessionId }),
    ...(ports.projectPath === null ? {} : { projectPath: ports.projectPath }),
  };
  const none: { layers: LayerTexts; warnings: string[] } = {
    layers: { user: "", project: "", session: "" },
    warnings: [],
  };
  const config = await attempt(
    "Policy layers",
    ports.session,
    "policy/config-get",
    {},
    (result) => {
      const value = (result ?? {}) as { layers?: Partial<LayerTexts>; warnings?: unknown };
      return {
        layers: {
          user: value.layers?.user ?? "",
          project: value.layers?.project ?? "",
          session: value.layers?.session ?? "",
        },
        warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
      };
    },
    none,
  );
  const grants = await attempt("Grants", ports.kernel, "grant/list", who, rowsOf, [] as GrantRow[]);
  const acks = await attempt("Acknowledgements", ports.kernel, "ack/list", who, rowsOf, [] as GrantRow[]);
  return {
    mode: modeOf(ports.mode),
    layers: config.layers,
    warnings: [...config.warnings, ...warnings],
    grants,
    acks,
    nowMs: ports.nowMs,
  };
}

export type Probe =
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "path"; readonly cluster: "read" | "write"; readonly path: string }
  | { readonly kind: "mcp"; readonly server: string; readonly tool: string };

/**
 * A command, a path, or `mcp:<server>/<tool>`. A path is a line that starts like one and has no spaces;
 * it is a write unless prefixed `read:` (the stricter reading). Anything else is a shell command.
 */
export function parseProbe(input: string): Probe | null {
  const text = input.trim();
  if (text === "") return null;
  const mcp = /^mcp:([^/\s]+)\/(\S+)$/.exec(text);
  if (mcp !== null) return { kind: "mcp", server: mcp[1]!, tool: mcp[2]! };
  const prefixed = /^(read|write):(\S+)$/.exec(text);
  if (prefixed !== null) return { kind: "path", cluster: prefixed[1] as "read" | "write", path: prefixed[2]! };
  if (/^(\/|~\/|\.\.?\/)\S*$/.test(text)) return { kind: "path", cluster: "write", path: text };
  return { kind: "shell", command: text };
}

export type ExplainLines = {
  readonly outcome: string;
  readonly reason: string;
  readonly tier: string;
  readonly classes: string;
  readonly resolver: string;
  readonly grant: string;
  readonly ack: string;
};

const OUTCOME: Readonly<Record<string, string>> = {
  runs: "Runs without asking",
  "judge-ask": "The judge decides, else asks you",
  "judge-soft-deny": "The judge decides whether you asked for it, else asks you",
  "prompts-you": "Asks you",
  denied: "Denied",
  blocked: "Blocked",
};

/** The `policy/explain` answer as short lines. Unknown shapes read as empty rather than throwing. */
export function explainLines(result: unknown): ExplainLines | null {
  if (typeof result !== "object" || result == null) return null;
  const r = result as {
    outcome?: string;
    reason?: string;
    tier?: string;
    classes?: { label?: string; id?: string }[];
    resolver?: { kind?: string; layer?: string } | null;
    grant?: { label?: string } | null;
    ack?: { flags?: { label: string; why?: string; layer?: string }[]; satisfiedBy?: { label?: string } | null } | null;
  };
  if (typeof r.outcome !== "string") return null;
  const ack = r.ack;
  return {
    outcome: OUTCOME[r.outcome] ?? r.outcome,
    reason: r.reason ?? "",
    tier: r.tier ?? "",
    classes: (r.classes ?? []).map((c) => c.label ?? c.id ?? "").join(", "),
    resolver: r.resolver == null ? "" : `${r.resolver.kind ?? ""} (${r.resolver.layer ?? ""})`,
    grant: r.grant?.label ?? "",
    ack:
      ack == null
        ? ""
        : `${(ack.flags ?? []).map((f) => f.label + (f.why === undefined ? "" : ` — ${f.why}`)).join("; ")}${
            ack.satisfiedBy == null
              ? " · needs acknowledgement"
              : ` · satisfied by ${ack.satisfiedBy.label ?? "a stored acknowledgement"}`
          }`,
  };
}

/** Ask the session what would happen to the probe right now. Null when the line did not answer. */
export async function explain(request: Request, input: string, mode: AuthMode): Promise<ExplainLines | null> {
  const probe = parseProbe(input);
  if (probe === null) return null;
  return explainLines(await request("policy/explain", { probe, mode }));
}
