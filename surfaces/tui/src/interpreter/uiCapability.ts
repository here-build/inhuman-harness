/**
 * ONE NODE, STATIC DECLARATIVE CONSTRUCTORS + CONTEXT-AWARE PROJECTIONS.
 * Chrome branches on visible children, not on which constructor minted the
 * node. Activate is Enter on this node: children present → drill; none → fire
 * `:action` (a list of named leaves, in order) and pass composer text as
 * `:input`. The list is the sequence; Tea walks it.
 *
 * Callback chunks (`harness/confirm`, `harness/input`, `harness/open-url`,
 * `harness/notice`) are sugar over the same node. They bake `ui/resolve`
 * leaves with `pending`.
 */
import type { ConnectionSpec, DriverSpec } from "@inhuman.tools/expectations";
import { parseUiDefinition, type UiDefinition } from "@inhuman.tools/harness-contract";
import {
  formatReasoningEffortLabel,
  type KernelRoot,
  REASONING_EFFORTS,
  type ReasoningEffort,
  reasoningEffortOf,
  reasoningProfileFor,
  type ReasoningProfileHint,
  type SessionRoot,
  willEffortSwitchDropCache,
} from "@inhuman.tools/harness-model";

export type UiHealth = "ok" | "degraded" | "failed";
export type RpcCall = (method: string, params?: unknown) => unknown;

export type UiEvalConfig = {
  readonly kernel?: KernelRoot;
  readonly session?: SessionRoot;
  readonly pending?: string;
  readonly rpc?: RpcCall;
};

export class UiNode {
  constructor(
    readonly name: string,
    readonly description: string,
    readonly aliases: readonly string[],
    readonly health: UiHealth,
    readonly healthAnnotation: string,
    readonly hotkey: string | undefined,
    readonly action: readonly UiNode[],
    readonly alternateActions: readonly UiNode[],
    readonly choices: readonly UiNode[],
    readonly op: string | null,
    readonly params: Readonly<Record<string, unknown>>,
    readonly secret: boolean = false,
    readonly annotation: string = "",
  ) {}
}

export type UiChoiceInput = {
  readonly name?: string;
  readonly description?: string;
  readonly annotation?: string;
  readonly alias?: readonly string[];
  readonly healthStatus?: UiHealth;
  readonly healthAnnotation?: string;
  readonly hotkey?: string;
  readonly action?: readonly UiNode[];
  readonly alternateActions?: readonly UiNode[];
  readonly choices?: readonly UiNode[];
  readonly secret?: boolean;
};

export type UiActionInput = {
  readonly name?: string;
  readonly description?: string;
  readonly hotkey?: string;
  readonly alias?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
};

export function uiChoice(input: UiChoiceInput = {}): UiNode {
  return new UiNode(
    input.name ?? "",
    input.description ?? "",
    input.alias ?? [],
    input.healthStatus ?? "ok",
    input.healthAnnotation ?? "",
    input.hotkey,
    input.action ?? [],
    input.alternateActions ?? [],
    input.choices ?? [],
    null,
    {},
    input.secret ?? false,
    input.annotation ?? "",
  );
}

export function uiAction(op: string, input: UiActionInput = {}): UiNode {
  return new UiNode(
    input.name ?? op,
    input.description ?? "",
    input.alias ?? [],
    "ok",
    "",
    input.hotkey,
    [],
    [],
    [],
    op,
    input.params ?? {},
  );
}

function resolveLeaf(name: string, pending: string, params: Record<string, unknown>, hotkey?: string): UiNode {
  return new UiNode(name, "", [], "ok", "", hotkey, [], [], [], "ui/resolve", { pending, ...params });
}

export function uiConfirm(
  pending: string,
  input: { readonly title?: string; readonly name?: string; readonly description?: string } = {},
): UiNode {
  const title = input.name ?? input.title ?? "Confirm";
  return new UiNode(
    title,
    input.description ?? "",
    [],
    "ok",
    "",
    undefined,
    [resolveLeaf("Confirm", pending, { kind: "accept" })],
    [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
    [],
    null,
    {},
  );
}

export function uiInput(
  pending: string,
  input: { readonly name?: string; readonly description?: string; readonly secret?: boolean } = {},
): UiNode {
  const name = input.name ?? "Input";
  return new UiNode(
    name,
    input.description ?? "",
    [],
    "ok",
    "",
    undefined,
    [resolveLeaf(name, pending, { kind: "text", input: "" })],
    [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
    [],
    null,
    {},
    input.secret ?? false,
  );
}

export function uiOpenUrl(
  pending: string,
  input: {
    readonly url: string;
    readonly name?: string;
    readonly description?: string;
    readonly input?: "text" | "password";
  },
): UiNode {
  const wantsInput = input.input !== undefined;
  return new UiNode(
    input.name ?? "Continue",
    input.description ?? "",
    [],
    "ok",
    "",
    undefined,
    [resolveLeaf("Continue", pending, wantsInput ? { kind: "text", input: "" } : { kind: "opened", url: input.url })],
    [resolveLeaf("Cancel", pending, { kind: "cancel" }, "escape")],
    [],
    null,
    { url: input.url },
    input.input === "password",
  );
}

export function uiNotice(
  pending: string,
  input: { readonly message?: string; readonly name?: string; readonly description?: string } = {},
): UiNode {
  const message = input.message ?? "";
  const title = input.name ?? (message === "" ? "Notice" : message);
  const description = input.description ?? "";
  return new UiNode(
    title,
    description === "" ? message : description,
    [],
    "ok",
    "",
    undefined,
    [resolveLeaf("Dismiss", pending, { kind: "dismiss" })],
    [resolveLeaf("Dismiss", pending, { kind: "dismiss" }, "escape")],
    [],
    null,
    {},
  );
}

// ---------------------------------------------------------------------------
// Context-aware command builders (/connect, /model, /mcp, /compact, /goal, /plan)
// ---------------------------------------------------------------------------

const CHATGPT_PLANS: Readonly<Record<string, string>> = {
  free: "ChatGPT Free",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  go: "ChatGPT Go",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
};

const GROK_PLANS: Readonly<Record<string, string>> = {
  super_grok: "SuperGrok",
  supergrok: "SuperGrok",
  super_grok_heavy: "SuperGrok Heavy",
  supergrok_heavy: "SuperGrok Heavy",
  grok_heavy: "SuperGrok Heavy",
  heavy: "SuperGrok Heavy",
  super_grok_pro: "SuperGrok Pro",
  supergrokpro: "SuperGrok Pro",
  grok_pro: "SuperGrok Pro",
  grokpro: "SuperGrok Pro",
  super_grok_plus: "SuperGrok Plus",
  supergrokplus: "SuperGrok Plus",
  super_grok_lite: "SuperGrok Lite",
  supergroklite: "SuperGrok Lite",
  premium: "SuperGrok",
  premium_plus: "SuperGrok",
  premiumplus: "SuperGrok",
  x_premium_plus: "X Premium Plus",
  xpremiumplus: "X Premium Plus",
  x_premium: "X Premium",
  xpremium: "X Premium",
  x_basic: "X Basic",
  xbasic: "X Basic",
  free: "Free",
};

function asList(x: unknown): readonly unknown[] {
  return Array.isArray(x) ? x : [];
}

function asDict(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function text(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function liveOf(c: ConnectionSpec): Record<string, unknown> {
  return asDict(c.live);
}

function driverCan(d: DriverSpec | null | undefined): readonly string[] {
  return d ? asList(d.abilityClaim).filter((item): item is string => typeof item === "string") : [];
}

function modelsOf(c: ConnectionSpec): readonly string[] {
  return asList(liveOf(c).models).filter((item): item is string => typeof item === "string");
}

function extractVersion(s: string): string {
  return /\d+(?:\.\d+)*/.exec(s)?.[0] ?? "";
}

function versionNumbers(v: string): readonly number[] {
  if (v === "") return [];
  return v
    .split(".")
    .filter((part) => part !== "")
    .map(Number);
}

function versionGreater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return false;
    if (i >= b.length) return true;
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

function bestModel(models: readonly string[]): string {
  if (models.length === 0) return "";
  let best = models[0]!;
  let bestVer = versionNumbers(extractVersion(best));
  for (let i = 1; i < models.length; i++) {
    const candidate = models[i]!;
    const ver = versionNumbers(extractVersion(candidate));
    if (versionGreater(ver, bestVer)) {
      best = candidate;
      bestVer = ver;
    }
  }
  return best;
}

function planKey(raw: unknown): string {
  const s = text(raw).toLowerCase();
  let acc = "";
  let pendingUs = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === " " || c === "-") {
      pendingUs = true;
    } else if (pendingUs) {
      acc += `_${c}`;
      pendingUs = false;
    } else {
      acc += c;
    }
  }
  return acc;
}

function planBesideProduct(product: string, plan: string): string {
  if (plan === "") return "";
  const prefix = `${product} `;
  if (plan === product) return plan;
  if (plan.startsWith(prefix)) return plan.slice(prefix.length);
  return plan;
}

function planCaption(product: string, identity: Record<string, unknown>): string {
  const raw = text(identity.plan);
  const key = planKey(raw);
  const table = product === "Grok" ? GROK_PLANS : CHATGPT_PLANS;
  const hit = key !== "" ? table[key] : undefined;
  const short = key === "" ? "" : (hit ?? raw);
  const core = planBesideProduct(product, short);
  const label = core !== "" ? core : short !== "" ? short : product !== "" ? product : "";
  if (label === "") return "";
  if (label.toLowerCase().includes("subscription")) return label;
  return `${label} subscription`;
}

function fixed2(n: number): string {
  const scaled = Math.round(n * 100);
  const neg = scaled < 0;
  const s = neg ? -scaled : scaled;
  const whole = Math.trunc(s / 100);
  const frac = s % 100;
  const fracs = frac < 10 ? `0${frac}` : String(frac);
  return `${neg ? "-" : ""}${whole}.${fracs}`;
}

function paintMajor(raw: unknown, mark: string): string {
  const str = text(raw);
  const n = str.trim() === "" ? Number.NaN : Number(str);
  if (!Number.isFinite(n)) return str;
  const scaled = Math.round(Math.abs(n) * 100);
  if (n > 0 && scaled === 0) return `<${mark}0.01`;
  if (n < 0) return `-${mark}${fixed2(Math.abs(n))}`;
  return `${mark}${fixed2(n)}`;
}

function paintBalance(view: unknown): string {
  if (!view || typeof view !== "object") return "";
  const v = asDict(view);
  const currency = asDict(v.currency);
  const mark = text(currency.symbol);
  const code = text(currency.code);
  const body = paintMajor(v.balance, mark);
  if (mark === "") {
    return code === "" ? body : `${body} ${code}`;
  }
  return body;
}

function numberOrNull(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = text(x).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function remainingPercent(remaining: unknown): string {
  const n = numberOrNull(remaining);
  if (n === null) return "";
  return `${Math.round(Math.max(0, Math.min(100, n)))}%`;
}

function countWord(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function hoursPhrase(h: number): string {
  return h >= 24 ? countWord(Math.trunc(h / 24), "day") : countWord(h, "hour");
}

function paintReset(sec: unknown): string {
  const n = numberOrNull(sec);
  if (n === null) return "";
  const s = Math.max(0, Math.round(n));
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
  return h === 0 ? countWord(d, "day") : `${countWord(d, "day")} and ${countWord(h, "hour")}`;
}

function paintWindow(w: Record<string, unknown>): string {
  const left = remainingPercent(w.remainingPercent);
  const until = paintReset(w.resetInSec);
  if (left === "") return "";
  return until === "" ? left : `${left} left for ${until}`;
}

function paintWindows(detail: unknown): string {
  return asList(asDict(detail).windows)
    .map((row) => paintWindow(asDict(row)))
    .filter((s) => s !== "")
    .join(" · ");
}

function paintAccountAnnotation(account: unknown): string {
  if (!account || typeof account !== "object") return "";
  const acc = asDict(account);
  return [paintBalance(acc.balance), paintWindows(acc.balanceDetail)].filter((s) => s !== "").join(" · ");
}

function oidcWho(live: Record<string, unknown>): string {
  const id = asDict(live.identity);
  const who = text(id.displayName);
  return who === "" ? text(id.email) : who;
}

function identityPresent(live: Record<string, unknown>): boolean {
  const id = asDict(live.identity);
  return text(id.displayName) !== "" || text(id.email) !== "" || text(id.plan) !== "";
}

function connectionUrl(c: ConnectionSpec): string {
  const cfg = asDict(c.configuration);
  return text(cfg.baseUrl);
}

function connectionTitle(c: ConnectionSpec): string {
  const live = text(liveOf(c).catalogName);
  if (live !== "") return live;
  return c.name && c.name !== "" ? c.name : c.id;
}

function needsAuth(c: ConnectionSpec): boolean {
  return text(liveOf(c).auth) === "needs-auth";
}

function authLine(s: string): boolean {
  return /(?<!\d)(?:401|403)(?!\d)/.test(s);
}

function lastUsedModel(c: ConnectionSpec, kernel: KernelRoot, session?: SessionRoot): string {
  if (session?.lastUsedConnectionModel[c.id] !== undefined) {
    return session.lastUsedConnectionModel[c.id]!;
  }
  return kernel.lastUsedConnectionModel[c.id] ?? "";
}

export function connectChoices(kernel: KernelRoot, session?: SessionRoot): readonly UiNode[] {
  const promptDrivers = Object.values(kernel.drivers).filter((d) => d.abilityClaim.includes("completion"));
  const connections = Object.values(kernel.connections);
  const usedConnections = connections.filter((c) => driverCan(c.driver).includes("completion"));
  const usedDrivers = new Set(usedConnections.map((c) => c.driver).filter((d): d is DriverSpec => Boolean(d)));

  const connectionNode = (c: ConnectionSpec): UiNode => {
    const err = text(c.error);
    const live = liveOf(c);
    const failed = c.issue === "failed" && err !== "";
    const description =
      failed && authLine(err)
        ? "The key was refused. Reconnect."
        : failed
          ? err
          : needsAuth(c)
            ? "needs auth — reconnect"
            : oidcWho(live) !== ""
              ? oidcWho(live)
              : text(live.keyMask) !== ""
                ? text(live.keyMask)
                : identityPresent(live)
                  ? planCaption(connectionTitle(c), asDict(live.identity))
                  : "";
    const annotation =
      c.issue === "failed" || needsAuth(c) ? "" : live.account ? paintAccountAnnotation(live.account) : "";
    const health: UiHealth = c.issue === "failed" ? "failed" : needsAuth(c) ? "degraded" : "ok";
    const last = lastUsedModel(c, kernel, session);
    const pick = last === "" ? bestModel(modelsOf(c)) : last;
    const action: UiNode[] = [
      uiAction("kv/set", { params: { key: "connection", value: c.id, remember: "1" } }),
      ...(pick === "" ? [] : [uiAction("kv/set", { params: { key: "model", value: pick, remember: "1" } })]),
    ];
    return uiChoice({
      name: connectionTitle(c),
      annotation,
      description,
      healthStatus: health,
      healthAnnotation: err,
      action,
      alternateActions: [
        uiAction("connect/drop", {
          name: "Remove connection",
          hotkey: "control-x",
          params: { id: c.id },
        }),
      ],
    });
  };

  const offerAdoptable = (o: Record<string, unknown>): boolean => o.adoptable === true || o.adoptable === "true";

  const offerUrl = (o: Record<string, unknown>): string => text(asDict(o.settings).baseUrl);

  const offerMatchesConnection = (o: Record<string, unknown>, c: ConnectionSpec): boolean => {
    const oname = text(o.name);
    const ourl = offerUrl(o);
    if (ourl === "") return false;
    return (oname !== "" && oname === c.name) || ourl === connectionUrl(c);
  };

  const offerAdopted = (d: DriverSpec, o: Record<string, unknown>, wires: readonly ConnectionSpec[]): boolean =>
    wires.some((c) => c.driver?.name === d.name && offerMatchesConnection(o, c));

  const offerNode = (d: DriverSpec, o: Record<string, unknown>): UiNode => {
    const name = text(o.name);
    const description = text(o.description);
    if (offerAdoptable(o)) {
      return uiChoice({
        name,
        description,
        action: [
          uiAction("connect/adopt", {
            params: {
              driver: d.name,
              name,
              settings: asDict(o.settings),
            },
          }),
        ],
      });
    }
    return uiChoice({ name, description });
  };

  const driverOffers = (d: DriverSpec): readonly Record<string, unknown>[] => [...d.offers].map((o) => asDict(o));

  const offerRows = promptDrivers.flatMap((d) =>
    driverOffers(d)
      .filter((o) => !offerAdopted(d, o, connections))
      .map((o) => offerNode(d, o)),
  );

  const unusedDrivers = promptDrivers.filter((d) => !usedDrivers.has(d) && driverOffers(d).length === 0);

  const unusedDriverNode = (d: DriverSpec): UiNode => {
    const name = d.name || "";
    const description = d.description || "";
    if ((d.multiplicity || "") === "add-by-default") {
      return uiChoice({
        name,
        description,
        action: [
          uiAction("connect/adopt", {
            params: { driver: name, name },
          }),
        ],
      });
    }
    return uiChoice({ name, description });
  };

  return [...usedConnections.map(connectionNode), ...offerRows, ...unusedDrivers.map(unusedDriverNode)];
}

export function buildConnectSurface(kernel: KernelRoot, session?: SessionRoot): UiNode {
  return uiChoice({ choices: connectChoices(kernel, session) });
}

export function modelChoices(kernel: KernelRoot, session?: SessionRoot): readonly UiNode[] {
  const connections = Object.values(kernel.connections).filter((c) => driverCan(c.driver).includes("completion"));
  const ordered = [
    ...connections.filter((c) => modelsOf(c).length < 20),
    ...connections.filter((c) => modelsOf(c).length >= 20),
  ];
  const activeModel = session?.kvs.model ?? "";
  return ordered.flatMap((c) =>
    modelsOf(c).map((mid) =>
      uiChoice({
        name: mid,
        description: mid === activeModel ? `${c.id} · current` : c.id,
        action: [
          uiAction("kv/set", { params: { key: "connection", value: c.id, remember: "1" } }),
          uiAction("kv/set", { params: { key: "model", value: mid, remember: "1" } }),
        ],
      }),
    ),
  );
}

export function buildModelSurface(kernel: KernelRoot, session?: SessionRoot): UiNode {
  return uiChoice({
    action: [uiAction("kv/set", { name: "Set model", params: { key: "model", value: "", remember: "1" } })],
    choices: modelChoices(kernel, session),
  });
}

export function effortChoices(kernel: KernelRoot, session?: SessionRoot): readonly UiNode[] {
  const connectionId = text(session?.kvs.connection ?? kernel.kvs.connection).trim();
  const model = text(session?.kvs.model ?? kernel.kvs.model).trim();
  const conn = connectionId === "" ? undefined : kernel.connections[connectionId];
  const baseUrl = conn ? connectionUrl(conn) : "";
  const capRaw = conn && model !== "" ? asDict(liveOf(conn).modelCapabilities)[model] : undefined;
  const cap = asDict(capRaw);
  const rawEfforts = Array.isArray(cap.reasoningEfforts)
    ? cap.reasoningEfforts
        .map((item) => reasoningEffortOf(item))
        .filter((item): item is ReasoningEffort => item !== null)
    : undefined;
  const hint: ReasoningProfileHint = {
    supportsReasoning: typeof cap.supportsReasoning === "boolean" ? cap.supportsReasoning : undefined,
    reasoningEfforts: rawEfforts,
    baseUrl,
  };
  const profile = reasoningProfileFor(model, hint);
  const efforts: readonly ReasoningEffort[] =
    profile.supportsReasoning && profile.supportedEfforts.length > 0 ? profile.supportedEfforts : REASONING_EFFORTS;
  const kvEffort = reasoningEffortOf(session?.kvs.reasoningEffort ?? kernel.kvs.reasoningEffort);
  const agentEffort = reasoningEffortOf(session?.agent.spec.reasoningEffort);
  const effectiveCurrent = kvEffort ?? agentEffort ?? null;
  const hasWarmTrajectory = session?.head != null;
  const options: readonly ("" | ReasoningEffort)[] = ["", ...efforts];

  return options.map((effort) => {
    const name = effort === "" ? "default" : formatReasoningEffortLabel(effort);
    const isCurrent = effort === "" ? kvEffort === null : kvEffort === effort;
    const targetEffective = effort === "" ? agentEffort : effort;
    const impact = willEffortSwitchDropCache(profile, effectiveCurrent, targetEffective, hasWarmTrajectory);
    const statusTags: string[] = [];
    if (isCurrent) {
      statusTags.push("current");
    } else if (impact !== "preserve") {
      statusTags.push(impact === "drops-messages" ? "drops message cache" : "drops cache");
    }
    const descParts: string[] = [];
    if (effort === "" && agentEffort !== null) {
      descParts.push(`default (${formatReasoningEffortLabel(agentEffort)})`);
    }
    descParts.push(...statusTags);
    return uiChoice({
      name,
      description: descParts.join(" · "),
      annotation: statusTags.join(" · "),
      action: [
        uiAction("kv/set", {
          params: { key: "reasoningEffort", value: effort, remember: "1" },
        }),
      ],
    });
  });
}

export function buildEffortSurface(kernel: KernelRoot, session?: SessionRoot): UiNode {
  return uiChoice({
    action: [
      uiAction("kv/set", {
        name: "Set reasoning effort",
        params: { key: "reasoningEffort", value: "", remember: "1" },
      }),
    ],
    choices: effortChoices(kernel, session),
  });
}

export function mcpConnectionChoices(kernel: KernelRoot, session?: SessionRoot): readonly UiNode[] {
  const connections = Object.values(kernel.connections).filter((c) => driverCan(c.driver).includes("mcp"));
  return connections.map((c) => {
    const live = liveOf(c);
    const tools = live.tools;
    const n = tools == null ? 0 : asList(tools).length;
    const sessionDisabledKey = `mcp-disabled:${c.id}`;
    const sessionDisabled = (session?.kvs[sessionDisabledKey] ?? "") !== "";
    const kernelDisabled = asDict(c.configuration).enabled === false;
    const authNeeded = needsAuth(c);
    const health: UiHealth =
      c.issue === "failed" ? "failed" : authNeeded || (text(c.readyState) === "ready" && n === 0) ? "degraded" : "ok";
    const err = text(c.error);
    const description =
      c.issue === "failed" && err !== ""
        ? err
        : authNeeded
          ? "needs auth"
          : sessionDisabled
            ? "disabled (this session)"
            : kernelDisabled
              ? "disabled"
              : text(c.readyState) === "ready" && n === 0
                ? "ready · 0 tools"
                : "";
    const annotation =
      n === 0 || c.issue === "failed" || authNeeded || sessionDisabled || kernelDisabled
        ? ""
        : n === 1
          ? "1 tool"
          : `${n} tools`;
    const disableAction = sessionDisabled
      ? uiAction("kv/clear", { name: "Enable this session", params: { key: sessionDisabledKey } })
      : uiAction("kv/set", { name: "Disable this session", params: { key: sessionDisabledKey, value: "1" } });
    const alternateActions: UiNode[] = [
      disableAction,
      ...(authNeeded
        ? [
            uiAction("connect/login", { name: "Authenticate", params: { id: c.id } }),
            uiAction("connect/logout", { name: "Clear auth", params: { id: c.id } }),
          ]
        : []),
      uiAction("connect/drop", {
        name: "Remove connection",
        hotkey: "control-x",
        params: { id: c.id },
      }),
    ];
    return uiChoice({
      name: c.name && c.name !== "" ? c.name : c.id,
      annotation,
      description,
      healthStatus: health,
      healthAnnotation: err,
      alternateActions,
    });
  });
}

export function buildMcpSurface(kernel: KernelRoot, session?: SessionRoot): UiNode {
  const addRow = uiChoice({
    name: "Add MCP",
    description: "Paste an https:// URL or a stdio command",
    action: [uiAction("mcp-server/adopt", { name: "Add MCP" })],
  });
  return uiChoice({
    action: [uiAction("mcp-server/adopt", { name: "Add MCP", params: { input: "" } })],
    alternateActions: [uiAction("mcp-server/adopt", { name: "Add MCP", hotkey: "control-n", params: { input: "" } })],
    choices: [...mcpConnectionChoices(kernel, session), addRow],
  });
}

export const DEFAULT_PLUGIN_CATALOG = [
  {
    pluginName: "tasks",
    npmName: "@inhuman.tools/plugin-tasks",
    alias: ["todos"],
    description: "Session notebook pages with a frozen exam, and project promotion of an accepted task.",
  },
  {
    pluginName: "fusion",
    npmName: "@inhuman.tools/plugin-fusion",
    alias: ["plan"],
    description: "Session planner. One round-end note fuses the plan with a granted memory read.",
  },
  {
    pluginName: "inhuman-plugin-goal",
    npmName: "@inhuman.tools/plugin-goal",
    alias: ["goal", "goals"],
    description: "Single-session goal. The foreground hook continues it. /goal is a command file.",
  },
  {
    pluginName: "offload-tingle",
    npmName: "@inhuman.tools/plugin-offload-tingle",
    alias: ["memory"],
    description: "Cited project memory. Writer commits; scout searches. SQLite is an optional adapter.",
  },
] as const;

export function pluginChoices(kernel: KernelRoot): readonly UiNode[] {
  const installed = Object.values(kernel.plugins ?? {});
  const installedNames = new Set<string>();
  const installedNpm = new Set<string>();
  const rows: UiNode[] = installed.map((plugin) => {
    const name = plugin.pluginName.trim() !== "" ? plugin.pluginName.trim() : plugin.id;
    installedNames.add(name);
    if (plugin.sourceNpm.trim() !== "") installedNpm.add(plugin.sourceNpm.trim());
    const seed = DEFAULT_PLUGIN_CATALOG.find((item) => item.pluginName === name || item.npmName === plugin.sourceNpm);
    const problem = text(plugin.problem).trim();
    const health: UiHealth = problem !== "" ? "failed" : !plugin.enabled ? "degraded" : "ok";
    const tags: string[] = [];
    if (plugin.sourceVersion.trim() !== "") tags.push(plugin.sourceVersion.trim());
    if (!plugin.enabled) tags.push("disabled");
    else if (!plugin.foreground) tags.push("background only");
    const annotation = tags.join(" · ");
    const description =
      problem !== ""
        ? problem
        : plugin.description.trim() !== ""
          ? plugin.description.trim()
          : (seed?.description ?? plugin.sourceNpm.trim());
    const toggleEnabled = uiAction("plugin/set", {
      name: plugin.enabled ? "Disable plugin" : "Enable plugin",
      params: { name, enabled: !plugin.enabled },
    });
    const toggleForeground = uiAction("plugin/set", {
      name: plugin.foreground ? "Disable foreground" : "Enable foreground",
      hotkey: "control-f",
      params: { name, foreground: !plugin.foreground },
    });
    const removePlugin = uiAction("plugin/remove", {
      name: "Remove plugin",
      hotkey: "control-x",
      params: { name, confirm: false },
    });
    return uiChoice({
      name,
      alias: seed?.alias ?? [],
      annotation,
      description,
      healthStatus: health,
      healthAnnotation: problem,
      action: [toggleEnabled],
      alternateActions: [toggleForeground, removePlugin],
    });
  });
  for (const seed of DEFAULT_PLUGIN_CATALOG) {
    if (installedNames.has(seed.pluginName) || installedNpm.has(seed.npmName)) continue;
    rows.push(
      uiChoice({
        name: seed.pluginName,
        alias: seed.alias,
        annotation: "not installed",
        description: seed.description,
        healthStatus: "degraded",
        action: [
          uiAction("plugin/install", {
            name: "Install plugin",
            params: { spec: seed.npmName },
          }),
        ],
      }),
    );
  }
  return rows;
}

export function buildPluginsSurface(kernel: KernelRoot): UiNode {
  const installRow = uiChoice({
    name: "Install plugin",
    description: "Install an npm package, path, or file: URL",
    action: [uiAction("plugin/install", { name: "Install plugin" })],
  });
  return uiChoice({
    action: [uiAction("plugin/install", { name: "Install plugin", params: { spec: "" } })],
    alternateActions: [
      uiAction("plugin/install", { name: "Install plugin", hotkey: "control-n", params: { spec: "" } }),
    ],
    choices: [...pluginChoices(kernel), installRow],
  });
}

export function buildCompactSurface(): UiNode {
  return uiChoice({
    action: [uiAction("compact", { params: { focus: "" } })],
  });
}

function goalStatusLine(reply: unknown): string {
  if (reply == null || typeof reply !== "object") return "";
  const r = asDict(reply);
  if (!r.ok) return text(r.error);
  const goal = asDict(r.value);
  if (goal.status === "none") return "no goal";
  return `${text(goal.status)} · ${String(goal.loops ?? 0)} loops left · ${text(goal.text)}`;
}

function planStatusLine(reply: unknown): string {
  if (reply == null || typeof reply !== "object") return "";
  const r = asDict(reply);
  if (!r.ok) return text(r.error);
  const plan = asDict(r.value);
  if (plan.status === "none") return "no plan";
  return `${text(plan.status)} · ${String(plan.steps ?? 0)} steps left · ${text(plan.text)}`;
}

function applyPluginStatusChoice(choices: readonly UiNode[], description: string): readonly UiNode[] {
  return choices.map((choice) =>
    choice.name === "status"
      ? new UiNode(
          choice.name,
          description,
          choice.aliases,
          choice.health,
          choice.healthAnnotation,
          choice.hotkey,
          choice.action,
          choice.alternateActions,
          choice.choices,
          choice.op,
          choice.params,
          choice.secret,
          choice.annotation,
        )
      : choice,
  );
}

// ---------------------------------------------------------------------------
// Static JSON UI reader (no Scheme interpreter)
// ---------------------------------------------------------------------------

export function evalUiDef(def: UiDefinition, config: UiEvalConfig = {}, effortContext = false): UiNode {
  switch (def.kind) {
    case "choice": {
      let choices: readonly UiNode[] = (def.choices ?? []).map((item) => evalUiDef(item, config));
      let action: readonly UiNode[] = (def.action ?? []).map((item) => evalUiDef(item, config));
      const context: string | undefined = effortContext ? "effort" : def.context;
      if (context === "connect" && config.kernel !== undefined) {
        choices = [...connectChoices(config.kernel, config.session), ...choices];
      } else if (context === "model" && config.kernel !== undefined) {
        choices = [...modelChoices(config.kernel, config.session), ...choices];
      } else if (context === "effort" && config.kernel !== undefined) {
        const surface = buildEffortSurface(config.kernel, config.session);
        choices = [...surface.choices, ...choices];
        if (action.length === 0) action = surface.action;
      } else if (context === "mcp" && config.kernel !== undefined) {
        choices = [...mcpConnectionChoices(config.kernel, config.session), ...choices];
      } else if (context === "plugins" && config.kernel !== undefined) {
        choices = [...pluginChoices(config.kernel), ...choices];
      } else if (context === "goal") {
        const reply = config.rpc?.("plugin/method", { plugin: "inhuman-plugin-goal", method: "get" });
        choices = applyPluginStatusChoice(choices, goalStatusLine(reply));
      } else if (context === "plan") {
        const reply = config.rpc?.("plugin/method", { plugin: "fusion", method: "get" });
        choices = applyPluginStatusChoice(choices, planStatusLine(reply));
      }
      return uiChoice({
        name: def.name,
        description: def.description,
        annotation: def.annotation,
        alias: def.alias,
        healthStatus: def.healthStatus,
        healthAnnotation: def.healthAnnotation,
        hotkey: def.hotkey,
        action,
        alternateActions: (def.alternateActions ?? []).map((item) => evalUiDef(item, config)),
        choices,
        secret: def.secret,
      });
    }
    case "action":
      return uiAction(def.op, {
        name: def.name ?? def.op,
        description: def.description,
        hotkey: def.hotkey,
        alias: def.alias,
        params: def.params,
      });
    case "confirm":
      return uiConfirm(config.pending ?? "", {
        title: def.title ?? "Confirm",
        name: def.name,
        description: def.description,
      });
    case "input":
      return uiInput(config.pending ?? "", {
        name: def.name ?? "Input",
        description: def.description,
        secret: def.secret,
      });
    case "open-url":
      return uiOpenUrl(config.pending ?? "", {
        url: def.url,
        name: def.name ?? "Continue",
        description: def.description,
        input: def.input,
      });
    case "notice":
      return uiNotice(config.pending ?? "", {
        message: def.message,
        name: def.name,
        description: def.description,
      });
  }
}

function parseUiDefinitionCompat(
  source: string,
): { readonly def: UiDefinition; readonly effortContext: boolean } | null {
  const direct = parseUiDefinition(source);
  if (direct !== null) return { def: direct, effortContext: false };
  if (!source.includes("effort")) return null;
  const adapted = source
    .replaceAll(/("context"\s*:\s*)"effort"/g, '$1"model"')
    .replaceAll(/(:context\s+)"effort"/g, '$1"model"');
  if (adapted === source) return null;
  const fallback = parseUiDefinition(adapted);
  if (fallback?.kind !== "choice" || fallback.context !== "model") return null;
  return { def: fallback, effortContext: true };
}

export function evalUiSurface(source: string, config: UiEvalConfig = {}): UiNode | undefined {
  const parsed = parseUiDefinitionCompat(source);
  if (parsed === null) return undefined;
  return evalUiDef(parsed.def, config, parsed.effortContext);
}

export async function evalUiSurfaceAsync(source: string, config: UiEvalConfig = {}): Promise<UiNode | undefined> {
  const parsed = parseUiDefinitionCompat(source);
  if (parsed === null) return undefined;
  const { def, effortContext } = parsed;
  if (config.rpc !== undefined && def.kind === "choice" && (def.context === "goal" || def.context === "plan")) {
    const plugin = def.context === "goal" ? "inhuman-plugin-goal" : "fusion";
    const reply = await config.rpc("plugin/method", { plugin, method: "get" });
    return evalUiDef(
      def,
      {
        ...config,
        rpc: () => reply,
      },
      effortContext,
    );
  }
  return evalUiDef(def, config, effortContext);
}
