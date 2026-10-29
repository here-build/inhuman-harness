import { type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { adoptApiKey, WebSearchDriverConnection } from "./connection.js";
import { webSearchSecretsSchema } from "./schemas.js";

export class ParallelWebSearchConnection extends WebSearchDriverConnection {
  static override configurationLabel = "parallel";
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Parallel",
      description: "Parallel AI search",
      live: true,
      adoptable: true,
      settings: {},
    },
  ];

  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    return adoptApiKey("Parallel", args, callback);
  }

  readonly vendor = "parallel" as const;
}
