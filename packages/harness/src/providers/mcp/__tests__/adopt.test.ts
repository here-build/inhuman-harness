/**
 * Adopt TABLE: remainder URL vs command vs park; resource_metadata parks PKCE.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect, it } from "vitest";

import { followAuthorize } from "../../auth/__tests__/browser.js";
import { adoptMcp, parseMcpEndpoint } from "../adopt.js";

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

async function startUnauthorizedMcp(): Promise<OwnedAuth> {
  const httpServer = createServer((_req, res) => {
    send(
      res,
      401,
      {
        "content-type": "text/plain",
        "www-authenticate": "Bearer",
      },
      "unauthorized",
    );
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

it("adopt", async () => {
  const unauthorized = await startUnauthorizedMcp();
  const server = await startOwnedMcpAuth();
  try {
    const settingsParks: string[] = [];
    const settingsBags = await adoptMcp(
      { name: "sentry", settings: { url: "https://mcp.sentry.dev/mcp" } },
      async (kind, body) => {
        settingsParks.push(`${kind}:${body}`);
        return {};
      },
    );
    const commandParks: string[] = [];
    const commandBags = await adoptMcp({ name: "Add MCP", input: "npx -y airtable-mcp-server" }, async (kind, body) => {
      commandParks.push(`${kind}:${body}`);
      return {};
    });
    expect({
      parse: {
        url: parseMcpEndpoint("https://mcp.sentry.dev/mcp"),
        command: parseMcpEndpoint("npx -y airtable-mcp-server"),
      },
      remainder: {
        settings: { bags: settingsBags, parks: settingsParks },
        command: { bags: commandBags, parks: commandParks },
      },
    }).toEqual({
      parse: {
        url: {
          driver: "mcp-http",
          settings: { url: "https://mcp.sentry.dev/mcp" },
        },
        command: {
          driver: "mcp-stdio",
          settings: { command: "npx", args: ["-y", "airtable-mcp-server"] },
        },
      },
      remainder: {
        settings: {
          bags: {
            driver: "mcp-http",
            name: "sentry",
            settings: { url: "https://mcp.sentry.dev/mcp" },
            secrets: {},
          },
          parks: [],
        },
        command: {
          bags: {
            driver: "mcp-stdio",
            name: "npx",
            settings: { command: "npx", args: ["-y", "airtable-mcp-server"] },
            secrets: {},
          },
          parks: [],
        },
      },
    });

    const tokenParks: string[] = [];
    const tokenBags = await adoptMcp({ name: "Add MCP", input: unauthorized.mcpUrl }, async (_kind, body) => {
      tokenParks.push(body);
      return { input: "tok" };
    });
    expect({
      parks: tokenParks.map((body) => ({
        token: body.includes("Token"),
        oauth: body.includes("harness/open-url"),
      })),
      bags: tokenBags,
    }).toEqual({
      parks: [{ token: true, oauth: false }],
      bags: {
        driver: "mcp-http",
        name: "127.0.0.1",
        settings: { url: unauthorized.mcpUrl },
        secrets: { token: "tok" },
      },
    });

    const oauthParks: string[] = [];
    const oauthBags = await adoptMcp({ name: "Add MCP", input: server.mcpUrl }, async (_kind, body) => {
      oauthParks.push(body);
      return followAuthorize(body);
    });
    expect({
      park: {
        openUrl: oauthParks[0]?.includes("harness/open-url") ?? false,
        authorize: oauthParks[0]?.includes(`${server.origin}/authorize`) ?? false,
        redirectUri: oauthParks[0]?.includes("redirect_uri") ?? false,
      },
      driver: oauthBags.driver,
      settings: oauthBags.settings,
      token: oauthBags.secrets.token,
      client_id: oauthBags.secrets.client_id,
    }).toEqual({
      park: { openUrl: true, authorize: true, redirectUri: true },
      driver: "mcp-http",
      settings: { url: server.mcpUrl },
      token: "mcp-access",
      client_id: "harness-public",
    });

    const endpointParks: string[] = [];
    const endpointBags = await adoptMcp({ name: "Add MCP", settings: {} }, async (_kind, body) => {
      endpointParks.push(body);
      if (body.includes("MCP URL or command")) return { input: unauthorized.mcpUrl };
      return { input: "" };
    });
    expect({
      parks: endpointParks.map((body) => ({
        endpoint: body.includes("MCP URL or command"),
        token: body.includes("Token"),
      })),
      bags: endpointBags,
    }).toEqual({
      parks: [
        { endpoint: true, token: false },
        { endpoint: false, token: true },
      ],
      bags: {
        driver: "mcp-http",
        name: "127.0.0.1",
        settings: { url: unauthorized.mcpUrl },
        secrets: {},
      },
    });
  } finally {
    await unauthorized.close();
    await server.close();
  }
});

it("adopt abort during hung OAuth probe", async () => {
  let resolveHit: () => void = () => undefined;
  const hit = new Promise<void>((resolve) => {
    resolveHit = resolve;
  });
  const httpServer = createServer((_req, _res) => {
    resolveHit();
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address != null ? address.port : 0;
  const abort = new AbortController();
  try {
    const pending = adoptMcp(
      { name: "Add MCP", input: `http://127.0.0.1:${port}/mcp`, signal: abort.signal },
      async () => ({}),
    );
    await hit;
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
