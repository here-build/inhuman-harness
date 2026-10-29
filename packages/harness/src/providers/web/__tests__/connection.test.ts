import { ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExaWebSearchConnection,
  FirecrawlWebSearchConnection,
  KeylessWebSearchConnection,
} from "../registrations/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web search/extract connections", () => {
  it("keyless search walks the ring; keyed Exa posts the API key", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("api.exa.ai/search")) {
        const key = new Headers(init?.headers).get("x-api-key");
        return Response.json({
          results: [{ title: "E", url: "https://e.test", highlights: ["keyed", key] }],
        });
      }
      // Independent of process ringCursor: every free-tier host but Firecrawl
      // 429s, so the walk always lands on Firecrawl.
      if (url.includes("api.firecrawl.dev")) {
        return Response.json({
          data: [{ title: "F", url: "https://f.test", description: "ok" }],
        });
      }
      return new Response("rate limit", { status: 429 });
    });

    const keyless = new KeylessWebSearchConnection("web-keyless");
    await keyless.ensureBootstrapStarted();
    const keylessHit = await keyless.webSearch({ query: "tea", limit: 3 });

    const exa = new ExaWebSearchConnection("exa", {}, { apiKey: "exa-secret" });
    await exa.ensureBootstrapStarted();
    const keyed = await exa.webSearch({ query: "tea", limit: 3 });

    expect(keylessHit).toEqual({
      ok: true,
      value: {
        results: [{ title: "F", url: "https://f.test", snippet: "ok" }],
        provider: "firecrawl",
      },
    });
    expect(keyed).toEqual({
      ok: true,
      value: {
        results: [{ title: "E", url: "https://e.test", snippet: "keyed exa-secret" }],
        provider: "exa",
      },
    });
    expect(seen.some((url) => url.includes("api.firecrawl.dev"))).toBe(true);
    expect(seen.some((url) => url.includes("api.exa.ai/search"))).toBe(true);
  });

  it("extract rejects private URLs; keyed vendor needs auth without a key", async () => {
    const keyless = new KeylessWebSearchConnection("web-keyless");
    await keyless.ensureBootstrapStarted();
    const blocked = await keyless.webExtract({ url: "http://127.0.0.1/" });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toMatch(/blocked host/);

    const exa = new ExaWebSearchConnection("exa");
    await exa.ensureBootstrapStarted();
    expect(exa.needsAuth).toBe(true);
    await expect(exa.webSearch({ query: "tea" })).rejects.toBeInstanceOf(ConnectionMiss);
  });

  it("Firecrawl adopt keeps key-or-url and existing labels", async () => {
    const adopted = await FirecrawlWebSearchConnection.adopt({}, async (_kind, body) => {
      if (body.includes("API key")) return { input: "" };
      if (body.includes("API URL")) return { input: "https://fc.example" };
      return {};
    });
    expect(adopted).toEqual({
      name: "firecrawl",
      settings: { apiUrl: "https://fc.example" },
      secrets: {},
    });
    await expect(FirecrawlWebSearchConnection.adopt({}, async () => ({ input: "" }))).rejects.toThrow(
      /API key or API URL is required/,
    );
  });
});
