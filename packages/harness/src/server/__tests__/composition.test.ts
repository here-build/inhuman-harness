import {
  flattenDrivers,
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  registerProviders,
} from "@inhuman.tools/harness-provider-sdk";
import type { DriverMultiplicity } from "@inhuman.tools/plexus-expectations";
import { isDriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { describe, expect, it } from "vitest";

import { chatgptProvider } from "@/providers/chatgpt";
import { cacheFlavorFromBaseUrl } from "@/providers/openai-compat";

import { dedicatedCompatDriver, PRODUCT_PROVIDERS, productBins, productRoster } from "../composition.js";

const EXPECTED_DRIVERS = [
  "openai-compat",
  "openrouter",
  "nous",
  "chatgpt",
  "grok",
  "mcp-stdio",
  "mcp-http",
  "web-keyless",
  "exa",
  "parallel",
  "firecrawl",
  "keenable",
  "tavily",
  "web-nous",
] as const;

type ExpectedDriver = (typeof EXPECTED_DRIVERS)[number];

const EXPECTED: Record<
  ExpectedDriver,
  { readonly abilityClaim: readonly string[]; readonly multiplicity: DriverMultiplicity }
> = {
  "openai-compat": {
    abilityClaim: ["completion"],
    multiplicity: "add-as-secondary",
  },
  openrouter: { abilityClaim: ["completion"], multiplicity: "add-by-default" },
  nous: { abilityClaim: ["completion"], multiplicity: "add-by-default" },
  chatgpt: { abilityClaim: ["completion"], multiplicity: "add-by-default" },
  grok: { abilityClaim: ["completion", "web-search"], multiplicity: "add-by-default" },
  "mcp-stdio": { abilityClaim: ["mcp"], multiplicity: "add-as-secondary" },
  "mcp-http": { abilityClaim: ["mcp"], multiplicity: "add-as-secondary" },
  "web-keyless": {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-by-default",
  },
  "web-nous": {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-by-default",
  },
  exa: { abilityClaim: ["web-search", "web-extract"], multiplicity: "add-as-secondary" },
  parallel: {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-as-secondary",
  },
  firecrawl: {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-as-secondary",
  },
  keenable: {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-as-secondary",
  },
  tavily: {
    abilityClaim: ["web-search", "web-extract"],
    multiplicity: "add-as-secondary",
  },
};

describe("product provider roster", () => {
  it("contains openrouter, chatgpt, grok, nous, mcp, and web drivers", () => {
    const ids = PRODUCT_PROVIDERS.map((provider) => provider.id);
    expect(ids).toEqual(expect.arrayContaining(["openrouter", "chatgpt", "grok", "nous", "mcp", "web"]));
    const drivers = flattenDrivers(PRODUCT_PROVIDERS);
    expect(drivers.map((driver) => driver.name).sort()).toEqual([...EXPECTED_DRIVERS].sort());
    for (const driver of drivers) {
      const expected = EXPECTED[driver.name as ExpectedDriver];
      expect(isDriverConnectionClass(driver.connection)).toBe(true);
      expect(driver.abilityClaim).toEqual(expected.abilityClaim);
      expect(driver.multiplicity).toBe(expected.multiplicity);
    }
  });

  it("rejects colliding provider ids and driver names", () => {
    expect(() => registerProviders([...PRODUCT_PROVIDERS, chatgptProvider])).toThrow(/provider "chatgpt" collides/);
    const shadow = parseProviderRegistration({
      id: "shadow",
      name: "Shadow",
      contract: PROVIDER_SDK_CONTRACT,
      drivers: [
        {
          name: "chatgpt",
          description: "shadow",
          abilityClaim: ["completion"],
          multiplicity: "add-by-default",
          connection: chatgptProvider.drivers[0]!.connection,
        },
      ],
    });
    expect(() => registerProviders([...PRODUCT_PROVIDERS, shadow])).toThrow(/driver "chatgpt" collides/);
  });
});

describe("product topology roster", () => {
  it("names yjs-server and runtime-server roles with runtime requiring yjs", () => {
    const bins = productBins();
    const roster = productRoster(bins);
    expect(
      roster.servers.map((server) => ({
        id: server.id,
        role: server.role,
        requires: server.requires,
      })),
    ).toEqual([
      { id: "yjs", role: "yjs", requires: [] },
      { id: "runtime", role: "runtime", requires: ["yjs"] },
    ]);
    expect(bins.yjs.args.join(" ")).toMatch(/[/\\]dist[/\\]yjs[/\\]bin\.js$/);
    expect(bins.runtime.args.join(" ")).toMatch(/runtime-bin\.js/);
  });
});

describe("generic baseUrl profiles", () => {
  it("keeps openai-compat as fallback; flavor follows cacheFlavorFromBaseUrl", () => {
    const cases = [
      {
        url: "https://openrouter.ai/api/v1",
        dedicated: "openrouter",
        flavor: "openrouter",
      },
      {
        url: "https://chatgpt.com/backend-api/codex",
        dedicated: "chatgpt",
        flavor: "chatgpt",
      },
      { url: "https://api.x.ai/v1", dedicated: "grok", flavor: "grok" },
      {
        url: "https://cli-chat-proxy.grok.com/v1",
        dedicated: "grok",
        flavor: "grok",
      },
      { url: "https://api.openai.com/v1", dedicated: null, flavor: "openai" },
      {
        url: "https://inference-api.nousresearch.com/v1",
        dedicated: "nous",
        flavor: "none",
      },
      { url: "http://127.0.0.1:1234/v1", dedicated: null, flavor: "none" },
      { url: "https://x.ai", dedicated: null, flavor: "none" },
      { url: "https://grok.com", dedicated: null, flavor: "none" },
      { url: "https://openai.com", dedicated: null, flavor: "none" },
    ] as const;
    for (const row of cases) {
      expect({
        dedicated: dedicatedCompatDriver(row.url),
        flavor: cacheFlavorFromBaseUrl(row.url),
      }).toEqual({ dedicated: row.dedicated, flavor: row.flavor });
    }
    expect(flattenDrivers(PRODUCT_PROVIDERS).some((driver) => driver.name === "openai-compat")).toBe(true);
  });
});
