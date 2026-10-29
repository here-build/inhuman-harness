/** `web_search` catalog row. BODY is PEW intern, not this execute. */
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

export const webSearchTool = new InhumanTool({
  name: "web_search",
  description: "Search the public web. Returns ranked titles, URLs, and snippets.",
  class: "effect",
  representation: "symbol",
  input: z.object({
    query: z.string().min(1).describe("Search query."),
    numResults: z.number().int().min(1).max(10).optional().describe("How many hits to return. Defaults to 5."),
  }),
  output: z.object({
    results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
    provider: z.string().optional(),
  }),
  run: () => {
    throw new Error("web_search is PEW intern, not catalog execute");
  },
});
