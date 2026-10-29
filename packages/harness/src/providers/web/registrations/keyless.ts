import { WebSearchDriverConnection } from "./connection.js";

export class KeylessWebSearchConnection extends WebSearchDriverConnection {
  static override configurationLabel = "web-keyless";
  static offers = [
    {
      name: "Keyless ring",
      description: "Round-robin Exa, Parallel, Firecrawl, Keenable, Tavily public free tiers",
      live: true,
      adoptable: false,
      settings: {},
    },
  ];

  readonly vendor = "keyless" as const;
}
