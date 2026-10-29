import http from "node:http";

import { describe, expect, it } from "vitest";

import { probeCachePolicy } from "../cache-affinity.js";

/** Reply behavior for a fake openai-compat server. */
type Behavior = (body: { messages?: { content?: string }[] }) => Record<string, unknown>;

const serve = (behavior: Behavior): Promise<http.Server> =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(raw || "{}") as {
          messages?: { content?: string }[];
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(behavior(parsed)));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

const probe = (server: http.Server) =>
  probeCachePolicy({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`,
    headers: {},
    model: "model-x",
    fetch,
  });

describe("probeCachePolicy", () => {
  it("reports openai when a repeat call hits the prefix cache", async () => {
    let calls = 0;
    const server = await serve(() => {
      calls += 1;
      return {
        usage: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: calls >= 2 ? 128 : 0 },
        },
      };
    });
    try {
      await expect(probe(server)).resolves.toBe("openai");
      expect(calls).toBe(2);
    } finally {
      await close(server);
    }
  });

  it("reports none when cached_tokens stays 0", async () => {
    const server = await serve(() => ({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }));
    try {
      await expect(probe(server)).resolves.toBe("none");
    } finally {
      await close(server);
    }
  });

  it("reports none when usage is unreported", async () => {
    const server = await serve(() => ({}));
    try {
      await expect(probe(server)).resolves.toBe("none");
    } finally {
      await close(server);
    }
  });

  it("reports none on a non-ok response", async () => {
    const server = await serve(() => {
      throw new Error("unused");
    });
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      await expect(probe(server)).resolves.toBe("none");
    } finally {
      await close(server);
    }
  });

  it("probes loopback hosts — a tunnel or proxy there may still cache", async () => {
    let calls = 0;
    const server = await serve(() => {
      calls += 1;
      return { usage: { prompt_tokens_details: { cached_tokens: 64 } } };
    });
    try {
      const result = await probeCachePolicy({
        url: `http://localhost:${(server.address() as { port: number }).port}/v1/chat/completions`,
        headers: {},
        model: "model-x",
        fetch,
      });
      expect(result).toBe("openai");
      expect(calls).toBe(2);
    } finally {
      await close(server);
    }
  });

  it("sends no cache affinity keys — the probe tests caching, not routing", async () => {
    const seen: string[] = [];
    const server = await serve(() => {
      seen.push("called");
      return { usage: { prompt_tokens_details: { cached_tokens: 64 } } };
    });
    const bodies: string[] = [];
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        bodies.push(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            usage: { prompt_tokens_details: { cached_tokens: 64 } },
          }),
        );
      });
    });
    try {
      await probe(server);
      const keys = bodies.flatMap((raw) => Object.keys(JSON.parse(raw) as Record<string, unknown>));
      expect(keys).not.toContain("prompt_cache_key");
      expect(keys).not.toContain("prompt_cache_options");
      expect(keys).not.toContain("session_id");
    } finally {
      await close(server);
    }
  });

  it("shares the prefix across the warm and repeat calls", async () => {
    const contents: string[] = [];
    const server = await serve((parsed) => {
      contents.push(parsed.messages?.[0]?.content ?? "");
      return { usage: { prompt_tokens_details: { cached_tokens: 32 } } };
    });
    try {
      await probe(server);
      expect(contents).toHaveLength(2);
      const [a, b] = contents;
      expect(a).toBeTruthy();
      expect(a?.split(" ").slice(0, 6).join(" ")).toBe(b?.split(" ").slice(0, 6).join(" "));
      expect(a).not.toBe(b);
    } finally {
      await close(server);
    }
  });
});
