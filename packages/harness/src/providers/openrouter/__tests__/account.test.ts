import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { getOpenRouterAccount } from "@/providers/openai-compat";

type KeyBody = {
  label: string;
  limit: number | null;
  limit_reset: string | null;
  limit_remaining: number | null;
  include_byok_in_limit: boolean;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  byok_usage: number;
  byok_usage_daily: number;
  byok_usage_weekly: number;
  byok_usage_monthly: number;
  is_free_tier: boolean;
};

const KEY_DEFAULTS: KeyBody = {
  label: "Harness",
  limit: 10,
  limit_reset: null,
  limit_remaining: 4,
  include_byok_in_limit: false,
  usage: 6,
  usage_daily: 1,
  usage_weekly: 2,
  usage_monthly: 6,
  byok_usage: 0,
  byok_usage_daily: 0,
  byok_usage_weekly: 0,
  byok_usage_monthly: 0,
  is_free_tier: false,
};

async function listenAccount(opts: {
  key: KeyBody;
  credits?: { total_credits: number; total_usage: number };
}): Promise<{
  readonly baseUrl: string;
  readonly headers: Array<Record<string, string>>;
  close(): Promise<void>;
}> {
  const headers: Array<Record<string, string>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") collected[key.toLowerCase()] = value;
    }
    headers.push(collected);
    if (req.url?.endsWith("/key")) {
      json(res, { data: opts.key });
      return;
    }
    if (req.url?.endsWith("/credits")) {
      if (opts.credits === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      json(res, { data: opts.credits });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await new Promise<number>((resolve, reject) => {
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
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("OpenRouter account", () => {
  it("reads key label and remaining from credits when present", async () => {
    const server = await listenAccount({
      key: KEY_DEFAULTS,
      credits: { total_credits: 20, total_usage: 7.5 },
    });
    try {
      const snap = await getOpenRouterAccount({
        baseUrl: server.baseUrl,
        apiKey: "sk-or-testkey1234",
      });
      expect(snap.identity).toEqual({
        shortName: "Harness",
        name: "Harness",
      });
      expect(snap.identityDetail.handle).toBe("Harness");
      expect(snap.identityDetail.key?.label).toBe("Harness");
      expect(snap.identityDetail.key?.mask).toBe("sk-or-...1234");
      expect(snap.balance?.balance).toBe("12.5");
      expect(snap.balanceDetail?.purchased?.amount).toBe("20");
      expect(snap.balanceDetail?.used?.amount).toBe("7.5");
      expect(snap.balanceDetail?.remaining?.amount).toBe("12.5");
      expect(server.headers[0]?.authorization).toBe("Bearer sk-or-testkey1234");
    } finally {
      await server.close();
    }
  });

  it("falls back to limit_remaining when credits is missing", async () => {
    const server = await listenAccount({
      key: { ...KEY_DEFAULTS, limit_remaining: 3, usage: 7 },
    });
    try {
      const snap = await getOpenRouterAccount({
        baseUrl: server.baseUrl,
        apiKey: "sk-or-testkey1234",
      });
      expect(snap.balance?.balance).toBe("3");
      expect(snap.balanceDetail?.used?.amount).toBe("7");
      expect(snap.balanceDetail?.purchased).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("marks unlimited when remaining is null", async () => {
    const server = await listenAccount({
      key: { ...KEY_DEFAULTS, limit: null, limit_remaining: null },
    });
    try {
      const snap = await getOpenRouterAccount({
        baseUrl: server.baseUrl,
        apiKey: "sk-or-testkey1234",
      });
      expect(snap.balance).toBeUndefined();
      expect(snap.balanceDetail?.unlimited).toBe(true);
      expect(snap.balanceDetail?.remaining).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
