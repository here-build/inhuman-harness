/** `web_extract` catalog row. BODY is PEW intern, not this execute. */
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

export const webExtractTool = new InhumanTool({
  name: "web_extract",
  description:
    "Fetch a public URL and return readable markdown. Use after web_search when you have a URL. Output distinguishes requestedUrl from sourceUrl; provenance is provider-reported or unavailable, never independently verified.",
  class: "effect",
  representation: "symbol",
  input: z.object({
    url: z.string().min(1).describe("HTTP or HTTPS URL to read."),
    charLimit: z
      .number()
      .int()
      .min(256)
      .max(100_000)
      .optional()
      .describe("Maximum markdown characters to return. Defaults to 15000."),
  }),
  output: z.object({
    url: z.string(),
    requestedUrl: z.string().optional(),
    sourceUrl: z.string().optional().describe("Source URL supplied by the provider, not independently verified."),
    provenance: z.enum(["unavailable", "provider-reported"]).optional(),
    title: z.string().optional(),
    markdown: z.string(),
    provider: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  run: () => {
    throw new Error("web_extract is PEW intern, not catalog execute");
  },
});
