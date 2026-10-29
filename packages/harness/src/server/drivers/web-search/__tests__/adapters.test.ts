import { RequestInfo } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIRECRAWL_NOUS_GATEWAY_URL,
  parseExaSearchText,
  searchExa,
  searchFirecrawl,
  searchKeenable,
  searchTavily,
  extractTavily,
  SearchHttpError,
  parseMcpToolText,
} from "@/providers/web/wire";

const signal = new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web-search adapters", () => {
  it("parses Exa Title/URL/Highlights and MCP JSON-RPC text", () => {
    const text = [
      "Title: Tea",
      "URL: https://tea.test/a",
      "Highlights:",
      "leaf water",
      "---",
      "Title: Coffee",
      "URL: https://coffee.test/b",
      "Highlights:",
      "bean",
    ].join("\n");
    let mcpError = false;
    try {
      parseMcpToolText(
        JSON.stringify({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "429 quota" }] } }),
      );
    } catch (error) {
      mcpError = error instanceof SearchHttpError;
    }
    expect({
      exa: parseExaSearchText(text, 5),
      mcp: parseMcpToolText(
        JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: "ok body" }] } }),
      ),
      mcpError,
    }).toEqual({
      exa: [
        { title: "Tea", url: "https://tea.test/a", snippet: "leaf water" },
        { title: "Coffee", url: "https://coffee.test/b", snippet: "bean" },
      ],
      mcp: "ok body",
      mcpError: true,
    });
  });

  it("Nous Tool Gateway Firecrawl posts the Portal JWT to the gateway origin", async () => {
    let url = "";
    let auth = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({ data: { web: [{ title: "G", url: "https://g.test", description: "d" }] } }),
        {
          status: 200,
        },
      );
    });
    const result = await searchFirecrawl({
      query: "q",
      limit: 3,
      signal,
      sessionId: "s",
      apiKey: "portal-jwt",
      apiUrl: FIRECRAWL_NOUS_GATEWAY_URL,
    });
    expect({ result, url, auth }).toEqual({
      result: { ok: true, vendor: "firecrawl", hits: [{ title: "G", url: "https://g.test", snippet: "d" }] },
      url: `${FIRECRAWL_NOUS_GATEWAY_URL}/v2/search`,
      auth: "Bearer portal-jwt",
    });
  });

  it.each([
    {
      name: "keyless Exa uses MCP; keyed Exa uses REST and maps highlights",
      run: async () => {
        const fetches: Array<{ url: string; headers: Headers }> = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          fetches.push({ url, headers: new Headers(init?.headers) });
          if (url.includes("mcp.exa.ai")) {
            return Response.json(
              {
                result: { content: [{ type: "text", text: "Title: A\nURL: https://a.test\nHighlights:\nhi" }] },
              },
              { status: 200 },
            );
          }
          return Response.json(
            { results: [{ title: "B", url: "https://b.test", highlights: ["x"] }] },
            {
              status: 200,
            },
          );
        });
        const keyless = await searchExa({ query: "q", limit: 5, signal, sessionId: "s" });
        const keyed = await searchExa({ query: "q", limit: 5, signal, sessionId: "s", apiKey: "exa-key" });
        return {
          keyless,
          keyed,
          mcpAuth: fetches[0]?.headers.get("authorization"),
          restKey: fetches[1]?.headers.get("x-api-key"),
        };
      },
      want: {
        keyless: { ok: true, vendor: "exa", hits: [{ title: "A", url: "https://a.test", snippet: "hi" }] },
        keyed: { ok: true, vendor: "exa", hits: [{ title: "B", url: "https://b.test", snippet: "x" }] },
        mcpAuth: null,
        restKey: "exa-key",
      },
    },
    {
      name: "keyless Firecrawl and Keenable send no Authorization",
      run: async () => {
        const headers: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          headers.push(new Headers(init?.headers).get("authorization") ?? "");
          const url = String(input);
          if (url.includes("firecrawl")) {
            return Response.json(
              { data: { web: [{ title: "F", url: "https://f.test", description: "d" }] } },
              { status: 200 },
            );
          }
          return Response.json(
            { results: [{ title: "K", url: "https://k.test", snippet: "s" }] },
            {
              status: 200,
            },
          );
        });
        const firecrawl = await searchFirecrawl({ query: "q", limit: 3, signal, sessionId: "s" });
        const keenable = await searchKeenable({ query: "q", limit: 3, signal, sessionId: "s" });
        return { firecrawl, keenable, headers };
      },
      want: {
        firecrawl: { ok: true, vendor: "firecrawl", hits: [{ title: "F", url: "https://f.test", snippet: "d" }] },
        keenable: { ok: true, vendor: "keenable", hits: [{ title: "K", url: "https://k.test", snippet: "s" }] },
        headers: ["", ""],
      },
    },
    {
      name: "keyless Tavily sends X-Tavily-Access-Mode; keyed sends Bearer",
      run: async () => {
        const headers: Array<{ mode: string | null; auth: string | null }> = [];
        vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
          const h = new Headers(init?.headers);
          headers.push({ mode: h.get("x-tavily-access-mode"), auth: h.get("authorization") });
          return Response.json(
            { results: [{ title: "T", url: "https://t.test", content: "snip" }] },
            {
              status: 200,
            },
          );
        });
        const keyless = await searchTavily({ query: "q", limit: 3, signal, sessionId: "s" });
        const keyed = await searchTavily({ query: "q", limit: 3, signal, sessionId: "s", apiKey: "tvly-x" });
        return { keyless, keyed, headers };
      },
      want: {
        keyless: { ok: true, vendor: "tavily", hits: [{ title: "T", url: "https://t.test", snippet: "snip" }] },
        keyed: { ok: true, vendor: "tavily", hits: [{ title: "T", url: "https://t.test", snippet: "snip" }] },
        headers: [
          { mode: "keyless", auth: null },
          { mode: null, auth: "Bearer tvly-x" },
        ],
      },
    },
    {
      name: "keyless Tavily extract posts /extract with keyless header",
      run: async () => {
        let url = "";
        let mode: string | null = null;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          url = String(input);
          mode = new Headers(init?.headers).get("x-tavily-access-mode");
          return Response.json(
            { results: [{ url: "https://tea.test", raw_content: "# Tea\n\nleaf", title: "Tea" }] },
            { status: 200 },
          );
        });
        const result = await extractTavily({
          url: "https://tea.test",
          charLimit: 15_000,
          signal,
          sessionId: "s",
        });
        return { result, extractPath: url.includes("/extract"), mode };
      },
      want: {
        result: {
          ok: true,
          vendor: "tavily",
          requestedUrl: "https://tea.test",
          sourceUrl: "https://tea.test",
          url: "https://tea.test",
          title: "Tea",
          markdown: "# Tea\n\nleaf",
          truncated: false,
        },
        extractPath: true,
        mode: "keyless",
      },
    },
    {
      name: "Exa MCP search supplies the objective required by the live schema",
      run: async () => {
        let params: unknown;
        vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
          params = JSON.parse(String(init?.body)).params;
          return Response.json({
            result: { content: [{ type: "text", text: "Title: Tea\nURL: https://tea.test\nHighlights:\nleaf" }] },
          });
        });
        const result = await searchExa({ query: "tea", limit: 3, signal, sessionId: "s" });
        return { ok: result.ok, vendor: result.ok ? result.vendor : undefined, params };
      },
      want: {
        ok: true,
        vendor: "exa",
        params: { name: "web_search_exa", arguments: { query: "tea", objective: "tea", numResults: 3 } },
      },
    },
  ])("$name", async ({ run, want }) => {
    expect(await run()).toEqual(want);
  });
});
