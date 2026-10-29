import { type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { adoptApiKey, WebSearchDriverConnection } from "./connection.js";
import { webSearchSecretsSchema } from "./schemas.js";

export class ExaWebSearchConnection extends WebSearchDriverConnection {
  static override configurationLabel = "exa";
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Exa",
      description: "Exa neural search",
      live: true,
      adoptable: true,
      settings: {},
    },
  ];

  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    return adoptApiKey("Exa", args, callback);
  }

  readonly vendor = "exa" as const;
}
