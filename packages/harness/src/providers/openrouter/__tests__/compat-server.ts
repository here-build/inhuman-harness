/**
 * Owned OpenAI-compat fake for loop tests. Bulk JSON only — production
 * `complete()` sends `stream: true`; `#round` accepts this `content-type`.
 * `/chat/completions` and `/responses` both collect the POST body.
 * Caller owns `gate`. `close` does not resolve it. Bad JSON is 400.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type CompatReply =
  | string
  | {
      content?: string;
      tool_calls?: unknown;
      finish_reason?: string;
      usage?: Record<string, unknown>;
    };

export type CompatModel = {
  id: string;
  context_length?: number;
};

export type CompatHandle = {
  readonly baseUrl: string;
  readonly posts: unknown[];
  readonly requestHeaders: Array<Record<string, string>>;
  readonly completionContentType: string;
  close(): Promise<void>;
};

export async function listenCompat(opts: {
  models?: readonly CompatModel[];
  reply: (post: unknown) => CompatReply;
  gate?: Promise<void>;
}): Promise<CompatHandle> {
  const posts: unknown[] = [];
  const requestHeaders: Array<Record<string, string>> = [];
  const models = opts.models ?? [{ id: "m1" }];
  let completionContentType = "";
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url?.endsWith("/models")) {
      json(res, 200, { data: models });
      return;
    }
    if (req.method === "POST" && (req.url?.includes("/chat/completions") || req.url?.includes("/responses"))) {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (opts.gate !== undefined) await opts.gate;
      posts.push(parsed);
      requestHeaders.push(lowerHeaders(req.headers));
      try {
        const body = opts.reply(parsed);
        const text = typeof body === "string" ? body : (body.content ?? "");
        const message =
          typeof body === "string" ? { content: body } : { content: body.content ?? "", tool_calls: body.tool_calls };
        const finish = typeof body === "string" ? "stop" : (body.finish_reason ?? "stop");
        const usage = typeof body === "string" ? undefined : body.usage;
        completionContentType = "application/json";
        if (req.url.includes("/responses")) {
          json(res, 200, {
            output: [{ type: "message", content: [{ type: "output_text", text }] }],
            ...(usage === undefined ? {} : { usage }),
          });
        } else {
          json(res, 200, {
            choices: [{ message, finish_reason: finish }],
            ...(usage === undefined ? {} : { usage }),
          });
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts,
    requestHeaders,
    get completionContentType() {
      return completionContentType;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function lowerHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) out[key.toLowerCase()] = value[0] ?? "";
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
