/**
 * Product composition: shipped driver-provider roster, hypervisor descriptor
 * (supervised daemon bin), and the in-process daemon host. Importing this module
 * loads runtime and providers. The public barrel must not.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerProviders } from "@inhuman.tools/harness-provider-sdk";

import type { RestartPolicy, ServerRoster } from "@/protocol/schemas";
import { chatgptProvider } from "@/providers/chatgpt";
import { grokProvider } from "@/providers/grok";
import { mcpProvider } from "@/providers/mcp";
import { nousProvider } from "@/providers/nous";
import { cacheFlavorFromBaseUrl, type CacheFlavor } from "@/providers/openai-compat";
import { openaiCompatProvider } from "@/providers/openai-compat/register";
import { openrouterProvider } from "@/providers/openrouter";
import { webProvider } from "@/providers/web/registrations";

import { nousGatewayIntern } from "./provider-roster/nous.js";

export const PRODUCT_PROVIDERS = registerProviders([
  openaiCompatProvider,
  openrouterProvider,
  nousProvider,
  chatgptProvider,
  grokProvider,
  mcpProvider,
  webProvider,
  nousGatewayIntern,
]);

/**
 * Dedicated vendor for a pasted generic openai-compat URL.
 * Host predicates for grok/chatgpt/openrouter are {@link cacheFlavorFromBaseUrl}.
 */
const DEDICATED_BY_FLAVOR: {
  readonly [K in CacheFlavor]: string | null;
} = {
  grok: "grok",
  chatgpt: "chatgpt",
  openrouter: "openrouter",
  openai: null,
  none: null,
};

const NOUS_INFERENCE_HOST = "inference-api.nousresearch.com";

function hostOf(baseUrl: string): string {
  const rest = baseUrl.trim().replace(/^[a-z][a-z+\-.]*:\/\//i, "");
  return (rest.split(/[/:?#]/, 1)[0] ?? "").toLowerCase();
}

/** Dedicated driver id, or null to keep the generic openai-compat row. */
export function dedicatedCompatDriver(baseUrl: string): string | null {
  const fromFlavor = DEDICATED_BY_FLAVOR[cacheFlavorFromBaseUrl(baseUrl)];
  if (fromFlavor != null) return fromFlavor;
  const host = hostOf(baseUrl);
  if (host === NOUS_INFERENCE_HOST || host.endsWith(`.${NOUS_INFERENCE_HOST}`)) {
    return "nous";
  }
  return null;
}

const PRODUCT_RESTART: RestartPolicy = {
  mode: "on-failure",
  maxAttempts: 5,
  backoffMs: 250,
};

export type ProductBins = {
  readonly runtime: {
    readonly executable: string;
    readonly args: readonly string[];
  };
};

/** Built daemon bin in supervised mode. Source resolves `dist/server`; emit resolves the sibling. */
function runtimeBin(): { executable: string; args: string[] } {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const sibling = join(here, "bin.js");
  const fromSource = join(here, "../../dist/server/bin.js");
  return {
    executable: process.execPath,
    args: [existsSync(sibling) ? sibling : fromSource, "--supervised"],
  };
}

/** Built package bins named by the hypervisor descriptors. */
export function productBins(): ProductBins {
  return {
    runtime: runtimeBin(),
  };
}

/** Hypervisor descriptor for the single SQLite-backed runtime process. */
export function productRoster(bins: ProductBins = productBins()): ServerRoster {
  return {
    servers: [
      {
        id: "runtime",
        role: "runtime",
        executable: bins.runtime.executable,
        args: [...bins.runtime.args],
        requires: [],
        restart: PRODUCT_RESTART,
      },
    ],
  };
}
