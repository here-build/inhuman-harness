/**
 * Daemon side of remote access: WorkOS device login, token storage and
 * refresh, the machine identity. A kernel service, not a PEW connection:
 * it provides no ability, has no model catalog and no per-connection config.
 * Tokens and the machine id live in the kernel's durable credentials under
 * reserved ids; the connector (phase 3b) calls {@link RemoteAccess.accessToken}.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import type { CredentialsStore } from "@/connections/credentials";
import { readConnectionSecrets } from "../../secrets.js";
import {
  accessTokenExpiring,
  OidcGrantError,
  pollDeviceToken,
  refreshOidcToken,
  requestDeviceCode,
  secretsFromTokens,
  type DeviceClient,
  type DevicePollClock,
  type OidcProfile,
} from "@/providers/auth";

export const DEFAULT_RELAY_URL = "https://harness.inhuman.tools";
export const WORKOS_CLIENT_ID_ENV = "HARNESS_REMOTE_WORKOS_CLIENT_ID";
export const RELAY_URL_ENV = "HARNESS_REMOTE_URL";
/** DEV ONLY (local e2e against `wrangler dev`): a ready-made relay bearer, `dev.<secret>.<sub>.<email>`. Unset in every real run. */
export const DEV_TOKEN_ENV = "HARNESS_REMOTE_DEV_TOKEN";

const WORKOS_API = "https://api.workos.com/user_management";
export const WORKOS_DEVICE_CODE_URL = `${WORKOS_API}/authorize/device`;
export const WORKOS_TOKEN_URL = `${WORKOS_API}/authenticate`;

/** Reserved ids in the credentials store; connection ids are slugs of a name and never contain `:`. */
export const REMOTE_TOKENS_ID = "remote:tokens";
export const REMOTE_MACHINE_ID = "remote:machine";

export const REMOTE_LOGIN_HINT = "Approve this machine for remote access in the browser, then continue";

export type RemoteStatus = {
  readonly loggedIn: boolean;
  readonly email?: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly relayUrl: string;
  readonly connected: boolean;
  /** Why remote access is down: set when the relay or WorkOS refused the stored login. */
  readonly lastError?: string;
};

export type RemoteAccessOptions = {
  readonly credentials: CredentialsStore & { write: NonNullable<CredentialsStore["write"]> };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly hostname?: () => string;
  readonly clock?: DevicePollClock;
};

/** Parks the open-url form; resolves when the human continues, rejects when they cancel. */
export type RemoteLoginUi = (body: string) => Promise<unknown>;

/** Cheap boot-time check, before any kernel exists. */
export function remoteLoggedIn(root: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (devToken(env) !== undefined) return true;
  return readConnectionSecrets(root, REMOTE_TOKENS_ID).refreshToken !== undefined;
}

function devToken(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env[DEV_TOKEN_ENV]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/** The email in a dev bearer (everything after `dev.<secret>.<sub>.`), or a placeholder. */
function devEmail(token: string): string {
  const email = token.split(".").slice(3).join(".");
  return email === "" ? "dev@local" : email;
}

function quote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
}

export class RemoteAccess {
  readonly #credentials: RemoteAccessOptions["credentials"];
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof fetch | undefined;
  readonly #hostname: () => string;
  readonly #clock: DevicePollClock | undefined;
  #refreshing: Promise<string | undefined> | null = null;
  #lastError: string | undefined;

  constructor(options: RemoteAccessOptions) {
    this.#credentials = options.credentials;
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#hostname = options.hostname ?? hostname;
    this.#clock = options.clock;
  }

  get relayUrl(): string {
    const url = this.#env[RELAY_URL_ENV]?.trim();
    return (url === undefined || url === "" ? DEFAULT_RELAY_URL : url).replace(/\/+$/, "");
  }

  /** Minted once and kept; survives logout. */
  machine(): { readonly machineId: string; readonly machineName: string } {
    const bag = this.#credentials.read(REMOTE_MACHINE_ID);
    const machineId = bag.machineId ?? randomBytes(16).toString("base64url");
    const machineName = bag.machineName ?? this.#hostname();
    if (bag.machineId === undefined) this.#credentials.write(REMOTE_MACHINE_ID, { ...bag, machineId });
    return { machineId, machineName };
  }

  /** `connected` is the connector's control socket; this class only knows the login. */
  status(connected = false): RemoteStatus {
    const dev = devToken(this.#env);
    const tokens = this.#credentials.read(REMOTE_TOKENS_ID);
    const loggedIn = dev !== undefined || tokens.refreshToken !== undefined;
    const email = dev === undefined ? tokens.email : devEmail(dev);
    return {
      loggedIn,
      ...(loggedIn && email !== undefined ? { email } : {}),
      ...this.machine(),
      relayUrl: this.relayUrl,
      connected,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  /**
   * Device login. `ui` parks the open-url form first; the poll starts after
   * the human continues. A UI cancel rejects `ui`, and nothing is stored.
   */
  async login(ui: RemoteLoginUi, options: { name?: string; signal?: AbortSignal } = {}) {
    const client = this.#deviceClient();
    const device = await requestDeviceCode(client);
    await ui(
      `(harness/open-url :url ${quote(device.verificationUriComplete)} :description ${quote(REMOTE_LOGIN_HINT)})`,
    );
    const tokens = await pollDeviceToken(client, device, this.#clock, options.signal);
    this.#credentials.write(REMOTE_TOKENS_ID, secretsFromTokens(tokens));
    this.#lastError = undefined;
    if (options.name !== undefined) {
      const bag = this.#credentials.read(REMOTE_MACHINE_ID);
      this.#credentials.write(REMOTE_MACHINE_ID, { ...bag, machineName: options.name });
    }
    return { email: tokens.email ?? "", machineId: this.machine().machineId };
  }

  logout(): { readonly wasLoggedIn: boolean } {
    const wasLoggedIn = this.#credentials.read(REMOTE_TOKENS_ID).refreshToken !== undefined;
    this.#credentials.write(REMOTE_TOKENS_ID, {});
    this.#lastError = undefined;
    return { wasLoggedIn };
  }

  /** A transient reason shown in `remote/status`; `undefined` clears it. */
  noteError(message: string | undefined): void {
    this.#lastError = message;
  }

  /** The stored login is dead (revoked grant, relay 401 on a fresh token): drop it and say why. */
  revoke(reason: string): void {
    this.#credentials.write(REMOTE_TOKENS_ID, {});
    this.#lastError = reason;
  }

  /**
   * A bearer token for the relay, refreshed first when it expires within the
   * skew. `undefined` when logged out, including when WorkOS answers
   * `invalid_grant` (the tokens are then dropped). Other refresh failures
   * reject and keep the tokens. Concurrent callers share one refresh,
   * which matters because WorkOS rotates refresh tokens.
   */
  accessToken(now = Date.now(), force = false): Promise<string | undefined> {
    const dev = devToken(this.#env);
    if (dev !== undefined) return Promise.resolve(dev);
    const tokens = this.#credentials.read(REMOTE_TOKENS_ID);
    if (tokens.apiKey === undefined || tokens.refreshToken === undefined) return Promise.resolve(undefined);
    if (!force && !accessTokenExpiring(tokens.expiresAt, now)) return Promise.resolve(tokens.apiKey);
    this.#refreshing ??= this.#refresh(tokens.refreshToken).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refresh(refreshToken: string): Promise<string | undefined> {
    let refreshed;
    try {
      refreshed = await refreshOidcToken(this.#profile(), refreshToken);
    } catch (error) {
      if (!(error instanceof OidcGrantError) || error.code !== "invalid_grant") throw error;
      this.revoke("The remote-access login expired or was revoked. Run `harness login` again.");
      return undefined;
    }
    const previous = this.#credentials.read(REMOTE_TOKENS_ID);
    // A refresh body may omit the user; keep who we were.
    this.#credentials.write(REMOTE_TOKENS_ID, { ...previous, ...secretsFromTokens(refreshed) });
    return refreshed.apiKey;
  }

  #clientId(): string {
    const id = this.#env[WORKOS_CLIENT_ID_ENV]?.trim();
    if (id === undefined || id === "") {
      throw new Error(`Remote access is not configured: set ${WORKOS_CLIENT_ID_ENV} to the WorkOS client id`);
    }
    return id;
  }

  #deviceClient(): DeviceClient {
    return {
      driver: "remote",
      label: "WorkOS",
      clientId: this.#clientId(),
      deviceCodeUrl: WORKOS_DEVICE_CODE_URL,
      tokenUrl: WORKOS_TOKEN_URL,
      scope: "",
      minIntervalSec: 1,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    };
  }

  #profile(): OidcProfile {
    return {
      driver: "remote",
      clientId: this.#clientId(),
      authorizeUrl: "",
      tokenUrl: WORKOS_TOKEN_URL,
      userinfoUrl: "",
      scope: "",
      extraAuthorize: {},
      loginHint: REMOTE_LOGIN_HINT,
      baseUrl: this.relayUrl,
      ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
    };
  }
}
