import { type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { adoptApiKey, WebSearchDriverConnection } from "./connection.js";
import { webSearchSecretsSchema } from "./schemas.js";

export class KeenableWebSearchConnection extends WebSearchDriverConnection {
  static override configurationLabel = "keenable";
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Keenable",
      description: "Keenable web index",
      live: true,
      adoptable: true,
      settings: {},
    },
  ];

  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    return adoptApiKey("Keenable", args, callback);
  }

  readonly vendor = "keenable" as const;
}
