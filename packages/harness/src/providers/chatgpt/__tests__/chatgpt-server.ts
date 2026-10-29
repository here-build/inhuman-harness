/**
 * Scripted ChatGPT subscription wire: slug catalog, Responses, wham usage.
 * Auth hosts are the caller's fetch door.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type ChatGptHit = {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
};

export type ChatGptHandle = {
  readonly origin: string;
  readonly baseUrl: string;
  readonly hits: ChatGptHit[];
  close(): Promise<void>;
};

export async function listenChatGpt(opts?: {
  model?: string;
  reply?: (hit: ChatGptHit) => {
    readonly status?: number;
    readonly contentType?: string;
    readonly body: string;
  };
  usage?: unknown;
}): Promise<ChatGptHandle> {
  const hits: ChatGptHit[] = [];
  const model = opts?.model ?? "gpt-5.4";
  const usage =
    opts?.usage ??
    ({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_after_seconds: 100,
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 604_800,
          reset_after_seconds: 200,
        },
      },
    } as const);
  const defaultReply = (): {
    readonly status?: number;
    readonly contentType?: string;
    readonly body: string;
  } => ({
    contentType: "text/event-stream",
    body: [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " there" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
    ].join(""),
  });
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const headers = lowerHeaders(req.headers);
    if (url.startsWith("/backend-api/codex/models")) {
      hits.push({ method: req.method ?? "GET", url, headers, body: null });
      json(res, 200, { models: [{ slug: model }] });
      return;
    }
    if (url.startsWith("/backend-api/wham/usage")) {
      hits.push({ method: req.method ?? "GET", url, headers, body: null });
      json(res, 200, usage);
      return;
    }
    if (req.method === "POST" && url.startsWith("/backend-api/codex/responses")) {
      const raw = await readBody(req);
      let parsed: unknown = null;
      if (raw !== "") {
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
      }
      const hit: ChatGptHit = {
        method: "POST",
        url,
        headers,
        body: parsed,
      };
      hits.push(hit);
      const reply = (opts?.reply ?? defaultReply)(hit);
      res.writeHead(reply.status ?? 200, {
        "content-type": reply.contentType ?? "application/json",
      });
      res.end(reply.body);
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    baseUrl: `${origin}/backend-api/codex`,
    hits,
    close: () => closeServer(server),
  };
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) {
      const first = value[0];
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
