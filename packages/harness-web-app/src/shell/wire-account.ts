import { connectError } from "./connect-error.js";

/**
 * Who a connection is signed in as and what it has left, read from the
 * connection's live self-report. Same order as `/connect` (connect.scm):
 * a connection failure, else an auth failure (the sentence says to reconnect),
 * else the signed-in person, else an ellipsis for the key mask, else the plan.
 * A timeout or a refused socket on a failed wire is the connection failure,
 * including when `live.auth` is also set. A refused key, or `live.auth` with
 * no connection failure, is the auth failure. The raw error stays on `detail`.
 * The annotation is the balance, then each quota window.
 */

/** Enough of a connection's live facts to paint its account. */
export type AccountSource = {
  readonly readyState?: string | null;
  readonly error?: string;
  readonly live?: {
    readonly auth?: unknown;
    readonly identity?: unknown;
    readonly keyMask?: unknown;
    readonly account?: unknown;
  } | null;
};

/** One usage window; paint spells the countdown from `resetAt` (Unix seconds). */
export type QuotaWindow = { readonly remainingPercent: number; readonly label?: string; readonly resetAt?: number };

/** At or under this share left, a window is running out. */
export const QUOTA_LOW_PERCENT = 20;

export type WireAccount = {
  readonly failed: boolean;
  /** The painted failure, the signed-in person, an ellipsis for a key, or the plan. */
  readonly description: string;
  /** The raw failure or key mask when `description` is the painted form. */
  readonly detail: string;
  /** Painted balance, e.g. `$74.75` or `1200 CRED`. */
  readonly balance: string;
  readonly windows: readonly QuotaWindow[];
};

export function wireAccount(spec: AccountSource, provider = ""): WireAccount {
  const live = record(spec.live);
  const needsAuth = text(live.auth) === "needs-auth";
  const failed = spec.readyState === "failed" || needsAuth;
  const identity = record(live.identity);
  const account = record(live.account);
  const error = text(spec.error);
  const who = text(identity.displayName) || text(identity.email);
  const mask = text(live.keyMask);
  const failure = spec.readyState === "failed" && error !== "" ? connectError(provider, error) : null;
  const auth = failure?.kind === "auth" || (needsAuth && failure?.kind !== "connection");
  const description = auth
    ? failure?.kind === "auth"
      ? failure.summary
      : "needs auth — reconnect"
    : ([failure?.summary ?? "", who, mask === "" ? "" : "…", text(identity.plan)].find((part) => part !== "") ?? "");
  const detail = auth ? error : (failure?.detail ?? (mask !== "" && description === "…" ? mask : ""));
  return {
    failed,
    description,
    detail,
    balance: failed ? "" : paintBalance(record(account.balance)),
    windows: failed ? [] : quotaWindows(record(account.balanceDetail).windows),
  };
}

/** One window, short enough for the menu: `62% left · 5h`. Empty once its reset has passed. */
export function quotaLine(window: QuotaWindow, nowMs: number): string {
  if (window.resetAt !== undefined && window.resetAt * 1000 - nowMs <= 0) return "";
  const left = `${window.remainingPercent}% left`;
  const label = window.label?.trim() ?? "";
  return label === "" ? left : `${left} · ${label}`;
}

/** Live windows, one line each. A window at or under a fifth is `low`. */
export function accountWindowLines(
  account: WireAccount,
  nowMs: number,
): readonly { readonly text: string; readonly low: boolean }[] {
  return account.windows.flatMap((window) => {
    const line = quotaLine(window, nowMs);
    if (line === "") return [];
    return [{ text: line, low: window.remainingPercent <= QUOTA_LOW_PERCENT }];
  });
}

/** Balance, then each live quota window: `$74.75 · 84% weekly left; resets in 6d 21h`. */
export function accountAnnotation(account: WireAccount, nowMs: number): string {
  return [account.balance, ...account.windows.map((window) => paintWindow(window, nowMs))]
    .filter((bit) => bit !== "")
    .join(" · ");
}

/** Some live window is nearly spent. */
export function accountLow(account: WireAccount, nowMs: number): boolean {
  return account.windows.some(
    (window) => window.remainingPercent <= QUOTA_LOW_PERCENT && paintWindow(window, nowMs) !== "",
  );
}

function paintBalance(view: Record<string, unknown>): string {
  const currency = record(view.currency);
  const mark = text(currency.symbol);
  const code = text(currency.code);
  const raw = text(view.balance);
  const n = Number(raw);
  const body =
    raw === "" || !Number.isFinite(n)
      ? raw
      : n > 0 && Math.round(n * 100) === 0
        ? `<${mark}0.01`
        : `${n < 0 ? "-" : ""}${mark}${Math.abs(n).toFixed(2)}`;
  return body === "" || mark !== "" || code === "" ? body : `${body} ${code}`;
}

function quotaWindows(rows: unknown): QuotaWindow[] {
  if (!Array.isArray(rows)) return [];
  const windows: QuotaWindow[] = [];
  for (const row of rows) {
    const { remainingPercent, label, resetAt } = record(row);
    const left = numberOf(remainingPercent);
    if (left === undefined) continue;
    const at = numberOf(resetAt);
    const name = text(label);
    windows.push({
      remainingPercent: Math.round(Math.min(100, Math.max(0, left))),
      ...(name === "" ? {} : { label: name }),
      ...(at === undefined ? {} : { resetAt: at }),
    });
  }
  return windows;
}

/** `10% weekly left; resets in 1d 18h`. */
function paintWindow(window: QuotaWindow, nowMs: number): string {
  const left = `${window.remainingPercent}%${window.label === undefined ? "" : ` ${window.label}`} left`;
  if (window.resetAt === undefined) return left;
  // A passed reset expires the snapshot, not just its countdown: hide it until the provider reports again.
  const remainingMs = window.resetAt * 1000 - nowMs;
  if (remainingMs <= 0) return "";
  const until = spellRemaining(remainingMs);
  return until === "" ? left : `${left}; resets in ${until}`;
}

/** The rounding of connect.scm `paint-reset`, spelled in units: `45m`, `2h 30m`, `1d 18h`. */
export function spellRemaining(remainingMs: number): string {
  const s = Math.max(0, Math.round(remainingMs / 1000));
  const mins = s === 0 ? 0 : Math.max(1, Math.trunc((s + 30) / 60));
  if (mins === 0) return "";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) {
    const h = Math.trunc(mins / 60);
    const m = mins % 60;
    if (m === 0 || m === 1) return hours(h);
    if (m === 59) return hours(h + 1);
    return `${h}h ${m}m`;
  }
  const d = Math.trunc(mins / 1440);
  const h = Math.trunc((mins % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

function hours(h: number): string {
  return h >= 24 ? `${Math.trunc(h / 24)}d` : `${h}h`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number | undefined {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
