import { z } from "zod";

export const webSearchSecretsSchema = z.looseObject({
  apiKey: z.string({ error: "apiKey must be a string" }).optional(),
});

export const firecrawlConfigurationSchema = z.looseObject({
  apiUrl: z.string({ error: "apiUrl must be a string" }).optional(),
});
