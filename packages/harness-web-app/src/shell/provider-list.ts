/**
 * The providers a person can connect, read off the kernel's own facts: each
 * completion driver and the offers it advertises. `/connect` lists them the
 * same way (`connect.scm`): offers a connection already adopted are hidden,
 * and a driver that offers nothing is a row of its own until one exists.
 */

/** Enough of a kernel driver face to list what it can connect. */
export type DriverSource = {
  readonly name?: string;
  readonly description?: string;
  readonly abilityClaim?: readonly string[];
  /** Advertised offers; a malformed cell throws on read, which lists nothing. */
  readonly offers?: readonly unknown[];
};

/** Enough of a kernel connection to tell which offers it already adopted. */
export type AdoptedSource = {
  readonly name?: string;
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
  readonly configuration?: { readonly baseUrl?: unknown } | null;
};

/** Subscriptions and gateways sign in through a browser; local servers answer on this machine; the rest take a key or an address. */
export type ProviderGroup = "subscription" | "gateway" | "local" | "key" | "custom";

/** What `connect/adopt` is asked for. The daemon parks whatever it still needs. */
export type ConnectStart = {
  readonly driver: string;
  readonly name: string;
  readonly settings?: Readonly<Record<string, unknown>>;
};

export type ProviderRow = {
  readonly key: string;
  readonly driver: string;
  readonly name: string;
  readonly description: string;
  /** How signing in works, from the offer: a browser, a key, a server already running here. */
  readonly hint: string;
  readonly group: ProviderGroup;
  /** Null when the daemon does not adopt this one from a list. */
  readonly start: ConnectStart | null;
};

export const GROUP_LABELS: Readonly<Record<ProviderGroup, string>> = {
  subscription: "Subscriptions",
  gateway: "Gateways",
  local: "On this machine",
  key: "With an API key",
  custom: "Custom endpoint",
};

export const GROUPS: readonly ProviderGroup[] = ["subscription", "gateway", "local", "key", "custom"];
/** Subscriptions first, then the hosted routers; any other driver follows in the kernel's order. */
const FIRST = ["chatgpt", "grok", "openrouter", "nous"];

/** No connection speaks completion yet: the model lane reads "Connect a model". */
export function needsOnboarding(connections: Readonly<Record<string, AdoptedSource | undefined>> | null | undefined) {
  return !Object.values(connections ?? {}).some((spec) => spec?.driver?.abilityClaim?.includes("completion") === true);
}

export function providerRows(
  drivers: Readonly<Record<string, DriverSource | undefined>> | null | undefined,
  connections: Readonly<Record<string, AdoptedSource | undefined>> | null | undefined,
): ProviderRow[] {
  const adopted = Object.values(connections ?? {}).filter((spec): spec is AdoptedSource => spec != null);
  const rows: ProviderRow[] = [];
  for (const [key, driver] of Object.entries(drivers ?? {})) {
    if (driver?.abilityClaim?.includes("completion") !== true) continue;
    const name = driver.name === undefined || driver.name === "" ? key : driver.name;
    const mine = adopted.filter((spec) => spec.driver?.name === name);
    const offers = offersOf(driver);
    if (offers.length === 0) {
      // A driver with nothing to offer is one row until a connection uses it.
      if (mine.length === 0) {
        rows.push({
          key: `${name}:`,
          driver: name,
          name,
          description: driver.description ?? "",
          hint: "",
          group: "gateway",
          start: { driver: name, name },
        });
      }
      continue;
    }
    for (const offer of offers) {
      if (mine.some((spec) => adoptedOffer(offer, spec))) continue;
      rows.push({
        key: `${name}:${offer.name}`,
        driver: name,
        name: offer.name,
        description: offer.description,
        ...classify(offer),
        start: offer.adoptable ? { driver: name, name: offer.name, settings: offer.settings } : null,
      });
    }
  }
  return rows
    .map((row, at) => ({ row, at }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at)
    .map(({ row }) => row);
}

/** The group and hint a facts-only offer falls into. */
function classify(offer: Offer): Pick<ProviderRow, "group" | "hint"> {
  const url = baseUrl(offer.settings);
  if (url === "") return { group: "custom", hint: "Endpoint" };
  if (isLocal(url)) return { group: "local", hint: offer.live ? "Local · live" : "Local" };
  if (!offer.live) return { group: "key", hint: "API key" };
  // A live offer on a remote host signs in through the browser; a plan you already pay for says so.
  return { group: /subscription/i.test(offer.description) ? "subscription" : "gateway", hint: "Browser" };
}

function rank(row: ProviderRow): number {
  const first = FIRST.indexOf(row.driver);
  return GROUPS.indexOf(row.group) * (FIRST.length + 1) + (first === -1 ? FIRST.length : first);
}

type Offer = {
  readonly name: string;
  readonly description: string;
  readonly live: boolean;
  readonly adoptable: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
};

function offersOf(driver: DriverSource): Offer[] {
  let raw: readonly unknown[];
  try {
    raw = driver.offers ?? [];
  } catch {
    return [];
  }
  const offers: Offer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item == null) continue;
    const { name, description, live, adoptable, settings } = item as Record<string, unknown>;
    if (typeof name !== "string" || name === "") continue;
    offers.push({
      name,
      description: typeof description === "string" ? description : "",
      live: live === true,
      adoptable: adoptable === true,
      settings: typeof settings === "object" && settings != null ? (settings as Record<string, unknown>) : {},
    });
  }
  return offers;
}

/** An offer is adopted when a connection of its driver carries its name or its endpoint. */
function adoptedOffer(offer: Offer, spec: AdoptedSource): boolean {
  const url = baseUrl(offer.settings);
  if (url === "") return false;
  return spec.name === offer.name || baseUrl(spec.configuration ?? {}) === url;
}

function baseUrl(settings: { readonly baseUrl?: unknown }): string {
  return typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
