/**
 * @inhuman.tools/harness-provider-auth — OAuth/OIDC/PKCE/device-flow/refresh
 * primitives. Not an OpenAI connection subclass, not a vendor provider, not
 * a connection registry.
 */

export * from "./device.js";
export {
  authorizeInBrowser as authorizeInBrowser,
  BROWSER_SIGN_IN_TIMEOUT_MS as BROWSER_SIGN_IN_TIMEOUT_MS,
  type BrowserAuthorization as BrowserAuthorization,
  type BrowserAuthorizeOptions as BrowserAuthorizeOptions,
  type BrowserAuthorizeUi as BrowserAuthorizeUi,
} from "./authorize.js";
export {
  accessTokenExpiring as accessTokenExpiring,
  exchangeOidcCode as exchangeOidcCode,
  fetchOidcUserinfo as fetchOidcUserinfo,
  identityFromClaims as identityFromClaims,
  jwtPayload as jwtPayload,
  mergeOidcIdentity as mergeOidcIdentity,
  mintOidcPkce as mintOidcPkce,
  oidcFromVerifier as oidcFromVerifier,
  OIDC_REFRESH_BACKOFF_MS as OIDC_REFRESH_BACKOFF_MS,
  OIDC_REFRESH_MS as OIDC_REFRESH_MS,
  OIDC_REFRESH_SKEW_MS as OIDC_REFRESH_SKEW_MS,
  pkceChallenge as pkceChallenge,
  refreshOidcToken as refreshOidcToken,
  secretsFromIdentity as secretsFromIdentity,
  secretsFromTokens as secretsFromTokens,
  type OidcIdentity as OidcIdentity,
  type OidcPkce as OidcPkce,
  type OidcProfile as OidcProfile,
  type OidcTokens as OidcTokens,
} from "./oidc.js";
