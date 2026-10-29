/**
 * Resolution table: which resolver licenses a soft-deny or an ask, for a mode, cluster and class.
 * Pure. The layers are parsed configs; `resolveCall` merges them.
 *
 *   base = first layer that defines the cell: managed.set > session > user > dist
 *   eff  = strictest(base, managed.require, project)          (project and require only tighten)
 *   call = strictest over the call's classes
 *   unattended: the `unattended` overlay replaces the base choice; every `human` becomes `deny`
 *
 * Strictness: allow < judge < human < deny. Nothing here can produce `block`, and nothing here is
 * consulted for `block` or for an approve.
 */
import {
  type AuthCluster,
  type AuthMode,
  type AuthorizationConfig,
  type AuthTier,
  type CellInput,
  type ClassId,
  type ClusterTableInput,
  type JudgeParams,
  type ModeTableInput,
  parseAuthorizationConfig,
  type ResolverInput,
  type SpecificMatch,
  type SpecificRule,
} from "./config.js";
import defaults from "./defaults.json" with { type: "json" };

export type JudgeResolver = {
  readonly kind: "judge";
  readonly params: JudgeParams;
  readonly onDeny: "human" | "deny";
  readonly onFail: "human" | "deny";
};
export type Resolver =
  { readonly kind: "allow" } | { readonly kind: "deny" } | { readonly kind: "human" } | JudgeResolver;

const FALLBACK_WORD = { human: "ask you", deny: "deny" } as const;

/**
 * Words for a resolver, shared by the clients. `short` fits a table cell; `full` spells out both
 * fallbacks (what a judge "no" and a judge failure each fall to) for a tooltip.
 */
export function resolverWords(resolver: Resolver): { readonly short: string; readonly full: string } {
  switch (resolver.kind) {
    case "allow":
      return { short: "allow", full: "Allowed without asking" };
    case "deny":
      return { short: "deny", full: "Denied" };
    case "human":
      return { short: "ask you", full: "Asks you" };
    case "judge": {
      const no = FALLBACK_WORD[resolver.onDeny];
      const fail = FALLBACK_WORD[resolver.onFail];
      return {
        short: no === fail ? `judge, else ${no}` : `judge · no: ${no} · fails: ${fail}`,
        full: `Judge · if it says no: ${no} · if it fails: ${fail}`,
      };
    }
  }
}

export type LayerName = "dist" | "managed" | "user" | "project" | "session";

export type Layers = {
  readonly dist?: AuthorizationConfig;
  /** A managed `set` beats everything below it. Deferred: nothing ships it, the code is ready for it. */
  readonly managedSet?: AuthorizationConfig;
  /** A managed `require` only tightens. */
  readonly managedRequire?: AuthorizationConfig;
  readonly user?: AuthorizationConfig;
  /** The user's block did not parse. It is never silently dropped (that could loosen): every cell asks a person. */
  readonly userInvalid?: boolean;
  /** Tighten only. A project file that failed to parse is `projectInvalid`: every cell becomes `human`. */
  readonly project?: AuthorizationConfig;
  readonly projectInvalid?: boolean;
  /** Set by the human over RPC. Loosens down to the user layer, never past project or managed. */
  readonly session?: AuthorizationConfig;
};

/** What the call is, for specific `{mcp, account?, tool}` / command-family / path entries. */
export type CallSubject = {
  readonly mcp?: { readonly server: string; readonly account: string; readonly tool: string };
  readonly tool?: string;
  /** Units that voted at the call's tier (shell). */
  readonly units?: readonly {
    readonly argv0: string;
    readonly spine: readonly string[];
    readonly familyArgs: readonly string[];
  }[];
  readonly paths?: readonly { readonly cluster: "read" | "write"; readonly path: string }[];
};

export type CallQuery = {
  readonly mode: AuthMode;
  readonly cluster: AuthCluster;
  readonly tier: AuthTier;
  readonly classes: readonly ClassId[];
  readonly unattended: boolean;
  readonly subject?: CallSubject;
};

export type Resolution = {
  readonly resolver: Resolver;
  /** The layer whose cell decided (the strictest one). */
  readonly layer: LayerName;
  /**
   * Unattended only: which parts of the cell asked for a person and were turned into `deny`. A denial
   * that comes from one of them is `interaction_required`, not `policy_denied`.
   */
  readonly interaction: Interaction;
};

export type Interaction = { readonly resolver: boolean; readonly onDeny: boolean; readonly onFail: boolean };
export const NO_INTERACTION: Interaction = { resolver: false, onDeny: false, onFail: false };

const RANK = { allow: 0, judge: 1, human: 2, deny: 3 } as const;

export function rankOf(resolver: Resolver): number {
  return RANK[resolver.kind];
}

const DEFAULT_JUDGE: JudgeResolver = { kind: "judge", params: {}, onDeny: "human", onFail: "human" };

function failure(value: "human" | "deny" | "ask" | undefined, fallback: "human" | "deny"): "human" | "deny" {
  return value === "deny" ? "deny" : value === undefined ? fallback : "human";
}

/** A resolver as written, for a tier. `ask` is `human`. A judge's `onDeny` defaults by tier. */
export function normalizeResolver(input: ResolverInput, tier: AuthTier): Resolver {
  if (typeof input === "string") {
    return input === "ask" ? { kind: "human" } : input === "judge" ? defaultJudge(tier) : { kind: input };
  }
  return {
    kind: "judge",
    params: input.judge,
    onDeny: failure(input.onDeny, tier === "deny" ? "human" : "deny"),
    onFail: failure(input.onFail, "human"),
  };
}

function defaultJudge(tier: AuthTier): JudgeResolver {
  return { ...DEFAULT_JUDGE, onDeny: tier === "deny" ? "human" : "deny" };
}

/** The stricter of two resolvers; judges merge field by field. */
export function strictest(a: Resolver, b: Resolver): Resolver {
  if (rankOf(a) !== rankOf(b)) return rankOf(a) > rankOf(b) ? a : b;
  if (a.kind !== "judge" || b.kind !== "judge") return a;
  return {
    kind: "judge",
    params: {
      ...(a.params.margin === undefined && b.params.margin === undefined
        ? {}
        : { margin: Math.min(a.params.margin ?? 0, b.params.margin ?? 0) }),
      ...(a.params.rounds === undefined && b.params.rounds === undefined
        ? {}
        : { rounds: Math.min(a.params.rounds ?? 2, b.params.rounds ?? 2) as 1 | 2 }),
      ...(a.params.requireQuote === undefined && b.params.requireQuote === undefined
        ? {}
        : { requireQuote: (a.params.requireQuote ?? true) || (b.params.requireQuote ?? true) }),
    },
    onDeny: a.onDeny === "deny" || b.onDeny === "deny" ? "deny" : "human",
    onFail: a.onFail === "deny" || b.onFail === "deny" ? "deny" : "human",
  };
}

function isTierCell(cell: CellInput): cell is { "soft-deny"?: ResolverInput; ask?: ResolverInput } {
  return typeof cell === "object" && !("judge" in cell);
}

function fromCell(cell: CellInput | undefined, tier: AuthTier): Resolver | undefined {
  if (cell === undefined) return undefined;
  if (!isTierCell(cell)) return normalizeResolver(cell, tier);
  const picked = tier === "deny" ? cell["soft-deny"] : cell.ask;
  return picked === undefined ? undefined : normalizeResolver(picked, tier);
}

function clusterTable(table: ModeTableInput, cluster: AuthCluster): ClusterTableInput | undefined {
  return cluster === "bash" ? (table.bash ?? table.shell) : table[cluster];
}

/** First defined value in one mode table: cluster.classes > table.classes > cluster tier > default. */
function fromTable(table: ModeTableInput | undefined, q: CallQuery): Resolver | undefined {
  if (table === undefined) return undefined;
  const cluster = clusterTable(table, q.cluster);
  const found: Resolver[] = [];
  for (const cls of q.classes) {
    const here =
      fromCell(cluster?.classes?.[cls], q.tier) ??
      fromCell(table.classes?.[cls], q.tier) ??
      fromCell(tierOf(cluster, q.tier), q.tier) ??
      fromCell(table.default, q.tier);
    if (here !== undefined) found.push(here);
  }
  if (q.classes.length === 0) {
    const here = fromCell(tierOf(cluster, q.tier), q.tier) ?? fromCell(table.default, q.tier);
    if (here !== undefined) found.push(here);
  }
  return found.length === 0 ? undefined : found.reduce(strictest);
}

function tierOf(cluster: ClusterTableInput | undefined, tier: AuthTier): CellInput | undefined {
  return tier === "deny" ? cluster?.["soft-deny"] : cluster?.ask;
}

function inPrefix(rule: readonly string[], unit: readonly string[]): boolean {
  return rule.length <= unit.length && rule.every((part, i) => part === unit[i]);
}

function pathCovers(rule: string, path: string): boolean {
  const stem = rule.endsWith("/") && rule.length > 1 ? rule.slice(0, -1) : rule;
  return path === stem || path.startsWith(`${stem}/`) || stem === ".";
}

/** Does a user-added specific entry cover the whole call? A command entry must cover every voting unit. */
export function matches(match: SpecificMatch, subject: CallSubject | undefined): boolean {
  if (subject === undefined) return false;
  if ("mcp" in match) {
    const mcp = subject.mcp;
    return (
      mcp !== undefined &&
      mcp.server === match.mcp &&
      (match.account === undefined || mcp.account === match.account) &&
      (match.tool === undefined || mcp.tool === match.tool)
    );
  }
  if ("command" in match) {
    const units = subject.units ?? [];
    return (
      units.length > 0 &&
      units.every((unit) => inPrefix(match.command, [unit.argv0, ...unit.spine, ...unit.familyArgs]))
    );
  }
  if ("path" in match) {
    const paths = (subject.paths ?? []).filter((p) => p.cluster === match.cluster);
    return paths.length > 0 && paths.every((p) => pathCovers(match.path, p.path));
  }
  return subject.tool === match.tool;
}

function fromRules(
  rules: readonly SpecificRule[] | undefined,
  key: AuthMode | "unattended",
  q: CallQuery,
): Resolver | undefined {
  const found: Resolver[] = [];
  for (const rule of rules ?? []) {
    if (!matches(rule.match, q.subject)) continue;
    const here = fromCell(rule.resolve?.[key], q.tier);
    if (here !== undefined) found.push(here);
  }
  return found.length === 0 ? undefined : found.reduce(strictest);
}

function fromLayer(
  cfg: AuthorizationConfig | undefined,
  key: AuthMode | "unattended",
  q: CallQuery,
): Resolver | undefined {
  if (cfg === undefined) return undefined;
  return fromRules(cfg.rules, key, q) ?? fromTable(cfg[key], q);
}

/** `auto.preset: "full"`: nothing asks a person; every judge failure denies. */
function fullAuto(resolver: Resolver): Resolver {
  if (resolver.kind === "human") return { kind: "judge", params: {}, onDeny: "deny", onFail: "deny" };
  if (resolver.kind === "judge") return { ...resolver, onDeny: "deny", onFail: "deny" };
  return resolver;
}

function presetFull(layers: Layers): boolean {
  return [layers.managedSet, layers.session, layers.user].some((cfg) => cfg?.auto?.preset === "full");
}

const HUMAN: Resolver = { kind: "human" };

/** Every `human` (as a resolver, onDeny or onFail) becomes `deny`: no person is there to answer. */
function withoutHuman(resolver: Resolver): Resolver {
  if (resolver.kind === "human") return { kind: "deny" };
  if (resolver.kind === "judge") return { ...resolver, onDeny: "deny", onFail: "deny" };
  return resolver;
}

export function resolveCall(layers: Layers, q: CallQuery): Resolution {
  const keys: ReadonlyArray<AuthMode | "unattended"> = q.unattended ? ["unattended", q.mode] : [q.mode];
  const candidates: ReadonlyArray<readonly [LayerName, AuthorizationConfig | undefined]> = [
    ["managed", layers.managedSet],
    ["session", layers.session],
    ["user", layers.user],
    ["dist", layers.dist ?? DIST],
  ];
  let base: Resolver | undefined;
  let layer: LayerName = "dist";
  for (const key of keys) {
    for (const [name, cfg] of candidates) {
      const here = fromLayer(cfg, key, q);
      if (here === undefined) continue;
      base = here;
      layer = name;
      break;
    }
    if (base !== undefined) break;
  }
  let eff: Resolver = base ?? HUMAN;
  if (q.mode === "auto" && presetFull(layers)) eff = fullAuto(eff);
  const tighteners: ReadonlyArray<readonly [LayerName, AuthorizationConfig | undefined]> = [
    ["managed", layers.managedRequire],
    ["project", layers.project],
  ];
  for (const [name, cfg] of tighteners) {
    const here = keys
      .map((key) => fromLayer(cfg, key, q))
      .reduce<Resolver | undefined>(
        (acc, next) => (acc === undefined ? next : next === undefined ? acc : strictest(acc, next)),
        undefined,
      );
    if (here !== undefined && rankOf(here) > rankOf(eff)) {
      eff = here;
      layer = name;
    } else if (here !== undefined && rankOf(here) === rankOf(eff)) {
      eff = strictest(eff, here);
    }
  }
  if ((layers.projectInvalid === true || layers.userInvalid === true) && rankOf(eff) < rankOf(HUMAN)) {
    eff = HUMAN;
    layer = layers.projectInvalid === true ? "project" : "user";
  }
  if (!q.unattended) return { resolver: eff, layer, interaction: NO_INTERACTION };
  const interaction: Interaction = {
    resolver: eff.kind === "human",
    onDeny: eff.kind === "judge" && eff.onDeny === "human",
    onFail: eff.kind === "judge" && eff.onFail === "human",
  };
  return { resolver: withoutHuman(eff), layer, interaction };
}

const DIST: AuthorizationConfig = (() => {
  const parsed = parseAuthorizationConfig(defaults);
  if (!parsed.ok) throw new Error(`authorization defaults are invalid: ${parsed.errors.join("; ")}`);
  return parsed.config;
})();

export function distAuthorization(): AuthorizationConfig {
  return DIST;
}

/** Strictest of the classes' resolutions, reported by the layer of the winner. */
export const HUMAN_RESOLVER = HUMAN;
