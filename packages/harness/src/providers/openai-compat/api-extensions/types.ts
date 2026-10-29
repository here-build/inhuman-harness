import invariant from "tiny-invariant";

/**
 * Normalized account snapshot: identity + optional remaining funds.
 */
export type IdentityView = {
  shortName: string;
  name: string;
};

export type KeyMask = `${string}...${string}`;

export type IdentityDetail = IdentityView & {
  kind: "user" | "key" | "org" | "project" | "subscription";
  id?: string;
  email?: string;
  handle?: string;
  plan?: string;
  planId?: string;
  org?: IdentityView & { id?: string };
  project?: IdentityView & { id?: string };
  team?: IdentityView & { id?: string };
  key?: { id?: string; label?: string; mask: KeyMask };
  status?: "ok" | "suspended" | "limited" | "unknown";
};

export type CurrencyKind = "fiat" | "credits" | "points" | "crypto";

export type CurrencyView = {
  code: string;
  symbol?: string;
};

export type CurrencyDetail = CurrencyView & {
  kind: CurrencyKind;
  name?: string;
  digits?: number;
};

export type Money = {
  amount: string;
  currency: CurrencyDetail;
};

export type UsageWindow = {
  label: string;
  /** Percentage of the window still available, normalized across providers. */
  remainingPercent: number;
  /** Seconds until this window resets, from the snapshot instant. */
  resetInSec?: number;
  /** Unix seconds when this window resets, when the provider sent an absolute time. */
  resetAt?: number;
  status?: "ok" | "exhausted";
  limit?: Money;
};

export type BalanceView = {
  balance: string;
  currency: CurrencyView;
};

export type BalanceDetail = {
  remaining?: Money;
  canSpend?: boolean;
  unlimited?: boolean;
  asOf?: string;
  cash?: Money;
  voucher?: Money;
  granted?: Money;
  toppedUp?: Money;
  purchased?: Money;
  used?: Money;
  limit?: Money | null;
  other?: Money[];
  windows?: UsageWindow[];
};

export type AccountSnapshot = {
  identity: IdentityView;
  identityDetail: IdentityDetail;
  balance?: BalanceView;
  balanceDetail?: BalanceDetail;
};

export type AccountRequest = {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Extra request headers (ChatGPT account id, Grok CLI fingerprint). */
  readonly headers?: Readonly<Record<string, string>>;
};

const KEY_HEADS = ["sk-or-", "sk-", "cpk_", "flp_", "gsk_"] as const;
const SHORT_MASK = "••••...••••" as const satisfies KeyMask;

export function maskSecret(secret: string): KeyMask {
  if (secret.length < 8) return SHORT_MASK;
  const branded = KEY_HEADS.find((head) => secret.startsWith(head));
  const prefix = branded ?? secret.slice(0, 8);
  return `${prefix}...${secret.slice(-4)}`;
}

export function nonempty(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function majorAmount(value: number | string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    invariant(trimmed !== "", `empty amount ${value}`);
    invariant(Number.isFinite(Number(trimmed)), `invalid amount ${value}`);
    return trimmed;
  }
  if (!Number.isFinite(value)) throw new Error(`invalid amount ${value}`);
  return String(value);
}

export function unscale(value: number | string, divisor: number, digits: number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) throw new Error(`invalid amount ${value}`);
  return (n / divisor).toFixed(digits);
}

export function fiat(code: string, symbol?: string): CurrencyDetail {
  return {
    code,
    kind: "fiat",
    digits: 2,
    ...(symbol === undefined ? {} : { symbol }),
  };
}

export function usd(): CurrencyDetail {
  return fiat("USD", "$");
}

export function money(amount: number | string, currency: CurrencyDetail): Money {
  return { amount: majorAmount(amount), currency };
}

export function balanceView(remaining: Money): BalanceView {
  return {
    balance: remaining.amount,
    currency: {
      code: remaining.currency.code,
      ...(remaining.currency.symbol === undefined ? {} : { symbol: remaining.currency.symbol }),
    },
  };
}

export type IdentityParts = {
  kind: IdentityDetail["kind"];
  handle?: string;
  email?: string;
  displayName?: string;
  orgSlug?: string;
  orgName?: string;
  orgId?: string;
  projectName?: string;
  projectSlug?: string;
  projectId?: string;
  teamName?: string;
  teamId?: string;
  id?: string;
  plan?: string;
  planId?: string;
  status?: IdentityDetail["status"];
  apiKey?: string;
  keyId?: string;
  keyLabel?: string;
};

function firstToken(value: string): string {
  return value.trim().split(/\s+/u)[0] ?? value.trim();
}

function emailLocal(email: string): string | undefined {
  const local = nonempty(email.split("@")[0]);
  return local;
}

function named(view: IdentityView, id?: string): IdentityView & { id?: string } {
  return id === undefined ? view : { ...view, id };
}

export function snapshotIdentity(parts: IdentityParts): Pick<AccountSnapshot, "identity" | "identityDetail"> {
  const handle = nonempty(parts.handle);
  const email = nonempty(parts.email);
  const displayName = nonempty(parts.displayName);
  const orgSlug = nonempty(parts.orgSlug);
  const orgName = nonempty(parts.orgName);
  const projectName = nonempty(parts.projectName);
  const projectSlug = nonempty(parts.projectSlug);
  const id = nonempty(parts.id);
  const apiKey = nonempty(parts.apiKey);
  const mask = apiKey === undefined ? undefined : maskSecret(apiKey);
  const shortFromKey = apiKey === undefined ? undefined : apiKey.length < 8 ? "••••" : mask;
  const shortName =
    handle ??
    (email === undefined ? undefined : emailLocal(email)) ??
    (displayName === undefined ? undefined : firstToken(displayName)) ??
    orgSlug ??
    (id === undefined ? undefined : id.slice(0, 8)) ??
    shortFromKey ??
    "••••";
  const orgProject = orgName !== undefined && projectName !== undefined ? `${orgName} / ${projectName}` : undefined;
  const name = displayName ?? email ?? orgProject ?? shortName;
  const identity: IdentityView = { shortName, name };
  const org =
    orgName === undefined && orgSlug === undefined && parts.orgId === undefined
      ? undefined
      : named(
          {
            shortName: orgSlug ?? orgName ?? parts.orgId ?? shortName,
            name: orgName ?? orgSlug ?? parts.orgId ?? shortName,
          },
          parts.orgId,
        );
  const project =
    projectName === undefined && projectSlug === undefined && parts.projectId === undefined
      ? undefined
      : named(
          {
            shortName: projectSlug ?? projectName ?? parts.projectId ?? shortName,
            name: projectName ?? projectSlug ?? parts.projectId ?? shortName,
          },
          parts.projectId,
        );
  const teamName = nonempty(parts.teamName);
  const team =
    teamName === undefined && parts.teamId === undefined
      ? undefined
      : named(
          {
            shortName: teamName ?? parts.teamId ?? shortName,
            name: teamName ?? parts.teamId ?? shortName,
          },
          parts.teamId,
        );
  const keyLabel = nonempty(parts.keyLabel);
  const keyId = nonempty(parts.keyId);
  const key =
    mask === undefined
      ? undefined
      : {
          mask,
          ...(keyId === undefined ? {} : { id: keyId }),
          ...(keyLabel === undefined ? {} : { label: keyLabel }),
        };
  const identityDetail: IdentityDetail = {
    ...identity,
    kind: parts.kind,
    ...(id === undefined ? {} : { id }),
    ...(email === undefined ? {} : { email }),
    ...(handle === undefined ? {} : { handle }),
    ...(nonempty(parts.plan) === undefined ? {} : { plan: nonempty(parts.plan) }),
    ...(nonempty(parts.planId) === undefined ? {} : { planId: nonempty(parts.planId) }),
    ...(org === undefined ? {} : { org }),
    ...(project === undefined ? {} : { project }),
    ...(team === undefined ? {} : { team }),
    ...(key === undefined ? {} : { key }),
    ...(parts.status === undefined ? {} : { status: parts.status }),
  };
  return { identity, identityDetail };
}

export function withFunds(
  identity: Pick<AccountSnapshot, "identity" | "identityDetail">,
  remaining: Money | undefined,
  detail: BalanceDetail | undefined,
): AccountSnapshot {
  const balanceDetail = remaining === undefined ? detail : { ...detail, remaining };
  return {
    ...identity,
    ...(remaining === undefined ? {} : { balance: balanceView(remaining) }),
    ...(balanceDetail === undefined ? {} : { balanceDetail }),
  };
}
