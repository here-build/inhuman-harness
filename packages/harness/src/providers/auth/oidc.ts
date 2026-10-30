/**
 * OAuth/OIDC authorization-code + PKCE and refresh. No OpenAI connection,
 * no vendor roster. Tea injects redirect_uri after it binds the loopback.
 */
import { createHash, randomBytes } from "node:crypto";

import { postForm, wrapFetchFailure } from "./fetch.js";
import { asExpiresIn, asNonEmpty, asPositiveInt, asRecord, parseJsonUnknown } from "./json.js";

export const OIDC_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const OIDC_REFRESH_MS = 60_000;
/** Fail-backoff is `nowMs - refreshFailedAtMs`, not `setTimeout`. */
export const OIDC_REFRESH_BACKOFF_MS = 30_000;

export type OidcProfile = {
  readonly driver: string;
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly userinfoUrl: string;
  readonly scope: string;
  readonly extraAuthorize: Readonly<Record<string, string>>;
  readonly loginHint: string;
  readonly baseUrl: string;
  /** Injected transport; defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
};

export type OidcPkce = {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
  readonly url: string;
};

export type OidcTokens = {
  readonly apiKey: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly idToken?: string;
  readonly accountId?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly plan?: string;
};

export type OidcIdentity = {
  readonly accountId?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly plan?: string;
};

/** JWT claim namespace some issuers nest account fields under. */
const NESTED_AUTH_CLAIMS = "https://api.openai.com/auth";

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function mintOidcPkce(profile: OidcProfile): OidcPkce {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  return oidcFromVerifier(profile, verifier, state);
}

export function oidcFromVerifier(profile: OidcProfile, verifier: string, state: string): OidcPkce {
  const challenge = pkceChallenge(verifier);
  const url = new URL(profile.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", profile.clientId);
  url.searchParams.set("scope", profile.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(profile.extraAuthorize)) {
    url.searchParams.set(key, value);
  }
  return { verifier, challenge, state, url: url.toString() };
}

export async function exchangeOidcCode(
  profile: OidcProfile,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OidcTokens> {
  return tokenGrant(profile, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: profile.clientId,
    code_verifier: verifier,
  });
}

export async function refreshOidcToken(profile: OidcProfile, refreshToken: string): Promise<OidcTokens> {
  return tokenGrant(
    profile,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: profile.clientId,
    },
    refreshToken,
  );
}

export function accessTokenExpiring(expiresAt: string | undefined, now = Date.now()): boolean {
  if (expiresAt === undefined || expiresAt.trim() === "") return false;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return false;
  return at - now <= OIDC_REFRESH_SKEW_MS;
}

export function secretsFromTokens(tokens: OidcTokens): Record<string, string> {
  return {
    apiKey: tokens.apiKey,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.idToken === undefined ? {} : { idToken: tokens.idToken }),
    ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
    ...(tokens.displayName === undefined ? {} : { displayName: tokens.displayName }),
    ...(tokens.email === undefined ? {} : { email: tokens.email }),
    ...(tokens.plan === undefined ? {} : { plan: tokens.plan }),
  };
}

export function identityFromClaims(claims: Record<string, unknown> | null): OidcIdentity {
  if (claims === null) return {};
  const auth = asRecord(claims[NESTED_AUTH_CLAIMS]);
  const given = asNonEmpty(claims.given_name) ?? asNonEmpty(claims.first_name) ?? asNonEmpty(claims.firstName);
  const family = asNonEmpty(claims.family_name) ?? asNonEmpty(claims.last_name) ?? asNonEmpty(claims.lastName);
  const composed = given !== undefined && family !== undefined ? `${given} ${family}` : (given ?? family);
  const email = asNonEmpty(claims.email) ?? asNonEmpty(auth?.email);
  const displayName =
    asNonEmpty(claims.name) ??
    asNonEmpty(claims.preferred_username) ??
    asNonEmpty(claims.nickname) ??
    asNonEmpty(claims.username) ??
    asNonEmpty(claims.login) ??
    asNonEmpty(claims.handle) ??
    composed ??
    email;
  const plan =
    asNonEmpty(auth?.chatgpt_plan_type) ??
    asNonEmpty(claims.chatgpt_plan_type) ??
    asNonEmpty(claims.plan) ??
    asNonEmpty(claims.subscription) ??
    asNonEmpty(claims.subscription_tier) ??
    asNonEmpty(claims.subscriptionTier) ??
    asNonEmpty(claims.tier);
  // `sub` is the OIDC subject, not a vendor account id.
  const accountId =
    asNonEmpty(auth?.chatgpt_account_id) ??
    asNonEmpty(claims.chatgpt_account_id) ??
    asNonEmpty(claims.userId) ??
    asNonEmpty(claims.user_id) ??
    asNonEmpty(claims.account_id);
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(email === undefined ? {} : { email }),
    ...(plan === undefined ? {} : { plan }),
  };
}

/** Later non-empty fields win. */
export function mergeOidcIdentity(...parts: readonly OidcIdentity[]): OidcIdentity {
  const out: {
    accountId?: string;
    displayName?: string;
    email?: string;
    plan?: string;
  } = {};
  for (const part of parts) {
    if (part.accountId !== undefined && part.accountId !== "") out.accountId = part.accountId;
    if (part.displayName !== undefined && part.displayName !== "") out.displayName = part.displayName;
    if (part.email !== undefined && part.email !== "") out.email = part.email;
    if (part.plan !== undefined && part.plan !== "") out.plan = part.plan;
  }
  return out;
}

export function secretsFromIdentity(identity: OidcIdentity): Record<string, string> {
  return {
    ...(identity.accountId === undefined ? {} : { accountId: identity.accountId }),
    ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.plan === undefined ? {} : { plan: identity.plan }),
  };
}

export function tokensFromGrantBody(
  rec: Record<string, unknown> | null,
  driver: string,
  fallbackRefresh = "",
): OidcTokens {
  const apiKey = asNonEmpty(rec?.access_token);
  const refreshToken = asNonEmpty(rec?.refresh_token) ?? asNonEmpty(fallbackRefresh);
  if (apiKey === undefined) throw new Error(`${driver} token exchange returned no access token`);
  if (refreshToken === undefined) throw new Error(`${driver} token exchange returned no refresh token`);
  const idToken = asNonEmpty(rec?.id_token);
  const user = asRecord(rec?.user);
  const userId = asNonEmpty(user?.id);
  return {
    apiKey,
    refreshToken,
    expiresAt: expiresAtOf(rec?.expires_in, apiKey),
    ...(idToken === undefined ? {} : { idToken }),
    ...mergeOidcIdentity(
      identityFromClaims(jwtPayload(idToken) ?? jwtPayload(apiKey)),
      // Non-standard `user` object (WorkOS): `{id, email, first_name, ...}`.
      identityFromClaims(user),
      userId === undefined ? {} : { accountId: userId },
    ),
  };
}

/** `expires_in` when sent, else the access token's JWT `exp`, else one hour. */
function expiresAtOf(expiresIn: unknown, accessToken: string): string {
  if (asPositiveInt(expiresIn) === undefined) {
    const exp = jwtPayload(accessToken)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return new Date(exp * 1000).toISOString();
  }
  return new Date(Date.now() + asExpiresIn(expiresIn) * 1000).toISOString();
}

/** A token endpoint refusal. `code` is the OAuth `error` field when the body had one. */
export class OidcGrantError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "OidcGrantError";
  }
}

async function tokenGrant(
  profile: OidcProfile,
  body: Record<string, string>,
  fallbackRefresh = "",
): Promise<OidcTokens> {
  const response = await postForm(profile.tokenUrl, body, `${profile.driver} token`, profile.fetch);
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = asNonEmpty(asRecord(await response.json())?.error);
    } catch {
      /* no JSON body */
    }
    throw new OidcGrantError(`${profile.driver} token exchange failed (${response.status})`, response.status, code);
  }
  return tokensFromGrantBody(asRecord(await response.json()), profile.driver, fallbackRefresh);
}

export async function fetchOidcUserinfo(
  profile: Pick<OidcProfile, "driver" | "userinfoUrl">,
  accessToken: string,
): Promise<OidcIdentity> {
  if (profile.userinfoUrl.length === 0) return {};
  let response: Response;
  try {
    response = await fetch(profile.userinfoUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (error) {
    throw wrapFetchFailure(error, {
      why: `${profile.driver} userinfo`,
      method: "GET",
      url: profile.userinfoUrl,
    });
  }
  if (!response.ok) return {};
  try {
    return identityFromClaims(asRecord(await response.json()));
  } catch {
    return {};
  }
}

export function jwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (token === undefined || token.trim() === "") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return asRecord(parseJsonUnknown(json));
  } catch {
    return null;
  }
}
