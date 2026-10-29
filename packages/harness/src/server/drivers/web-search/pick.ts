/**
 * Pick the web-search or web-extract connection for one intern.
 * Pin → dedicated (non-completion, not the projected intern) → Nous intern → keyless.
 * Grok/xAI `can` completion+web-search; it does not auto-win search or extract.
 * `web-nous` is projected; file BYOK must beat it regardless of map insertion order.
 *
 * Product fallback policy lives here. Nous owns source/gateway credential lifecycle.
 */
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";

import { NOUS_GATEWAY_CONNECTION_ID } from "@/providers/nous";

import {
  isCompletionCan,
  isWebExtractCan,
  isWebSearchCan,
  KEYLESS_CONNECTION_ID,
  KEYLESS_DRIVER_NAME,
  WEB_EXTRACT_PIN_KV,
  WEB_SEARCH_KEYLESS_FALLBACK_KV,
  WEB_SEARCH_PIN_KV,
} from "./types.js";

export type WebSearchCanFace = {
  readonly driver: { readonly abilityClaim: readonly string[] };
};

export type WebSearchPickKernel = {
  readonly kvs: { readonly [key: string]: string };
  readonly drivers: { readonly [name: string]: DriverSpec | undefined };
  readonly connections: {
    readonly [id: string]: ConnectionSpec | WebSearchCanFace | undefined;
  };
};

export function projectKeylessConnection(into: WebSearchPickKernel): void {
  const driver = into.drivers[KEYLESS_DRIVER_NAME];
  if (driver === undefined) return;
  if (into.kvs[WEB_SEARCH_KEYLESS_FALLBACK_KV] === "false") {
    delete (into.connections as { [id: string]: ConnectionSpec })[KEYLESS_CONNECTION_ID];
    return;
  }
  const connections = into.connections as { [id: string]: ConnectionSpec };
  const spec = (connections[KEYLESS_CONNECTION_ID] ??= new ConnectionSpec({
    driver,
  }));
  spec.driver = driver;
  spec.name = "web-keyless";
  spec.annotation = "Keyless web-search ring";
  spec.configuration = {};
}

export function pickWebSearchConnection(kernel: WebSearchPickKernel): string | null {
  return pickByCan(kernel, {
    pin: (kernel.kvs[WEB_SEARCH_PIN_KV] ?? "").trim(),
    eligible: (spec) => isWebSearchCan(spec.driver.abilityClaim),
    dedicated: (spec) => isWebSearchCan(spec.driver.abilityClaim) && !isCompletionCan(spec.driver.abilityClaim),
  });
}

export function pickWebExtractConnection(kernel: WebSearchPickKernel): string | null {
  return pickByCan(kernel, {
    pin: (kernel.kvs[WEB_EXTRACT_PIN_KV] ?? "").trim(),
    eligible: (spec) => isWebExtractCan(spec.driver.abilityClaim),
    dedicated: (spec) => isWebExtractCan(spec.driver.abilityClaim) && !isCompletionCan(spec.driver.abilityClaim),
  });
}

function pickByCan(
  kernel: WebSearchPickKernel,
  opts: {
    readonly pin: string;
    readonly eligible: (spec: WebSearchCanFace) => boolean;
    readonly dedicated: (spec: WebSearchCanFace) => boolean;
  },
): string | null {
  const ids: string[] = [];
  for (const [id, spec] of Object.entries(kernel.connections)) {
    if (spec !== undefined && opts.eligible(spec)) ids.push(id);
  }
  if (opts.pin !== "" && ids.includes(opts.pin)) return opts.pin;
  const dedicated = ids.find((id) => {
    const spec = kernel.connections[id];
    return (
      spec !== undefined && id !== KEYLESS_CONNECTION_ID && id !== NOUS_GATEWAY_CONNECTION_ID && opts.dedicated(spec)
    );
  });
  if (dedicated !== undefined) return dedicated;
  const intern = kernel.connections[NOUS_GATEWAY_CONNECTION_ID];
  if (intern !== undefined && ids.includes(NOUS_GATEWAY_CONNECTION_ID) && opts.dedicated(intern)) {
    return NOUS_GATEWAY_CONNECTION_ID;
  }
  if (ids.includes(KEYLESS_CONNECTION_ID)) return KEYLESS_CONNECTION_ID;
  return null;
}
