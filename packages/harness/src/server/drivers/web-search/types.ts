/** Product driver IDs and pin keys. Wire types live in provider-web/wire. */

import { WEB_EXTRACT_CAN, WEB_SEARCH_CAN } from "@/providers/web/wire";

export const KEYLESS_DRIVER_NAME = "web-keyless";
export const KEYLESS_CONNECTION_ID = "web-keyless";
export const WEB_SEARCH_PIN_KV = "web-search-connection";
export const WEB_EXTRACT_PIN_KV = "web-extract-connection";
export const WEB_SEARCH_KEYLESS_FALLBACK_KV = "web.keyless_fallback";

export function isWebSearchCan(can: readonly string[]): boolean {
  return can.includes(WEB_SEARCH_CAN);
}

export function isWebExtractCan(can: readonly string[]): boolean {
  return can.includes(WEB_EXTRACT_CAN);
}

export function isCompletionCan(can: readonly string[]): boolean {
  return can.includes("completion");
}
