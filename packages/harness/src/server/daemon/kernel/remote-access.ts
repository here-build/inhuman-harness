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
import {
  accessTokenExpiring,
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

  status(): RemoteStatus {
    const tokens = this.#credentials.read(REMOTE_TOKENS_ID);
    const loggedIn = tokens.refreshToken !== undefined;
    return {
      loggedIn,
      ...(loggedIn && tokens.email !== undefined ? { email: tokens.email } : {}),
      ...this.machine(),
      relayUrl: this.relayUrl,
      connected: false,
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
    if (options.name !== undefined) {
      const bag = this.#credentials.read(REMOTE_MACHINE_ID);
      this.#credentials.write(REMOTE_MACHINE_ID, { ...bag, machineName: options.name });
    }
    return { email: tokens.email ?? "", machineId: this.machine().machineId };
  }

  logout(): { readonly wasLoggedIn: boolean } {
    const wasLoggedIn = this.#credentials.read(REMOTE_TOKENS_ID).refreshToken !== undefined;
    this.#credentials.write(REMOTE_TOKENS_ID, {});
    return { wasLoggedIn };
  }

  /**
   * A bearer token for the relay, refreshed first when it expires within the
   * skew. `undefined` when logged out. Concurrent callers share one refresh,
   * which matters because WorkOS rotates refresh tokens.
   */
  accessToken(now = Date.now()): Promise<string | undefined> {
    const tokens = this.#credentials.read(REMOTE_TOKENS_ID);
    if (tokens.apiKey === undefined || tokens.refreshToken === undefined) return Promise.resolve(undefined);
    if (!accessTokenExpiring(tokens.expiresAt, now)) return Promise.resolve(tokens.apiKey);
    this.#refreshing ??= this.#refresh(tokens.refreshToken).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refresh(refreshToken: string): Promise<string> {
    const refreshed = await refreshOidcToken(this.#profile(), refreshToken);
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
