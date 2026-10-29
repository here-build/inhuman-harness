/**
 * Scripted Grok CLI-proxy for loop tests. Chat Completions, Responses search,
 * models, user, and billing. Caller owns `gate`. `close` does not resolve it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type GrokChatReply = string;

export type GrokHandle = {
  readonly baseUrl: string;
  readonly posts: unknown[];
  readonly requestHeaders: Array<Record<string, string>>;
  readonly paths: string[];
  close(): Promise<void>;
};

export async function listenGrok(opts: {
  models?: readonly { id: string }[];
  reply?: (post: unknown) => GrokChatReply;
  /** When set, that POST is this status instead of the scripted 200 reply. */
  chat?: (post: unknown, index: number) => { readonly status: number; readonly body: unknown } | undefined;
  search?: (post: unknown) => unknown;
  billing?: unknown;
  user?: unknown;
  gate?: Promise<void>;
}): Promise<GrokHandle> {
  const posts: unknown[] = [];
  const requestHeaders: Array<Record<string, string>> = [];
  const paths: string[] = [];
  const models = opts.models ?? [{ id: "grok-4" }];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "";
    paths.push(`${req.method ?? "GET"} ${url}`);
    try {
      if (url.includes("/models")) {
        json(res, 200, { data: models });
        return;
      }
      if (req.method === "GET" && url.includes("/user")) {
        json(
          res,
          200,
          opts.user ?? {
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@x.test",
            subscriptionTier: "super",
          },
        );
        return;
      }
      if (req.method === "GET" && url.includes("/billing")) {
        json(
          res,
          200,
          opts.billing ?? {
            config: {
              creditUsagePercent: 40,
              currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEK" },
            },
          },
        );
        return;
      }
      if (req.method === "POST" && url.includes("/chat/completions")) {
        const parsed = await readJson(req, res);
        if (parsed === undefined) return;
        if (opts.gate !== undefined) await opts.gate;
        const index = posts.length;
        posts.push(parsed);
        requestHeaders.push(lowerHeaders(req.headers));
        const decided = opts.chat?.(parsed, index);
        if (decided !== undefined) {
          json(res, decided.status, decided.body);
          return;
        }
        const text = opts.reply?.(parsed) ?? "ok";
        json(res, 200, {
          choices: [{ message: { content: text }, finish_reason: "stop" }],
        });
        return;
      }
      if (req.method === "POST" && url.includes("/responses")) {
        const parsed = await readJson(req, res);
        if (parsed === undefined) return;
        if (opts.gate !== undefined) await opts.gate;
        posts.push(parsed);
        requestHeaders.push(lowerHeaders(req.headers));
        if (opts.search !== undefined) {
          json(res, 200, opts.search(parsed));
          return;
        }
        const text = opts.reply?.(parsed) ?? "";
        json(res, 200, {
          output: [{ type: "message", content: [{ type: "output_text", text }] }],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts,
    requestHeaders,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function passAuth(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("auth.x.ai")) {
      return new Response("{}", { status: 200 });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

export function installGrokFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = passAuth(original);
  return () => {
    globalThis.fetch = original;
  };
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid json" }));
    return undefined;
  }
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) {
      const first = value.at(0);
      if (typeof first === "string") out[key.toLowerCase()] = first;
    }
  }
  return out;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
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
