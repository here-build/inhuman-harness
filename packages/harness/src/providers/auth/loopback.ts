/**
 * Localhost OAuth callback for PKCE. The daemon owns it ({@link authorizeInBrowser}
 * starts one per sign-in); no client hosts a listener.
 *
 * Only the configured path with `code` or `error` settles. Browsers request
 * icons and other paths in parallel; those must not abort the waiter —
 * otherwise the HTML says Connected while the parked RPC never gets `ui/resolve`.
 *
 * OpenRouter takes `callback_url` on a random 127.0.0.1 port. OIDC (Grok,
 * ChatGPT) takes `redirect_uri`. ChatGPT's public client is registered at
 * localhost:1455/auth/callback.
 * BIND_ADVERTISE: listen on 127.0.0.1 while advertising localhost —
 * Node IPv6 `localhost` bind would miss the public client.
 */
import { createServer } from "node:http";

import { fail, step } from "@inhuman.tools/harness-diagnostics";

export type OAuthLoopbackListen = {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
};

/** Injectable listen. `typeof listenOAuthLoopback` makes `opts` optional because of `= {}`. */
export type ListenOAuthLoopback = (opts: OAuthLoopbackListen) => Promise<OAuthLoopback>;

export type OAuthCallback = {
  readonly code: string;
  readonly state: string;
};

export type OAuthLoopback = {
  readonly callbackUrl: string;
  readonly wait: Promise<OAuthCallback>;
  close(): void;
};

export type OAuthCallbackStyle = {
  readonly param: "callback_url" | "redirect_uri";
  readonly listen: Required<OAuthLoopbackListen>;
};

const DEFAULT_LISTEN: Required<OAuthLoopbackListen> = {
  host: "127.0.0.1",
  port: 0,
  path: "/callback",
};

export function oauthCallbackFor(authUrl: string): OAuthCallbackStyle {
  let host: string;
  try {
    host = new URL(authUrl).host;
  } catch {
    host = "";
  }
  if (host === "openrouter.ai" || host === "www.openrouter.ai") {
    return { param: "callback_url", listen: { ...DEFAULT_LISTEN } };
  }
  if (host === "auth.openai.com") {
    return {
      param: "redirect_uri",
      listen: { host: "localhost", port: 1455, path: "/auth/callback" },
    };
  }
  return { param: "redirect_uri", listen: { ...DEFAULT_LISTEN } };
}

export function withCallbackParam(
  authUrl: string,
  callbackUrl: string,
  param: "callback_url" | "redirect_uri",
): string {
  const url = new URL(authUrl);
  url.searchParams.set(param, callbackUrl);
  return url.toString();
}

export async function listenOAuthLoopback(opts: OAuthLoopbackListen = {}): Promise<OAuthLoopback> {
  const host = opts.host ?? DEFAULT_LISTEN.host;
  const port = opts.port ?? DEFAULT_LISTEN.port;
  const path = opts.path ?? DEFAULT_LISTEN.path;
  const server = createServer();
  const wait = new Promise<OAuthCallback>((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | null, callback?: OAuthCallback): void => {
      if (settled) return;
      settled = true;
      if (error === null) {
        resolve(callback ?? { code: "", state: "" });
      } else {
        reject(error);
      }
      server.close();
    };
    server.on("request", (req, res) => {
      let parsed: URL;
      try {
        parsed = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (parsed.pathname !== path) {
        res.writeHead(204).end();
        return;
      }
      const code = parsed.searchParams.get("code")?.trim() ?? "";
      const state = parsed.searchParams.get("state")?.trim() ?? "";
      const error = parsed.searchParams.get("error")?.trim() ?? "";
      if (code !== "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><p>Connected. You can close this window.</p>");
        step(`oauth loopback code=${code.length} state=${state.length}`);
        settle(null, { code, state });
        return;
      }
      if (error !== "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><p>Authorization did not complete. You can close this window.</p>");
        fail("oauth loopback", error);
        settle(new Error(error));
        return;
      }
      step(`oauth loopback ignore ${parsed.pathname}`);
      res.writeHead(204).end();
    });
    server.on("error", (error) => {
      fail("oauth loopback server", error);
      settle(error);
    });
  });

  // A failed listen rejects `wait` too; nobody awaits it yet and the daemon must not die on it.
  wait.catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host === "localhost" ? "127.0.0.1" : host, () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("oauth loopback: no address");
  }
  const advertisedHost = host === "localhost" ? "localhost" : "127.0.0.1";
  return {
    callbackUrl: `http://${advertisedHost}:${address.port}${path}`,
    wait,
    close: () => {
      server.close();
    },
  };
}
