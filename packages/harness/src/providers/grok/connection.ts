import { step } from "@inhuman.tools/harness-diagnostics";
import type { WebSearchResult } from "@inhuman.tools/harness-model";
import { action, computed, type IReactionDisposer, observable, reaction } from "mobx";
import invariant from "tiny-invariant";
import { z } from "zod";

import {
  accessTokenExpiring,
  authorizeInBrowser,
  exchangeOidcCode,
  identityFromClaims,
  jwtPayload,
  mergeOidcIdentity,
  mintOidcPkce,
  OIDC_REFRESH_BACKOFF_MS,
  refreshOidcToken,
  secretsFromIdentity,
  secretsFromTokens,
  type OidcIdentity,
} from "@/providers/auth";
import {
  describeHttpFailure,
  grokCacheAffinity,
  getGrokAccount,
  OpenAiCompatDriverConnection,
  openaiCompatLiveState,
  wrapFetchFailure,
  type AccountSnapshot,
  type CacheAffinity,
  type CacheAffinityRequest,
  type CacheFlavor,
} from "@/providers/openai-compat";
import { searchSignal } from "@/providers/web/wire";

import {
  chooseClientVersion,
  compareClientVersion,
  fetchPublishedGrokVersion,
  GROK_CLIENT_VERSION,
} from "./client-version.js";
import { grokHitsFromResponses } from "./search.js";
import { openaiCompatConfigurationSchema } from "../openai-compat/schema.js";

export { GROK_CLIENT_VERSION } from "./client-version.js";

export class GrokDriverConnection extends OpenAiCompatDriverConnection {
  static oidcProfile = {
    driver: "grok",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    userinfoUrl: "https://auth.x.ai/oauth2/userinfo",
    scope: "openid profile email offline_access grok-cli:access api:access",
    extraAuthorize: {},
    loginHint: "Authorize Grok in the browser",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
  };
  static override configurationLabel = "grok";
  static override configurationSchema = openaiCompatConfigurationSchema.extend({
    clientVersion: z.unknown().optional(),
  });
  static offers = [
    {
      name: "Grok",
      description: "Grok subscription",
      live: true,
      adoptable: true,
      settings: { baseUrl: "https://cli-chat-proxy.grok.com/v1" },
    },
  ];

  static override async adopt(
    args: {
      name?: string;
      settings?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    callback: (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<{
    readonly name?: string;
    readonly settings: Record<string, unknown>;
    readonly secrets: Record<string, string>;
  }> {
    const profile = GrokDriverConnection.oidcProfile;
    const minted = mintOidcPkce(profile);
    const authorized = await authorizeInBrowser((body) => callback("UI", body), {
      authUrl: minted.url,
      description: profile.loginHint,
      paste: "Browser on another machine? Paste the address it ended on",
      signal: args.signal,
    });
    invariant("code" in authorized, `${profile.driver} sign-in needs the browser callback (paste the redirect URL)`);
    invariant(
      minted.state === "" || authorized.state === "" || minted.state === authorized.state,
      `${profile.driver} sign-in state mismatch`,
    );
    const tokens = await exchangeOidcCode(profile, authorized.code, minted.verifier, authorized.redirectUri);
    return {
      name: typeof args.name === "string" ? args.name : undefined,
      settings: { ...(args.settings ?? {}), baseUrl: profile.baseUrl },
      secrets: secretsFromTokens(tokens),
    };
  }

  #refreshStop: IReactionDisposer | null = null;
  #writeSettings: ((patch: Readonly<Record<string, unknown>>) => void) | null = null;
  #clientVersion = GROK_CLIENT_VERSION;
  #versionDirty = false;
  #publishedFlight: Promise<string | null> | null = null;

  constructor(...args: ConstructorParameters<typeof OpenAiCompatDriverConnection>) {
    super(...args);
    const chosen = chooseClientVersion(this.settings);
    this.#clientVersion = chosen.version;
    this.#versionDirty = chosen.persist;
  }

  override bindSettingsWriter(write: (patch: Readonly<Record<string, unknown>>) => void): void {
    this.#writeSettings = write;
    this.#flushClientVersion();
  }

  @observable.shallow override accessor state = {
    ...openaiCompatLiveState(),
    identity: undefined as OidcIdentity | undefined,
  };

  @computed
  override get expiring(): boolean {
    this.readSecrets();
    return accessTokenExpiring(this.secretField("expiresAt"), this.nowMs);
  }

  @computed
  override get needsAuth(): boolean {
    this.readSecrets();
    if (this.secretField("apiKey") === undefined) return true;
    if (this.lastChallenge !== "none" && this.secretField("refreshToken") === undefined) return true;
    if (this.refreshFailedAtMs != null) return true;
    return false;
  }

  @computed
  override get fresh(): boolean {
    this.readSecrets();
    return this.secretField("apiKey") !== undefined && !this.expiring && !this.needsAuth;
  }

  override async bootstrap(): Promise<void> {
    this.startFreshnessWatch();
    await this.refreshSession();
    await super.bootstrap();
    await this.hydrateAccount();
  }

  protected startFreshnessWatch(): void {
    if (this.#refreshStop !== null) return;
    this.#refreshStop = reaction(
      () => {
        this.readSecrets();
        const backoffOk =
          this.refreshFailedAtMs == null || this.nowMs - this.refreshFailedAtMs >= OIDC_REFRESH_BACKOFF_MS;
        const eligible =
          (this.expiring || this.lastChallenge !== "none") &&
          this.secretField("refreshToken") !== undefined &&
          !this.needsAuth &&
          backoffOk;
        return eligible ? this.nowMs : 0;
      },
      (whenMs) => {
        if (whenMs !== 0) void this.refreshSession();
      },
      { fireImmediately: true },
    );
  }

  async hydrateAccount(): Promise<void> {
    const profile = GrokDriverConnection.oidcProfile;
    const access = this.secretField("apiKey");
    if (access === undefined) {
      this.reportLive();
      return;
    }
    try {
      const jwt = identityFromClaims(jwtPayload(this.secretField("idToken")) ?? jwtPayload(access));
      const stored: OidcIdentity = {
        accountId: this.secretField("accountId"),
        displayName: this.secretField("displayName"),
        email: this.secretField("email"),
        plan: this.secretField("plan"),
      };
      const userinfo = profile.userinfoUrl === "" ? {} : await this.#userinfo(profile.userinfoUrl);
      const merged = mergeOidcIdentity(jwt, stored, userinfo, await this.probeAccount());
      this.mergeSecrets(secretsFromIdentity(merged));
      await this.refreshAccount();
    } catch {
      this.reportLive();
    }
  }

  async #userinfo(url: string): Promise<OidcIdentity> {
    const res = await this.handshakeFetch(url, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return {};
    try {
      return identityFromClaims(asRecord(await res.json()));
    } catch {
      return {};
    }
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    this.#refreshStop?.();
    this.#refreshStop = null;
    await super[Symbol.asyncDispose]();
  }

  protected override async refreshGrant(): Promise<void> {
    const profile = GrokDriverConnection.oidcProfile;
    const refreshToken = this.secretField("refreshToken");
    if (refreshToken === undefined) return;
    if (!(this.expiring || this.lastChallenge !== "none")) return;
    step(`refresh start: connection=${this.connectionId}`);
    try {
      this.depositSecrets(secretsFromTokens(await refreshOidcToken(profile, refreshToken)));
      step(`refresh ok: connection=${this.connectionId}`);
    } catch {
      this.noteRefreshFailed();
      step(`refresh fail: connection=${this.connectionId}`);
    }
  }

  @action
  protected override reportLive(): void {
    super.reportLive();
    this.state.catalogName = "Grok";
    this.state.identity = this.#liveIdentity();
    this.state.keyMask = "";
  }

  #liveIdentity(): OidcIdentity {
    const jwt = identityFromClaims(jwtPayload(this.secretField("idToken")) ?? jwtPayload(this.secretField("apiKey")));
    return {
      displayName: this.secretField("displayName") ?? jwt.displayName,
      email: this.secretField("email") ?? jwt.email,
      plan: this.secretField("plan") ?? jwt.plan,
    };
  }

  protected override authHeaders(): Record<string, string> {
    const version = this.#clientVersion;
    return {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": version,
      "x-grok-client-identifier": "grok-shell",
      "user-agent": `xai-grok-cli/${version}`,
    };
  }

  /**
   * Both doors stamp {@link authHeaders}. A 426 that names an outdated client
   * version is the proxy's floor, not a failed turn: read the lockstepped crate,
   * keep it when it is newer, and retry the same request once.
   */
  override async authorizedFetch(
    ...args: Parameters<OpenAiCompatDriverConnection["authorizedFetch"]>
  ): Promise<Response> {
    return this.#fetchAllowingVersion(() => super.authorizedFetch(...args));
  }

  override async handshakeFetch(
    ...args: Parameters<OpenAiCompatDriverConnection["handshakeFetch"]>
  ): Promise<Response> {
    return this.#fetchAllowingVersion(() => super.handshakeFetch(...args));
  }

  override cacheFlavor(): CacheFlavor {
    return "grok";
  }

  async webSearch(req: {
    readonly query: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WebSearchResult> {
    const query = req.query.trim();
    if (query === "") {
      return { ok: false, text: "web_search: query is required — call web_search again with the text to search for" };
    }
    const url = this.responsesRequestUrl();
    const model = this.state.models.at(0) ?? this.settings.model ?? "grok-4";
    const limit = req.limit ?? 5;
    let res: Response;
    try {
      res = await this.authorizedFetch(
        url,
        {
          method: "POST",
          headers: { "x-grok-model-override": model },
          body: JSON.stringify({
            model,
            input: query,
            tools: [{ type: "web_search" }],
          }),
        },
        searchSignal(req.signal ?? AbortSignal.timeout(120_000)),
      );
    } catch (error) {
      if (req.signal?.aborted) throw error;
      return {
        ok: false,
        text: wrapFetchFailure(error, {
          method: "POST",
          url,
          why: "web-search",
        }).message,
      };
    }
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        text: describeHttpFailure({
          method: "POST",
          url,
          status: res.status,
          detail: text.trim().slice(0, 300),
        }),
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, text: "grok web-search: response was not JSON" };
    }
    return {
      ok: true,
      value: {
        results: grokHitsFromResponses(payload, limit),
        provider: "grok",
      },
    };
  }

  /**
   * Sticky replica for automatic prefix cache. Not auth.
   *
   * "we recommend setting the `x-grok-conv-id` HTTP header to maximize your
   * cache hit rate."
   * https://docs.x.ai/developers/advanced-api-usage/prompt-caching
   *
   * Header `x-grok-conv-id` + `x-grok-session-id` (same session id) and body
   * `prompt_cache_key`. Unique per-call ids go on `x-grok-req-id`.
   */
  override cacheAffinity(sessionId: string, model: string, request?: CacheAffinityRequest): CacheAffinity {
    const affinity = grokCacheAffinity(sessionId, request);
    const id = model.trim();
    if (id === "") return affinity;
    // The proxy routes on this header, not the JSON `model` field.
    return {
      headers: { ...affinity.headers, "x-grok-model-override": id },
      body: affinity.body,
    };
  }

  protected override accountPolls(): boolean {
    return true;
  }

  /**
   * Weekly remaining. grok-build `/usage` reads the same path.
   * GET `{proxy}/billing?format=credits`
   */
  protected override async loadAccount(): Promise<AccountSnapshot | undefined> {
    const token = this.secrets.get("apiKey");
    if (typeof token !== "string" || token.length === 0) return undefined;
    const plan = this.secrets.get("plan");
    const snap = await getGrokAccount({
      baseUrl: this.settings.baseUrl,
      apiKey: token,
      headers: this.authHeaders(),
      fetch: (input, init) => this.accountDoor(input, init),
    });
    if (typeof plan === "string" && plan !== "" && snap.identityDetail.plan === undefined) {
      return { ...snap, identityDetail: { ...snap.identityDetail, plan } };
    }
    return snap;
  }

  /** grok-build: GET `{proxy}/user?include=subscription` → firstName/lastName/email/subscriptionTier. */
  protected async probeAccount(): Promise<OidcIdentity> {
    const token = this.secrets.get("apiKey");
    if (typeof token !== "string" || token.length === 0) return {};
    const res = await this.handshakeFetch(`${this.settings.baseUrl}/user?include=subscription`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return {};
    try {
      return identityFromClaims(asRecord(await res.json()));
    } catch {
      return {};
    }
  }

  async #fetchAllowingVersion(run: () => Promise<Response>): Promise<Response> {
    const res = await run();
    if (res.status !== 426) return res;
    const body = await res.text();
    if (!/outdated/i.test(body) || !/version/i.test(body)) return carryResponse(res, body);
    const latest = await this.#publishedVersion();
    if (latest == null || compareClientVersion(latest, this.#clientVersion) <= 0) return carryResponse(res, body);
    this.#adoptClientVersion(latest);
    return run();
  }

  #publishedVersion(): Promise<string | null> {
    const current = this.#publishedFlight;
    if (current != null) return current;
    const flight = fetchPublishedGrokVersion().finally(() => {
      if (this.#publishedFlight === flight) this.#publishedFlight = null;
    });
    this.#publishedFlight = flight;
    return flight;
  }

  #adoptClientVersion(version: string): void {
    if (version === this.#clientVersion) return;
    this.#clientVersion = version;
    this.#versionDirty = true;
    this.#flushClientVersion();
  }

  #flushClientVersion(): void {
    if (!this.#versionDirty || this.#writeSettings == null) return;
    try {
      this.#writeSettings({ clientVersion: this.#clientVersion });
      this.#versionDirty = false;
    } catch (error) {
      step(
        `client version persist failed: connection=${this.connectionId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function carryResponse(res: Response, body: string): Response {
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
