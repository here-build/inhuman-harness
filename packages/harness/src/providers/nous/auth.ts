/**
 * Nous Portal device-code OAuth (RFC 8628). Hermes CLI's public client
 * (`hermes-cli`) and `inference:invoke`. Access tokens are bearer JWTs;
 * refresh uses the Portal token endpoint.
 * @see https://portal.nousresearch.com/api-docs
 */
import {
  pollDeviceToken,
  requestDeviceCode,
  type DeviceAuthorization,
  type DeviceClient,
  type OidcProfile,
  type OidcTokens,
} from "@/providers/auth";

export const NOUS_PORTAL_URL = "https://portal.nousresearch.com";
export const NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const NOUS_CLIENT_ID = "hermes-cli";
export const NOUS_SCOPE = "inference:invoke";
export const NOUS_DEVICE_CODE_URL = `${NOUS_PORTAL_URL}/api/oauth/device/code`;
export const NOUS_TOKEN_URL = `${NOUS_PORTAL_URL}/api/oauth/token`;
export const NOUS_LOGIN_HINT = "Approve Nous Portal in the browser, then continue";

export const NOUS_OIDC_PROFILE: OidcProfile = {
  driver: "nous",
  clientId: NOUS_CLIENT_ID,
  authorizeUrl: `${NOUS_PORTAL_URL}/oauth/authorize`,
  tokenUrl: NOUS_TOKEN_URL,
  userinfoUrl: "",
  scope: NOUS_SCOPE,
  extraAuthorize: {},
  loginHint: NOUS_LOGIN_HINT,
  baseUrl: NOUS_BASE_URL,
};

export type NousDeviceCode = Pick<
  DeviceAuthorization,
  "deviceCode" | "verificationUriComplete" | "expiresInSec" | "intervalSec"
>;

const NOUS_DEVICE_CLIENT: DeviceClient = {
  driver: "nous",
  label: "Nous Portal",
  clientId: NOUS_CLIENT_ID,
  deviceCodeUrl: NOUS_DEVICE_CODE_URL,
  tokenUrl: NOUS_TOKEN_URL,
  scope: NOUS_SCOPE,
  extraDevice: { source: "device_code" },
  fallbackVerificationUri: `${NOUS_PORTAL_URL}/manage-subscription`,
  minIntervalSec: 5,
};

export async function requestNousDeviceCode(): Promise<NousDeviceCode> {
  const device = await requestDeviceCode(NOUS_DEVICE_CLIENT);
  return {
    deviceCode: device.deviceCode,
    verificationUriComplete: device.verificationUriComplete,
    expiresInSec: device.expiresInSec,
    intervalSec: device.intervalSec,
  };
}

export async function pollNousDeviceToken(device: NousDeviceCode, signal?: AbortSignal): Promise<OidcTokens> {
  return pollDeviceToken(NOUS_DEVICE_CLIENT, device, undefined, signal);
}
