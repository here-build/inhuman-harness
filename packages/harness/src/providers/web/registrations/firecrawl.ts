import { asAdoptString, type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { WebSearchDriverConnection } from "./connection.js";
import { firecrawlConfigurationSchema, webSearchSecretsSchema } from "./schemas.js";

export class FirecrawlWebSearchConnection extends WebSearchDriverConnection {
  static override configurationSchema = firecrawlConfigurationSchema;
  static override configurationLabel = "firecrawl";
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Firecrawl",
      description: "Firecrawl search",
      live: true,
      adoptable: true,
      settings: {},
    },
  ];

  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    const settings = { ...(args.settings ?? {}) };
    const { input: keyInput } = await callback(
      "UI",
      '(harness/input :name "Firecrawl API key" :description "Optional when a self-hosted URL is set." :secret #t)',
    );
    const { input: urlInput } = await callback(
      "UI",
      '(harness/input :name "Firecrawl API URL" :description "Optional. Empty uses api.firecrawl.dev.")',
    );
    const key = asAdoptString(keyInput);
    const apiUrl = asAdoptString(urlInput);
    if (key === "" && apiUrl === "") throw new Error("Firecrawl API key or API URL is required");
    if (apiUrl !== "") settings.apiUrl = apiUrl;
    const name = (args.name ?? "").trim() || "firecrawl";
    return { name, settings, secrets: key === "" ? {} : { apiKey: key } };
  }

  readonly vendor = "firecrawl" as const;
}
