/**
 * MCP OAuth lifecycle: PKCE park + exchange; reject state mismatch / missing state;
 * logout clears secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect, it } from "vitest";

import { followAuthorize, hitCallback } from "../../auth/__tests__/browser.js";
import { loginMcpHttp, logoutMcpHttp, type McpOAuthHost } from "../oauth.js";

const LOOPBACK = "http://127.0.0.1/callback";

type OwnedAuth = {
  readonly origin: string;
  readonly mcpUrl: string;
  close(): Promise<void>;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { connection: "close", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, { "content-type": "application/json" }, JSON.stringify(body));
}

async function startOwnedMcpAuth(): Promise<OwnedAuth> {
  const codes = new Map<string, { challenge: string }>();
  const httpServer = createServer((req, res) => {
    void (async () => {
      const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
      const url = new URL(req.url ?? "/", origin);
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      if (pathname === "/mcp") {
        send(
          res,
          401,
          {
            "content-type": "text/plain",
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
          "unauthorized",
        );
        return;
      }
      if (pathname === "/.well-known/oauth-protected-resource") {
        sendJson(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["mcp:tools"],
        });
        return;
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        sendJson(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (pathname === "/register") {
        await readBody(req);
        sendJson(res, 200, {
          client_id: "harness-public",
          token_endpoint_auth_method: "none",
        });
        return;
      }
      if (pathname === "/authorize") {
        const code = randomBytes(16).toString("base64url");
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
        });
        const redirect = new URL(url.searchParams.get("redirect_uri") || LOOPBACK);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        send(res, 302, { location: redirect.toString() }, "");
        return;
      }
      if (pathname === "/token") {
        const params = new URLSearchParams(await readBody(req));
        const stored = codes.get(params.get("code") ?? "");
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (stored === undefined || stored.challenge !== challenge) {
          sendJson(res, 400, { error: "invalid_grant" });
          return;
        }
        sendJson(res, 200, {
          access_token: "mcp-access",
          token_type: "Bearer",
          expires_in: 3600,
        });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, {}, "");
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  const origin = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function echoHost(overrides: Partial<McpOAuthHost> = {}): {
  parked: { body: string };
  written: Array<{ id: string; secrets: Readonly<Record<string, string>> }>;
  host: McpOAuthHost;
} {
  const parked = { body: "" };
  const written: Array<{
    id: string;
    secrets: Readonly<Record<string, string>>;
  }> = [];
  const host: McpOAuthHost = {
    ui: async (body) => {
      parked.body = body;
      return followAuthorize(body);
    },
    writeSecrets(id, secrets) {
      written.push({ id, secrets });
    },
    readSecrets: () => ({}),
    ...overrides,
  };
  return { parked, written, host };
}

function authorizeFrom(body: string): URL {
  const urlMatch = body.match(/https?:\/\/[^\s"]+/);
  if (urlMatch === null) throw new Error(`parked body has no authorize URL: ${body}`);
  return new URL(urlMatch[0]);
}

async function settledMessage(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "ok",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

it("MCP OAuth lifecycle", async () => {
  const server = await startOwnedMcpAuth();
  try {
    const pkce = echoHost();
    await loginMcpHttp("row-1", server.mcpUrl, pkce.host);
    const authorize = authorizeFrom(pkce.parked.body);
    expect({
      parked: pkce.parked.body.includes("harness/open-url"),
      origin: authorize.origin,
      pathname: authorize.pathname,
      response_type: authorize.searchParams.get("response_type"),
      client_id: authorize.searchParams.get("client_id"),
      redirect_uri: authorize.searchParams.get("redirect_uri"),
      code_challenge_method: authorize.searchParams.get("code_challenge_method"),
      resource: authorize.searchParams.get("resource"),
      state: Boolean(authorize.searchParams.get("state")),
      code_challenge: Boolean(authorize.searchParams.get("code_challenge")),
    }).toEqual({
      parked: true,
      origin: server.origin,
      pathname: "/authorize",
      response_type: "code",
      client_id: "harness-public",
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      code_challenge_method: "S256",
      resource: server.mcpUrl,
      state: true,
      code_challenge: true,
    });

    const pasted = echoHost({
      ui: async () => ({ kind: "text", input: "ghp_pat" }),
    });
    await loginMcpHttp("row-1", server.mcpUrl, pasted.host);
    const rejects = {
      mismatch: await settledMessage(() =>
        loginMcpHttp(
          "row-1",
          server.mcpUrl,
          echoHost({ ui: (body) => hitCallback(body, { code: "code", state: "other" }) }).host,
        ),
      ),
      missingState: await settledMessage(() =>
        loginMcpHttp("row-1", server.mcpUrl, echoHost({ ui: (body) => hitCallback(body, { code: "code" }) }).host),
      ),
    };
    expect({
      written: pkce.written,
      pasted: pasted.written[0]?.secrets,
      rejects,
    }).toMatchObject({
      written: [
        {
          id: "row-1",
          secrets: {
            token: "mcp-access",
            client_id: "harness-public",
            token_type: expect.stringMatching(/^bearer$/i),
          },
        },
      ],
      pasted: { token: "ghp_pat" },
      rejects: {
        mismatch: expect.stringMatching(/state mismatch/),
        missingState: expect.stringMatching(/state mismatch/),
      },
    });
    expect(pkce.written[0]?.secrets).not.toHaveProperty("client_secret");

    const cleared: Array<Readonly<Record<string, string>>> = [];
    logoutMcpHttp("row-1", {
      writeSecrets: (_id, secrets) => cleared.push(secrets),
    });
    expect({ logout: cleared }).toEqual({ logout: [{}] });
  } finally {
    await server.close();
  }
});
