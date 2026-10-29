/**
 * Product composition: shipped driver-provider roster, hypervisor descriptors
 * (yjs + runtime bins), and the in-process daemon host. Importing this module
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
  readonly yjs: {
    readonly executable: string;
    readonly args: readonly string[];
  };
  readonly runtime: {
    readonly executable: string;
    readonly args: readonly string[];
  };
};

/** Built runtime bin. Source resolves `dist/server`; emit resolves the sibling. */
function runtimeBin(): { executable: string; args: string[] } {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const sibling = join(here, "runtime-bin.js");
  const fromSource = join(here, "../../dist/server/runtime-bin.js");
  return {
    executable: process.execPath,
    args: [existsSync(sibling) ? sibling : fromSource],
  };
}

/** Built yjs bin. Source resolves `dist/yjs`; emit resolves the sibling of `dist/server`. */
function yjsBin(): { executable: string; args: string[] } {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const sibling = join(here, "../yjs/bin.js");
  const fromSource = join(here, "../../dist/yjs/bin.js");
  return {
    executable: process.execPath,
    args: [existsSync(sibling) ? sibling : fromSource],
  };
}

/** Built package bins named by the hypervisor descriptors. */
export function productBins(): ProductBins {
  return {
    yjs: yjsBin(),
    runtime: runtimeBin(),
  };
}

/** Hypervisor descriptors. Runtime requires yjs readiness. */
export function productRoster(bins: ProductBins = productBins()): ServerRoster {
  return {
    servers: [
      {
        id: "yjs",
        role: "yjs",
        executable: bins.yjs.executable,
        args: [...bins.yjs.args],
        requires: [],
        restart: PRODUCT_RESTART,
      },
      {
        id: "runtime",
        role: "runtime",
        executable: bins.runtime.executable,
        args: [...bins.runtime.args],
        requires: ["yjs"],
        restart: PRODUCT_RESTART,
      },
    ],
  };
}
