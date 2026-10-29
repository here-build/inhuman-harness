import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { afterEach, describe, expect, it } from "vitest";

import { bindSessionCatalog, KernelToolCatalog } from "@/tool-catalog";

import { hitCallback, parkedUrl } from "../../auth/__tests__/browser.js";
import { ChatGptDriverConnection, CHATGPT_CLIENT_VERSION } from "../index.js";
import { listenChatGpt } from "./chatgpt-server.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function passAuth(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("auth.openai.com")) {
      return new Response("{}", { status: 200 });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  res.end(JSON.stringify(body));
}

async function listenAuth(): Promise<{
  readonly origin: string;
  readonly grants: Array<Record<string, string>>;
  close(): Promise<void>;
}> {
  const grants: Array<Record<string, string>> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url.startsWith("/oauth/token")) {
        const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        grants.push(form);
        sendJson(res, 200, {
          access_token: "codex-at",
          refresh_token: "codex-rt",
          expires_in: 3600,
          id_token: unsignedJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
          }),
        });
        return;
      }
      if (url.startsWith("/userinfo")) {
        sendJson(res, 200, {
          email: "plus@example.com",
          name: "Plus",
        });
        return;
      }
      res.writeHead(404);
      res.end();
    })();
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
    origin: `http://127.0.0.1:${port}`,
    grants,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("chatgpt local wire", () => {
  it("discovers slug models, polls usage, and posts Responses with session cache", async () => {
    const wire = await listenChatGpt({ model: "gpt-5.4" });
    globalThis.fetch = passAuth(originalFetch);
    const secrets = { apiKey: "codex-at", accountId: "acct-1" };
    const connection = new ChatGptDriverConnection(
      "chatgpt",
      { baseUrl: wire.baseUrl, model: "gpt-5.4" },
      {
        get: (field) => secrets[field as keyof typeof secrets],
        all: () => secrets,
      },
    );
    const plexus = SessionPlexus.create("sess-chatgpt", "/ws");
    bindSessionCatalog(plexus.root, new KernelToolCatalog());
    try {
      await connection.ensureBootstrapStarted();
      const modelsHit = wire.hits.find((hit) => hit.url.startsWith("/backend-api/codex/models"));
      const usageHit = wire.hits.find((hit) => hit.url.startsWith("/backend-api/wham/usage"));
      expect(modelsHit?.url).toContain(`client_version=${CHATGPT_CLIENT_VERSION}`);
      expect(connection.state.models).toEqual(["gpt-5.4"]);
      expect(connection.state.account?.balanceDetail?.windows?.map((row) => row.label)).toEqual(["5h", "weekly"]);
      expect(usageHit?.headers.originator).toBe("codex_cli_rs");
      expect(usageHit?.headers["chatgpt-account-id"]).toBe("acct-1");

      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: connection.connectionId,
      });
      plexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`hi`,
        doneWork: [new CompletionJob({ expectation: round })],
        queue: [],
      });
      const actor = connection.resolveExpectation(round);
      actor.start();
      const settlement = await actor.settled;
      if (settlement.outcome !== "complete") {
        throw new Error(String(settlement.reason));
      }
      const posted = wire.hits.find((hit) => hit.method === "POST");
      const body = posted?.body as Record<string, unknown> | undefined;
      expect(settlement.result.text).toBe("Hi there");
      expect(posted?.url).toBe("/backend-api/codex/responses");
      expect(posted?.headers.originator).toBe("codex_cli_rs");
      expect(posted?.headers["user-agent"]).toBe(`codex_cli_rs/${CHATGPT_CLIENT_VERSION}`);
      expect(posted?.headers["chatgpt-account-id"]).toBe("acct-1");
      expect(posted?.headers["session-id"]).toBe("sess-chatgpt");
      expect(posted?.headers["thread-id"]).toBe("sess-chatgpt");
      expect(body?.prompt_cache_key).toBe("sess-chatgpt");
      expect(body).not.toHaveProperty("prompt_cache_options");
      expect(body).not.toHaveProperty("prompt_cache_retention");
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await wire.close();
    }
  });

  it("adopts via local OIDC code exchange and keeps the chatgpt driver id", async () => {
    const auth = await listenAuth();
    const wire = await listenChatGpt();
    class LocalChatGpt extends ChatGptDriverConnection {
      static oidcProfile = {
        ...ChatGptDriverConnection.oidcProfile,
        authorizeUrl: `${auth.origin}/oauth/authorize`,
        tokenUrl: `${auth.origin}/oauth/token`,
        userinfoUrl: `${auth.origin}/userinfo`,
        baseUrl: wire.baseUrl,
      };
    }
    try {
      const bags = await LocalChatGpt.adopt({}, async (_kind, body) => {
        const url = parkedUrl(body);
        expect(url.searchParams.get("client_id")).toBe(ChatGptDriverConnection.oidcProfile.clientId);
        expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        return hitCallback(body, { code: "auth-code", state: url.searchParams.get("state") ?? "" });
      });
      expect(bags.settings.baseUrl).toBe(wire.baseUrl);
      expect(bags.secrets.apiKey).toBe("codex-at");
      expect(bags.secrets.refreshToken).toBe("codex-rt");
      expect(bags.secrets.accountId).toBe("acct-1");
      expect(auth.grants[0]?.grant_type).toBe("authorization_code");
      expect(auth.grants[0]?.code).toBe("auth-code");
      expect(auth.grants[0]?.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      expect(LocalChatGpt.configurationLabel).toBe("chatgpt");
    } finally {
      await auth.close();
      await wire.close();
    }
  });
});
