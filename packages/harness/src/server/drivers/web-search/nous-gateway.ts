import { NOUS_GATEWAY_DRIVER_NAME } from "@/providers/nous";
import {
  firecrawlConfigurationSchema,
  WebSearchDriverConnection,
  webSearchSecretsSchema,
} from "@/providers/web/registrations";
import { FIRECRAWL_NOUS_GATEWAY_URL } from "@/providers/web/wire";

/** Dedicated intern. Token is the live Nous OIDC bag; bootstrap is a no-op. */
export class NousGatewayWebSearchConnection extends WebSearchDriverConnection {
  static override configurationSchema = firecrawlConfigurationSchema;
  static override configurationLabel = NOUS_GATEWAY_DRIVER_NAME;
  static override secretsSchema = webSearchSecretsSchema;
  static offers = [
    {
      name: "Nous Tool Gateway",
      description: "Firecrawl search and extract via Nous Portal OAuth",
      live: true,
      adoptable: false,
      settings: {},
    },
  ];

  readonly vendor = "firecrawl" as const;

  override apiUrl(): string {
    return super.apiUrl() ?? FIRECRAWL_NOUS_GATEWAY_URL;
  }
}
