import { type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { adoptApiKey, WebSearchDriverConnection } from "./connection.js";
import { webSearchSecretsSchema } from "./schemas.js";

export class TavilyWebSearchConnection extends WebSearchDriverConnection {
  static override configurationLabel = "tavily";
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Tavily",
      description: "Tavily search and extract",
      live: true,
      adoptable: true,
      settings: {},
    },
  ];

  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    return adoptApiKey("Tavily", args, callback);
  }

  readonly vendor = "tavily" as const;
}
