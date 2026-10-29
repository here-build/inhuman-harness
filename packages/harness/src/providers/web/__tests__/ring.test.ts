import { afterEach, describe, expect, it, vi } from "vitest";

import { extractWithFailover, FAILOVER_TIMEOUT_MS, ringOrder, searchWithFailover } from "../registrations/ring.js";

const signal = new AbortController().signal;
const searchRequest = { query: "q", limit: 5, signal, sessionId: "s" };
const extractRequest = {
  url: "https://example.com",
  charLimit: 2000,
  signal,
  sessionId: "s",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

type Kind = "search" | "extract";

function runKind(kind: Kind, runSignal = signal) {
  return kind === "search"
    ? searchWithFailover({ ...searchRequest, signal: runSignal }, 0)
    : extractWithFailover({ ...extractRequest, signal: runSignal }, 0);
}

function success(kind: Kind): Response {
  return Response.json({
    result: {
      content: [
        {
          type: "text",
          text:
            kind === "search"
              ? JSON.stringify({
                  results: [
                    {
                      title: "Good",
                      url: "https://example.com",
                      snippet: "ok",
                    },
                  ],
                })
              : JSON.stringify({
                  results: [{ url: "https://example.com", text: "ok" }],
                }),
        },
      ],
    },
  });
}

function mcpText(text: string): Response {
  return Response.json({ result: { content: [{ type: "text", text }] } });
}

describe("keyless ring", () => {
  it.each([
    ...(["search", "extract"] as const).flatMap((kind) =>
      (["network", "503", "408", "malformed"] as const).map((failure) => ({
        kind,
        failure,
      })),
    ),
    { kind: "extract" as const, failure: "empty" as const },
  ])("$kind fails over on $failure", async ({ kind, failure }) => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        if (failure === "network") throw new TypeError("fetch failed: connect timeout");
        if (failure === "malformed") return new Response("not MCP");
        if (failure === "empty") return mcpText(" ");
        return new Response("temporary failure", { status: Number(failure) });
      })
      .mockImplementationOnce(async () => success(kind));
    vi.stubGlobal("fetch", fetchMock);
    expect(await runKind(kind)).toMatchObject({
      ok: true,
      vendor: "parallel",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(
    (["search", "extract"] as const).flatMap((kind) => [
      { kind, name: "does not retry a bad request" as const },
      { kind, name: "never starts an already-cancelled request" as const },
      {
        kind,
        name: "retains throttling when every vendor throttles" as const,
      },
      { kind, name: "reports every exhausted provider" as const },
      { kind, name: "preserves cancellation without hopping" as const },
      { kind, name: "stops at the overall time budget" as const },
    ]),
  )("$kind $name", async ({ kind, name }) => {
    if (name === "does not retry a bad request") {
      const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      expect({
        result: await runKind(kind),
        fetches: fetchMock.mock.calls.length,
      }).toMatchObject({
        result: { ok: false, vendor: "exa", retryable: false },
        fetches: 1,
      });
      return;
    }
    if (name === "never starts an already-cancelled request") {
      const controller = new AbortController();
      controller.abort();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(runKind(kind, controller.signal)).rejects.toBe(controller.signal.reason);
      expect(fetchMock).not.toHaveBeenCalled();
      return;
    }
    if (name === "retains throttling when every vendor throttles") {
      vi.stubGlobal("fetch", async () => new Response("rate limit", { status: 429 }));
      expect(await runKind(kind)).toMatchObject({
        ok: false,
        vendor: "keyless",
        throttled: true,
      });
      return;
    }
    if (name === "reports every exhausted provider") {
      const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await runKind(kind);
      expect({
        result: {
          ok: result.ok,
          vendor: result.ok ? undefined : result.vendor,
          throttled: result.ok ? undefined : result.throttled,
        },
        fetches: fetchMock.mock.calls.length,
        named: !result.ok && ringOrder(0).every((vendor) => result.error.includes(`${vendor}:`)),
      }).toEqual({
        result: { ok: false, vendor: "keyless", throttled: false },
        fetches: 5,
        named: true,
      });
      return;
    }
    if (name === "preserves cancellation without hopping") {
      const controller = new AbortController();
      const fetchMock = vi.fn(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(runKind(kind, controller.signal)).rejects.toBe(controller.signal.reason);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      return;
    }
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
    const fetchMock = vi.fn(async () => {
      deadline.abort(new DOMException("timeout", "TimeoutError"));
      throw deadline.signal.reason;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect({
        result: await runKind(kind),
        timeoutMs: timeout.mock.calls[0]?.[0],
        fetches: fetchMock.mock.calls.length,
      }).toMatchObject({
        result: {
          ok: false,
          vendor: "keyless",
          error: expect.stringContaining("time budget exhausted"),
        },
        timeoutMs: FAILOVER_TIMEOUT_MS,
        fetches: 1,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([{ kind: "search" }, { kind: "extract" }] as const)(
    "$kind 429 hops; a 200 stops the walk",
    async ({ kind }) => {
      const seen: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = String(input);
        seen.push(url);
        if (url.includes("mcp.exa.ai") || url.includes("search.parallel.ai")) {
          return new Response("rate limit", { status: 429 });
        }
        if (url.includes("firecrawl")) {
          if (kind === "extract") {
            return Response.json({ data: { markdown: "# F", metadata: { title: "F" } } }, { status: 200 });
          }
          return Response.json(
            {
              data: [{ title: "F", url: "https://f.test", description: "ok" }],
            },
            { status: 200 },
          );
        }
        return new Response("should not reach later vendors", { status: 500 });
      });
      const result = await runKind(kind);
      expect({
        order: { from0: ringOrder(0), from2: ringOrder(2) },
        result,
        hops: seen.map((url) => new URL(url).host),
      }).toEqual({
        order: {
          from0: ["exa", "parallel", "firecrawl", "keenable", "tavily"],
          from2: ["firecrawl", "keenable", "tavily", "exa", "parallel"],
        },
        result:
          kind === "search"
            ? {
                ok: true,
                vendor: "firecrawl",
                hits: [{ title: "F", url: "https://f.test", snippet: "ok" }],
              }
            : {
                ok: true,
                vendor: "firecrawl",
                requestedUrl: "https://example.com",
                url: "https://example.com",
                title: "F",
                markdown: "# F",
                truncated: false,
              },
        hops: ["mcp.exa.ai", "search.parallel.ai", "api.firecrawl.dev"],
      });
    },
  );
});
