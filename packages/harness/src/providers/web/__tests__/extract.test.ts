import { afterEach, describe, expect, it, vi } from "vitest";

import { extractExa, extractFirecrawl, publicHttpUrl } from "../wire/index.js";

const signal = new AbortController().signal;
const request = {
  url: "https://example.com",
  charLimit: 2000,
  signal,
  sessionId: "s",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function thrown(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function mcpText(text: string): Response {
  return Response.json({ result: { content: [{ type: "text", text }] } });
}

describe("web extract", () => {
  it.each([
    {
      name: "publicHttpUrl rejects private hosts and non-http",
      run: async () => ({
        loopback: thrown(() => publicHttpUrl("http://127.0.0.1/")),
        metadata: thrown(() => publicHttpUrl("http://169.254.169.254/latest")),
        file: thrown(() => publicHttpUrl("file:///etc/passwd")),
        public: publicHttpUrl("https://example.com/a").href,
      }),
      want: {
        loopback: expect.stringMatching(/blocked host/),
        metadata: expect.stringMatching(/blocked host/),
        file: expect.stringMatching(/only http/),
        public: "https://example.com/a",
      },
    },
    {
      name: "empty markdown is a miss, not a result",
      run: async () => {
        vi.stubGlobal(
          "fetch",
          async () =>
            new Response(JSON.stringify({ data: { markdown: "  " } }), {
              status: 200,
            }),
        );
        const result = await extractFirecrawl({
          url: "https://spa.test",
          charLimit: 15000,
          signal,
          sessionId: "s",
        });
        return {
          ok: result.ok,
          throttled: result.ok ? undefined : result.throttled,
        };
      },
      want: { ok: false, throttled: false },
    },
    {
      name: "does not fabricate source provenance for unstructured MCP text",
      run: async () => {
        vi.stubGlobal("fetch", async () => mcpText("# Unrelated paper\nURL: https://example.com/"));
        const result = await extractExa(request);
        return {
          ok: result.ok,
          requestedUrl: result.ok ? result.requestedUrl : undefined,
          sourceUrl: result.ok ? result.sourceUrl : undefined,
        };
      },
      want: { ok: true, requestedUrl: request.url, sourceUrl: undefined },
    },
    {
      name: "preserves provider source separately from requested URL",
      run: async () => {
        vi.stubGlobal("fetch", async () =>
          mcpText(
            JSON.stringify({
              results: [{ url: "https://other.test/", text: "content" }],
            }),
          ),
        );
        const result = await extractExa(request);
        return result.ok
          ? {
              ok: true,
              requestedUrl: result.requestedUrl,
              sourceUrl: result.sourceUrl,
              url: result.url,
            }
          : { ok: false };
      },
      want: {
        ok: true,
        requestedUrl: request.url,
        sourceUrl: "https://other.test/",
        url: "https://other.test/",
      },
    },
    {
      name: "rejects malformed JSON",
      run: async () => {
        vi.stubGlobal("fetch", async () => mcpText("{broken"));
        const result = await extractExa(request);
        return {
          ok: result.ok,
          retryable: result.ok ? undefined : result.retryable,
        };
      },
      want: { ok: false, retryable: true },
    },
    {
      name: "rejects provider success:false",
      run: async () => {
        vi.stubGlobal("fetch", async () => mcpText(JSON.stringify({ success: false, markdown: "error" })));
        const result = await extractExa(request);
        return {
          ok: result.ok,
          retryable: result.ok ? undefined : result.retryable,
        };
      },
      want: { ok: false, retryable: true },
    },
    {
      name: "rejects file:// extraction source",
      run: async () => {
        vi.stubGlobal("fetch", async () =>
          mcpText(
            JSON.stringify({
              results: [{ url: "file:///etc/passwd", text: "bad" }],
            }),
          ),
        );
        const result = await extractExa(request);
        return {
          ok: result.ok,
          retryable: result.ok ? undefined : result.retryable,
        };
      },
      want: { ok: false, retryable: true },
    },
    {
      name: "normalizes a top-level array rather than discarding its pages",
      run: async () => {
        vi.stubGlobal("fetch", async () => mcpText(JSON.stringify([{ url: request.url, text: "content" }])));
        const result = await extractExa(request);
        return result.ok ? { ok: true, sourceUrl: result.sourceUrl, markdown: result.markdown } : { ok: false };
      },
      want: { ok: true, sourceUrl: request.url, markdown: "content" },
    },
  ])("$name", async ({ run, want }) => {
    expect(await run()).toEqual(want);
  });
});
