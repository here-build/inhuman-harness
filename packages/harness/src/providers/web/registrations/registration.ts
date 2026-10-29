import {
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  type RegisteredProvider,
} from "@inhuman.tools/harness-provider-sdk";

import { ExaWebSearchConnection } from "./exa.js";
import { FirecrawlWebSearchConnection } from "./firecrawl.js";
import { KeenableWebSearchConnection } from "./keenable.js";
import { KeylessWebSearchConnection } from "./keyless.js";
import { ParallelWebSearchConnection } from "./parallel.js";
import { TavilyWebSearchConnection } from "./tavily.js";

/**
 * Shipped web roster. Driver names are the existing product IDs.
 * Nous and Grok are other providers.
 */
export const webProvider: RegisteredProvider = parseProviderRegistration({
  id: "web",
  name: "Web search",
  description: "Keyless ring and keyed Exa, Parallel, Firecrawl, Keenable, Tavily",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: "web-keyless",
      description: "Keyless web-search and extract ring",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-by-default",
      connection: KeylessWebSearchConnection,
    },
    {
      name: "exa",
      description: "Exa neural search",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-as-secondary",
      connection: ExaWebSearchConnection,
    },
    {
      name: "parallel",
      description: "Parallel AI search",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-as-secondary",
      connection: ParallelWebSearchConnection,
    },
    {
      name: "firecrawl",
      description: "Firecrawl search",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-as-secondary",
      connection: FirecrawlWebSearchConnection,
    },
    {
      name: "keenable",
      description: "Keenable web index",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-as-secondary",
      connection: KeenableWebSearchConnection,
    },
    {
      name: "tavily",
      description: "Tavily search and extract",
      abilityClaim: ["web-search", "web-extract"],
      multiplicity: "add-as-secondary",
      connection: TavilyWebSearchConnection,
    },
  ],
});
