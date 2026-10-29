/**
 * Nous Portal: openai-compat over device-code OAuth.
 * @see https://portal.nousresearch.com/api-docs
 */
import { step } from "@inhuman.tools/harness-diagnostics";
import { action, computed, type IReactionDisposer, observable, reaction } from "mobx";

import {
  accessTokenExpiring,
  identityFromClaims,
  jwtPayload,
  mergeOidcIdentity,
  OIDC_REFRESH_BACKOFF_MS,
  refreshOidcToken,
  secretsFromIdentity,
  secretsFromTokens,
  type OidcIdentity,
} from "@/providers/auth";
import { OpenAiCompatDriverConnection, openaiCompatLiveState } from "@/providers/openai-compat";

import {
  NOUS_BASE_URL,
  NOUS_LOGIN_HINT,
  NOUS_OIDC_PROFILE,
  pollNousDeviceToken,
  requestNousDeviceCode,
} from "./auth.js";

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

function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Assembled OIDC + completion connection. Auth primitives stay in
 * provider-auth; this class is Nous-private so openai-compat does not
 * inherit a vendor session.
 */
class NousOidcConnection extends OpenAiCompatDriverConnection {
  static oidcProfile = NOUS_OIDC_PROFILE;

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
    const profile = (this.constructor as typeof NousOidcConnection).oidcProfile;
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
      const merged = mergeOidcIdentity(jwt, stored, userinfo);
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
    const profile = (this.constructor as typeof NousOidcConnection).oidcProfile;
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
    this.state.catalogName = "Nous Portal";
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
}

export class NousDriverConnection extends NousOidcConnection {
  static oidcProfile = NOUS_OIDC_PROFILE;
  static override configurationLabel = "nous";
  static offers = [
    {
      name: "Nous Portal",
      description: "Nous Research inference API",
      live: true,
      adoptable: true,
      settings: { baseUrl: NOUS_BASE_URL },
    },
  ];
  static override async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    const settings = { ...(args.settings ?? {}), baseUrl: NOUS_BASE_URL };
    const name = asAdoptString(args.name) || "Nous Portal";
    const device = await requestNousDeviceCode();
    const quotedUrl = `"${device.verificationUriComplete.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
    const quotedHint = `"${NOUS_LOGIN_HINT.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
    await callback("UI", `(harness/open-url :url ${quotedUrl} :description ${quotedHint})`);
    return {
      name,
      settings,
      secrets: secretsFromTokens(await pollNousDeviceToken(device, args.signal)),
    };
  }
}
