/**
 * Auth kind / readyState: 401 is an auth challenge only with no static bearer.
 * HTTP without bearer is needs-auth with empty tools, not failed.
 */
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { McpHttpDriverConnection } from "../http-driver.js";
import { isMcpAuthChallenge } from "../oauth.js";

const empty = { get: () => undefined };
const token = {
  get: (field: string) => (field === "token" ? "tok" : undefined),
};
const apiKey = {
  get: (field: string) => (field === "apiKey" ? "key" : undefined),
};

it("auth kind / readyState", async () => {
  expect({
    code401: isMcpAuthChallenge({ code: 401 }, empty, {}),
    status403: isMcpAuthChallenge({ status: 403 }, empty, {}),
    unauthorized: isMcpAuthChallenge(new Error("Unauthorized"), empty, {}),
    token: isMcpAuthChallenge({ code: 401 }, token, {}),
    apiKey: isMcpAuthChallenge({ code: 401 }, apiKey, {}),
    header: isMcpAuthChallenge({ code: 401 }, empty, {
      headers: { Authorization: "Bearer x" },
    }),
    refused: isMcpAuthChallenge(new Error("ECONNREFUSED"), empty, {}),
    status500: isMcpAuthChallenge({ code: 500 }, empty, {}),
  }).toEqual({
    code401: true,
    status403: true,
    unauthorized: true,
    token: false,
    apiKey: false,
    header: false,
    refused: false,
    status500: false,
  });

  const httpServer = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain", connection: "close" }).end("unauthorized");
  });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve((httpServer.address() as { port: number }).port));
  });
  const url = `http://127.0.0.1:${port}/`;
  const challenge = new McpHttpDriverConnection("http-needs-auth", { url });
  const bearer = new McpHttpDriverConnection("http-static-bearer", { url }, { token: "tok" });
  try {
    await challenge.ensureBootstrapStarted();
    expect({
      readyState: challenge.readyState,
      auth: challenge.state.auth,
      tools: challenge.state.tools,
      client: challenge.client,
    }).toEqual({
      readyState: "ready",
      auth: "needs-auth",
      tools: [],
      client: null,
    });

    const failed = await bearer.ensureBootstrapStarted().then(
      () => "ok",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect({
      error: failed,
      readyState: bearer.readyState,
      needsAuth: bearer.state.auth === "needs-auth",
    }).toEqual({
      error: expect.stringContaining(`mcp connect ${url}`),
      readyState: "failed",
      needsAuth: false,
    });
  } finally {
    await challenge[Symbol.asyncDispose]();
    await bearer[Symbol.asyncDispose]();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
