/**
 * ChatGPT subscription: Responses (`POST /responses`, SSE
 * `response.output_text.delta`), not chat/completions. Catalog rows use
 * `{ models: [{ slug }] }`.
 */
import { step } from "@inhuman.tools/harness-diagnostics";
import { action, computed, type IReactionDisposer, observable, reaction } from "mobx";
import invariant from "tiny-invariant";

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
  chatgptCacheAffinity,
  getChatGptAccount,
  OpenAiCompatDriverConnection,
  openaiCompatLiveState,
  type AccountSnapshot,
  type CacheAffinity,
  type CacheFlavor,
} from "@/providers/openai-compat";

type AdoptCallback = (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>;

type DriverAdoptArgs = {
  name?: string;
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
};

type DriverAdoptBags = {
  readonly name?: string;
  readonly settings: Record<string, unknown>;
  readonly secrets: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Unlocks the Codex catalog; older versions return `{ models: [] }`. */
export const CHATGPT_CLIENT_VERSION = "1.0.0";

export class ChatGptDriverConnection extends OpenAiCompatDriverConnection {
  static oidcProfile = {
    driver: "chatgpt",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    userinfoUrl: "https://auth.openai.com/api/accounts/oauth/userinfo",
    scope: "openid profile email offline_access",
    extraAuthorize: {
      originator: "codex_cli_rs",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    },
    loginHint: "Authorize ChatGPT in the browser",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  };
  static override configurationLabel = "chatgpt";
  static offers = [
    {
      name: "ChatGPT",
      description: "ChatGPT subscription",
      live: true,
      adoptable: true,
      settings: { baseUrl: "https://chatgpt.com/backend-api/codex" },
    },
  ];

  static override async adopt(
    this: typeof ChatGptDriverConnection,
    args: DriverAdoptArgs,
    callback: AdoptCallback,
  ): Promise<DriverAdoptBags> {
    const profile = this.oidcProfile;
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
    this.#startFreshnessWatch();
    await this.refreshSession();
    await super.bootstrap();
    await this.#hydrateAccount();
  }

  #startFreshnessWatch(): void {
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
        // Return nowMs while eligible so a tick re-fires (boolean true→true would not).
        return eligible ? this.nowMs : 0;
      },
      (whenMs) => {
        if (whenMs !== 0) void this.refreshSession();
      },
      { fireImmediately: true },
    );
  }

  async #hydrateAccount(): Promise<void> {
    const profile = (this.constructor as typeof ChatGptDriverConnection).oidcProfile;
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
      this.mergeSecrets(secretsFromIdentity(mergeOidcIdentity(jwt, stored, userinfo)));
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
    const profile = (this.constructor as typeof ChatGptDriverConnection).oidcProfile;
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
    this.state.catalogName = "ChatGPT";
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

  protected override modelsRequestUrl(): string {
    return `${this.settings.baseUrl}/models?client_version=${CHATGPT_CLIENT_VERSION}`;
  }

  override completionRequestUrl(): string {
    return `${this.settings.baseUrl}/responses`;
  }

  override completionApi() {
    return "responses" as const;
  }

  protected override authHeaders(): Record<string, string> {
    const accountId = this.secrets.get("accountId");
    return {
      originator: "codex_cli_rs",
      "user-agent": `codex_cli_rs/${CHATGPT_CLIENT_VERSION}`,
      ...(typeof accountId === "string" && accountId.length > 0 ? { "chatgpt-account-id": accountId } : {}),
    };
  }

  override cacheFlavor(): CacheFlavor {
    return "chatgpt";
  }

  /** `session-id` / `thread-id` headers plus body `prompt_cache_key`. */
  override cacheAffinity(sessionId: string, _model: string): CacheAffinity {
    return chatgptCacheAffinity(sessionId);
  }

  protected override accountPolls(): boolean {
    return true;
  }

  /**
   * 5h + weekly remaining. Codex `/status` reads the same path.
   * GET `https://chatgpt.com/backend-api/wham/usage`
   */
  protected override async loadAccount(): Promise<AccountSnapshot | undefined> {
    const token = this.secrets.get("apiKey");
    if (typeof token !== "string" || token.length === 0) return undefined;
    const plan = this.secrets.get("plan");
    const snap = await getChatGptAccount({
      baseUrl: this.settings.baseUrl,
      apiKey: token,
      headers: this.authHeaders(),
      fetch: (input, init) => this.accountDoor(input, init),
    });
    if (typeof plan === "string" && plan !== "" && snap.identityDetail.plan === undefined) {
      return {
        ...snap,
        identityDetail: { ...snap.identityDetail, plan },
      };
    }
    return snap;
  }
}
