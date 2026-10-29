import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokDriverConnection } from "@/providers/grok";
import { OpenAiCompatDriverConnection } from "@/providers/openai-compat";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function jsonCatalog(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function probe(connection: OpenAiCompatDriverConnection): Promise<{
  readyState: OpenAiCompatDriverConnection["readyState"];
  error: string;
  models: readonly string[];
  windows: Record<string, number>;
  catalogName: string;
  threw: string | undefined;
}> {
  let threw: string | undefined;
  try {
    await connection.ensureBootstrapStarted();
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  const snap = {
    readyState: connection.readyState,
    error: connection.error,
    models: connection.state.models,
    windows: connection.state.windows,
    catalogName: connection.state.catalogName,
    threw,
  };
  await connection[Symbol.asyncDispose]();
  return snap;
}

async function withServer(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<OpenAiCompatDriverConnection>,
) {
  const server = createServer(handle);
  const port = await listen(server);
  try {
    return await probe(await run(`http://127.0.0.1:${port}/v1`));
  } finally {
    await closeServer(server);
  }
}

describe("openai-compat bootstrap health: catalog probe, naming, OIDC refresh-before-probe", () => {
  it("200 is ready; 401/network fail; named driver has no baked catalog; OIDC refreshes before the catalog probe; refresh miss keeps ready", async () => {
    expect({
      ok: await withServer(
        (_req, res) => jsonCatalog(res, { data: [{ id: "m1" }, { id: "m2" }] }),
        async (baseUrl) => new OpenAiCompatDriverConnection("row", { baseUrl }),
      ),
      empty: await withServer(
        (_req, res) => jsonCatalog(res, { data: [] }),
        async (baseUrl) => new OpenAiCompatDriverConnection("row", { baseUrl }),
      ),
    }).toMatchObject({
      ok: { readyState: "ready", error: "", models: ["m1", "m2"], windows: {}, threw: undefined },
      empty: { readyState: "ready", models: [], windows: {}, threw: undefined },
    });

    const unauthorized = await withServer(
      (_req, res) => {
        res.writeHead(401);
        res.end("nope");
      },
      async (baseUrl) => new OpenAiCompatDriverConnection("row", { baseUrl }),
    );
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
      });
    }) as typeof fetch;
    const network = await probe(new OpenAiCompatDriverConnection("row", { baseUrl: "https://example.test/v1" }));
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("Connect Timeout Error (attempted address: cli-chat-proxy.grok.com:443, timeout: 10000ms)"),
          { code: "UND_ERR_CONNECT_TIMEOUT" },
        ),
      });
    }) as typeof fetch;
    const named = await probe(
      new GrokDriverConnection("grok", { baseUrl: "https://cli-chat-proxy.grok.com/v1" }, { apiKey: "grok-at" }),
    );
    expect({
      unauthorized: {
        readyState: unauthorized.readyState,
        error: unauthorized.error,
        threw: unauthorized.threw,
      },
      network: {
        readyState: network.readyState,
        error: network.error,
        threw: network.threw,
        errorIsThrew: network.error === network.threw,
      },
      named: { readyState: named.readyState, models: named.models, threw: named.threw },
    }).toEqual({
      unauthorized: {
        readyState: "failed",
        error: expect.stringMatching(/HTTP 401/),
        threw: expect.stringMatching(/models probe GET .+HTTP 401/),
      },
      network: {
        readyState: "failed",
        error: expect.stringMatching(/ECONNREFUSED/),
        threw: expect.stringMatching(/models probe GET https:\/\/example\.test\/v1\/models.+ECONNREFUSED/),
        errorIsThrew: true,
      },
      named: {
        readyState: "failed",
        models: [],
        threw: expect.stringMatching(
          /models probe GET https:\/\/cli-chat-proxy\.grok\.com\/v1\/models.+Connect Timeout Error/,
        ),
      },
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })) as typeof fetch;
    const example = await probe(new OpenAiCompatDriverConnection("row", { baseUrl: "https://api.example.test/v1" }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "llama" }] }), { status: 200 })) as typeof fetch;
    const ollama = await probe(new OpenAiCompatDriverConnection("row", { baseUrl: "http://127.0.0.1:11434/v1" }));
    expect({ example: example.catalogName, ollama: ollama.catalogName }).toEqual({
      example: "example.test",
      ollama: "Ollama",
    });

    const calls: string[] = [];
    let grantType: string | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url) === GrokDriverConnection.oidcProfile.tokenUrl) {
        grantType = new URLSearchParams(String(init?.body)).get("grant_type");
        return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), { status: 200 });
    }) as typeof fetch;
    const deposited: Record<string, string>[] = [];
    const connection = new GrokDriverConnection(
      "grok",
      { baseUrl: GrokDriverConnection.oidcProfile.baseUrl },
      {
        get: (field) =>
          ({ apiKey: "old-at", refreshToken: "old-rt", expiresAt: new Date(Date.now() + 60_000).toISOString() })[field],
        all: () => ({
          apiKey: "old-at",
          refreshToken: "old-rt",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        replace: (bag: Readonly<Record<string, string>>) => {
          deposited.push({ ...bag });
        },
      },
    );
    await connection.ensureBootstrapStarted();
    expect({
      first: calls[0],
      second: calls[1],
      grantType,
      deposited: deposited[0],
    }).toEqual({
      first: GrokDriverConnection.oidcProfile.tokenUrl,
      second: `${GrokDriverConnection.oidcProfile.baseUrl}/models`,
      grantType: "refresh_token",
      deposited: expect.objectContaining({ apiKey: "new-at", refreshToken: "new-rt" }),
    });
    await connection[Symbol.asyncDispose]();

    vi.useFakeTimers();
    let probes = 0;
    globalThis.fetch = (async () => {
      probes += 1;
      if (probes === 1) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-6-astra" }] }), { status: 200 });
      }
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("Connect Timeout Error (attempted addresses: 172.64.155.209:443, timeout: 10000ms)"),
          { code: "UND_ERR_CONNECT_TIMEOUT" },
        ),
      });
    }) as typeof fetch;
    const refresh = new OpenAiCompatDriverConnection("row", { baseUrl: "https://api.example.test/v1" });
    await refresh.ensureBootstrapStarted();
    await vi.advanceTimersByTimeAsync(30_000);
    expect({
      readyState: refresh.readyState,
      error: refresh.error,
      models: refresh.state.models,
      probes,
    }).toEqual({
      readyState: "ready",
      error: "",
      models: ["gpt-6-astra"],
      probes: 2,
    });
    await refresh[Symbol.asyncDispose]();
  });

  it("settings.contextWindow overrides a /models that omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "Atria-Dawn-Preview" }] }), { status: 200 })) as typeof fetch;
    const manual = await probe(
      new OpenAiCompatDriverConnection("row", {
        baseUrl: "https://api.example.test/v1",
        contextWindow: { "row:Atria-Dawn-Preview": 128_000 },
      }),
    );
    expect(manual.windows).toEqual({ "Atria-Dawn-Preview": 128_000 });
  });

  it("settings.contextWindow wins over the server-reported window", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "big", context_length: 1_000_000 }] }), {
        status: 200,
      })) as typeof fetch;
    const manual = await probe(
      new OpenAiCompatDriverConnection("row", {
        baseUrl: "https://api.example.test/v1",
        contextWindow: { "row:big": 32_000 },
      }),
    );
    expect(manual.windows).toEqual({ big: 32_000 });
  });

  it("a contextWindow key for a different connection or model is ignored", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })) as typeof fetch;
    const manual = await probe(
      new OpenAiCompatDriverConnection("row", {
        baseUrl: "https://api.example.test/v1",
        contextWindow: { "other:m": 32_000, "row:other": 64_000 },
      }),
    );
    expect(manual.windows).toEqual({});
  });
});
