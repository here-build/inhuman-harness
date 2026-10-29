import { expect, test } from "vitest";

import { listenOAuthLoopback, oauthCallbackFor, withCallbackParam } from "../loopback.js";

test("OAuth loopback: settle on code, ignore icons, deny on error", async () => {
  let settle: { icon: number; empty: number; settled: unknown; hit: number };
  const loopback = await listenOAuthLoopback();
  try {
    const origin = new URL(loopback.callbackUrl).origin;
    const icon = await fetch(`${origin}/apple-touch-icon.png`);
    const empty = await fetch(loopback.callbackUrl);
    const hitting = fetch(`${loopback.callbackUrl}?code=or-auth-code&state=s1`);
    const settled = await loopback.wait;
    const hit = await hitting;
    settle = { icon: icon.status, empty: empty.status, settled, hit: hit.status };
  } finally {
    loopback.close();
  }

  let deny: { reason: string | null; status: number };
  const denied = await listenOAuthLoopback();
  try {
    const hitting = fetch(`${denied.callbackUrl}?error=access_denied`);
    const deniedReason = await denied.wait.then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const hit = await hitting;
    deny = { reason: deniedReason, status: hit.status };
  } finally {
    denied.close();
  }

  let listen: { callbackUrl: string; settled: unknown };
  const explicit = await listenOAuthLoopback({ host: "127.0.0.1", port: 0, path: "/auth/callback" });
  try {
    const hitting = fetch(`${explicit.callbackUrl}?code=codex-code`);
    const settled = await explicit.wait;
    await hitting;
    listen = { callbackUrl: explicit.callbackUrl, settled };
  } finally {
    explicit.close();
  }

  expect({ settle, deny, listen }).toEqual({
    settle: { icon: 204, empty: 204, settled: { code: "or-auth-code", state: "s1" }, hit: 200 },
    deny: { reason: expect.stringContaining("access_denied"), status: 200 },
    listen: {
      callbackUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/),
      settled: { code: "codex-code", state: "" },
    },
  });
});

test("OAuth callback dialect and callback injection", () => {
  const injected = new URL(
    withCallbackParam("https://openrouter.ai/auth?code_challenge=abc", "http://127.0.0.1:9/callback", "callback_url"),
  );
  const grokRedirect = new URL(
    withCallbackParam("https://auth.x.ai/oauth2/authorize?client_id=x", "http://127.0.0.1:9/callback", "redirect_uri"),
  );
  expect({
    dialects: [
      oauthCallbackFor("https://openrouter.ai/auth?code_challenge=abc"),
      oauthCallbackFor("https://auth.x.ai/oauth2/authorize?client_id=x"),
      oauthCallbackFor("https://auth.openai.com/oauth/authorize?client_id=x"),
    ],
    openrouter: {
      callback_url: injected.searchParams.get("callback_url"),
      code_challenge: injected.searchParams.get("code_challenge"),
    },
    grok: {
      redirect_uri: grokRedirect.searchParams.has("redirect_uri"),
      callback_url: grokRedirect.searchParams.get("callback_url"),
    },
  }).toEqual({
    dialects: [
      { param: "callback_url", listen: { host: "127.0.0.1", port: 0, path: "/callback" } },
      { param: "redirect_uri", listen: { host: "127.0.0.1", port: 0, path: "/callback" } },
      { param: "redirect_uri", listen: { host: "localhost", port: 1455, path: "/auth/callback" } },
    ],
    openrouter: { callback_url: "http://127.0.0.1:9/callback", code_challenge: "abc" },
    grok: { redirect_uri: true, callback_url: null },
  });
});
