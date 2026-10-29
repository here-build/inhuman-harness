/**
 * RFC 8628 device-code grant. Vendor URLs and client ids stay with the
 * provider; this package only runs the wire dance.
 */
import invariant from "tiny-invariant";

import { postForm } from "./fetch.js";
import { asNonEmpty, asNonNegativeInt, asPositiveInt, asRecord } from "./json.js";
import { tokensFromGrantBody, type OidcTokens } from "./oidc.js";

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceClient = {
  readonly driver: string;
  readonly clientId: string;
  readonly deviceCodeUrl: string;
  readonly tokenUrl: string;
  readonly scope: string;
  readonly extraDevice?: Readonly<Record<string, string>>;
  readonly fallbackVerificationUri?: string;
  /** Error-message prefix; defaults to `driver`. */
  readonly label?: string;
  /** Floor for poll interval. RFC 8628 default is 5. */
  readonly minIntervalSec?: number;
};

export type DeviceAuthorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSec: number;
  readonly intervalSec: number;
};

export type DevicePollClock = {
  now(): number;
  wait(ms: number): Promise<void>;
};

const defaultClock: DevicePollClock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function labelOf(client: DeviceClient): string {
  return client.label ?? client.driver;
}

export async function requestDeviceCode(client: DeviceClient): Promise<DeviceAuthorization> {
  const response = await postForm(
    client.deviceCodeUrl,
    {
      client_id: client.clientId,
      scope: client.scope,
      ...client.extraDevice,
    },
    `${labelOf(client)} device code`,
  );
  const label = labelOf(client);
  invariant(response.ok, `${label} device code failed (${response.status})`);
  const rec = asRecord(await response.json());
  invariant(rec !== null, `${label} device code returned no body`);
  const deviceCode = asNonEmpty(rec.device_code);
  const userCode = asNonEmpty(rec.user_code);
  invariant(deviceCode !== undefined, `${label} device code returned no device_code`);
  invariant(userCode !== undefined, `${label} device code returned no user_code`);
  const verificationUri = asNonEmpty(rec.verification_uri) ?? client.fallbackVerificationUri ?? "";
  const verificationUriComplete =
    asNonEmpty(rec.verification_uri_complete) ??
    (verificationUri === "" ? "" : `${verificationUri}?user_code=${userCode}`);
  invariant(verificationUriComplete !== "", `${label} device code returned no verification_uri`);
  return {
    deviceCode,
    userCode,
    verificationUri: verificationUri === "" ? verificationUriComplete : verificationUri,
    verificationUriComplete,
    expiresInSec: asPositiveInt(rec.expires_in) ?? 600,
    intervalSec: asNonNegativeInt(rec.interval) ?? 5,
  };
}

export async function pollDeviceToken(
  client: DeviceClient,
  device: Pick<DeviceAuthorization, "deviceCode" | "expiresInSec" | "intervalSec">,
  clock: DevicePollClock = defaultClock,
  signal?: AbortSignal,
): Promise<OidcTokens> {
  const label = labelOf(client);
  const deadline = clock.now() + device.expiresInSec * 1000;
  const minIntervalSec = client.minIntervalSec ?? 5;
  let intervalMs = Math.max(device.intervalSec, minIntervalSec) * 1000;
  for (;;) {
    signal?.throwIfAborted();
    const result = await tryDeviceToken(client, device.deviceCode);
    if (result.kind === "tokens") return result.tokens;
    if (result.kind === "denied") throw new Error(`${label} authorization denied`);
    if (result.kind === "expired") throw new Error(`${label} device code expired`);
    if (clock.now() >= deadline) throw new Error(`${label} authorization timed out`);
    if (result.kind === "slow_down") intervalMs += 5_000;
    await waitOrAbort(clock.wait(intervalMs), signal);
  }
}

async function waitOrAbort(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return wait;
  signal.throwIfAborted();
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

type DevicePoll =
  | { readonly kind: "tokens"; readonly tokens: OidcTokens }
  | { readonly kind: "pending" | "slow_down" | "denied" | "expired" };

async function tryDeviceToken(client: DeviceClient, deviceCode: string): Promise<DevicePoll> {
  const label = labelOf(client);
  const response = await postForm(
    client.tokenUrl,
    {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: client.clientId,
    },
    `${label} device token`,
  );
  const rec = asRecord(await response.json().catch(() => null));
  if (response.ok) {
    return { kind: "tokens", tokens: tokensFromGrantBody(rec, label) };
  }
  if (response.status === 429) return { kind: "slow_down" };
  const error = asNonEmpty(rec?.error);
  if (error === "authorization_pending") return { kind: "pending" };
  if (error === "slow_down") return { kind: "slow_down" };
  if (error === "access_denied") return { kind: "denied" };
  if (error === "expired_token") return { kind: "expired" };
  throw new Error(`${label} token exchange failed (${response.status}${error === undefined ? "" : ` ${error}`})`);
}
