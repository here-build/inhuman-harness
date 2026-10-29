import type { DriverOffer } from "@inhuman.tools/plexus-expectations/driver";

import { WELL_KNOWN_ENDPOINTS, wellKnownFromBaseUrl } from "./well-known.js";

export type LocalEndpoint = {
  readonly name: string;
  readonly port: number;
  readonly path: string;
};

export const LOCAL_ENDPOINTS: readonly LocalEndpoint[] = [
  { name: "LM Studio", port: 1234, path: "/v1" },
  { name: "Ollama", port: 11_434, path: "/v1" },
  { name: "LiteLLM", port: 4000, path: "/v1" },
  { name: "Jan", port: 1337, path: "/v1" },
  { name: "GPT4All", port: 4891, path: "/v1" },
  { name: "Docker Model Runner", port: 12_434, path: "/engines/v1" },
  { name: "SGLang", port: 30_000, path: "/v1" },
  { name: "Text Generation WebUI", port: 5000, path: "/v1" },
  { name: "Lemonade", port: 8000, path: "/api/v1" },
  { name: "Llama Stack", port: 8321, path: "/v1/openai/v1" },
  { name: "Docker Model Runner", port: 22_088, path: "/engines/llama.cpp" },
];

/** Always-listed adopt door. Empty `baseUrl` parks the RPC Base URL input. */
export const CUSTOM_OFFER: DriverOffer = {
  name: "OpenAI-compatible",
  description: "Any OpenAI-compatible endpoint",
  live: false,
  adoptable: true,
  settings: {},
};

/**
 * Names that already have a door of their own: OpenRouter and Nous Portal
 * ship drivers (OAuth login), xAI is the Grok driver's.
 */
const OWN_DRIVER_NAMES: ReadonlySet<string> = new Set(["OpenRouter", "Nous Portal", "xAI"]);

/** One key-only door per well-known catalog name (first baseUrl wins). */
export const REMOTE_OFFERS: readonly DriverOffer[] = WELL_KNOWN_ENDPOINTS.filter(
  ({ name }, index, all) => !OWN_DRIVER_NAMES.has(name) && all.findIndex((other) => other.name === name) === index,
).map(({ name, baseUrl }) => ({
  name,
  description: "API key",
  live: false,
  adoptable: true,
  settings: { baseUrl },
}));

/** Ports with no single owner; a hit is "some server", named by its port. */
const AMBIGUOUS = [
  { port: 8000, path: "/v1" },
  { port: 8080, path: "/v1" },
] as const;

function normalizePath(path: string): string {
  if (path === "/" || path === "") return "";
  return path.replace(/\/+$/, "");
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return isLoopback(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Product name + description for a known OpenAI-compat catalog, or undefined. */
export function catalogFromBaseUrl(baseUrl: string): { name: string; description: string } | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const path = normalizePath(url.pathname);
  if (isLoopback(url.hostname)) {
    const port = portOf(url);
    const local = LOCAL_ENDPOINTS.find((endpoint) => endpoint.port === port && normalizePath(endpoint.path) === path);
    if (local !== undefined) {
      return {
        name: local.name,
        description: `Local OpenAI-compat :${local.port}`,
      };
    }
    const ambiguous = AMBIGUOUS.find((endpoint) => endpoint.port === port && normalizePath(endpoint.path) === path);
    if (ambiguous !== undefined) {
      return {
        name: `local :${port}`,
        description: `Local OpenAI-compat :${port}`,
      };
    }
  }
  const known = wellKnownFromBaseUrl(baseUrl);
  if (known !== undefined) {
    return { name: known.name, description: known.name };
  }
  return undefined;
}

/** Compound suffixes treated as the eTLD; one more label is the domain. */
const COMPOUND_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.nz",
  "net.nz",
  "org.nz",
  "co.za",
  "org.za",
  "web.za",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "org.mx",
  "co.kr",
  "or.kr",
  "ne.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.tw",
  "org.tw",
  "com.hk",
  "org.hk",
  "net.hk",
  "co.in",
  "net.in",
  "org.in",
  "com.sg",
  "net.sg",
  "org.sg",
  "co.id",
  "web.id",
  "com.ar",
  "org.ar",
  "co.il",
  "org.il",
  "com.tr",
  "org.tr",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
]);

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function registrableDomain(hostname: string): string {
  const host = hostname
    .trim()
    .toLowerCase()
    .replaceAll(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "") return hostname.trim();
  if (isIpLiteral(host)) return host;
  const labels = host.split(".").filter((label) => label.length > 0);
  if (labels.length <= 1) return host;
  const last2 = labels.slice(-2).join(".");
  if (COMPOUND_SUFFIXES.has(last2) && labels.length >= 3) return labels.slice(-3).join(".");
  return last2;
}

export function domainFromBaseUrl(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (isLoopback(url.hostname)) {
    const host = url.hostname === "[::1]" ? "::1" : url.hostname;
    return url.port === "" ? host : `${host}:${url.port}`;
  }
  const domain = registrableDomain(url.hostname);
  return domain === "" ? undefined : domain;
}

export function nameFromBaseUrl(baseUrl: string): string | undefined {
  return catalogFromBaseUrl(baseUrl)?.name ?? domainFromBaseUrl(baseUrl);
}

/** Local servers answer in milliseconds; a silent port is a closed port. */
export const LOCAL_PROBE_TIMEOUT_MS = 1_000;

async function modelsOk(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return false;
    }
    // A dev server answers every path with its page; a model server answers with the list.
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data);
  } catch {
    return false;
  }
}

/**
 * GET {baseUrl}/models on every known local port, then the ambiguous ones no
 * named server already claimed. A hit is an adoptable live offer.
 */
export async function probeLocalOffers(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
): Promise<DriverOffer[]> {
  const found: DriverOffer[] = [];
  const claimed = new Set<number>();
  const probe = async (name: string, { port, path }: { port: number; path: string }): Promise<boolean> => {
    const baseUrl = `http://127.0.0.1:${port}${path}`;
    if (!(await modelsOk(baseUrl, fetchImpl, timeoutMs))) return false;
    found.push({
      name,
      description: `Local OpenAI-compat :${port}`,
      live: true,
      adoptable: true,
      settings: { baseUrl },
    });
    return true;
  };
  await Promise.all(
    LOCAL_ENDPOINTS.map(async (endpoint) => {
      if (await probe(endpoint.name, endpoint)) claimed.add(endpoint.port);
    }),
  );
  await Promise.all(
    AMBIGUOUS.filter(({ port }) => !claimed.has(port)).map((endpoint) => probe(`local :${endpoint.port}`, endpoint)),
  );
  return found.sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.settings.baseUrl).localeCompare(String(b.settings.baseUrl)),
  );
}
