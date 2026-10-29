import { afterEach, describe, expect, it } from "vitest";

import { hitCallback, parkedUrl } from "../../auth/__tests__/browser.js";
import { OpenRouterDriverConnection } from "../connection.js";

const originalFetch = globalThis.fetch;
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenRouter PKCE auth", () => {
  it("adopt parks S256 with the daemon callback, pastes sk-, and exchanges a code", async () => {
    let parked: URL | undefined;
    const pasted = await OpenRouterDriverConnection.adopt({ name: "OpenRouter" }, async (_kind, body) => {
      parked = parkedUrl(body);
      return { kind: "text", input: "sk-or-pasted" };
    });
    if (parked === undefined) throw new Error("adopt parked no url");
    expect({
      origin: parked.origin,
      path: parked.pathname,
      method: parked.searchParams.get("code_challenge_method"),
      label: parked.searchParams.get("key_label"),
      callback: parked.searchParams.get("callback_url"),
      redirect: parked.searchParams.get("redirect_uri"),
      challengeLen: parked.searchParams.get("code_challenge")?.length,
    }).toEqual({
      origin: "https://openrouter.ai",
      path: "/auth",
      method: "S256",
      label: "Harness",
      callback: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      redirect: null,
      challengeLen: 43,
    });
    expect(pasted).toEqual({
      name: "OpenRouter",
      settings: { baseUrl: "https://openrouter.ai/api/v1" },
      secrets: { apiKey: "sk-or-pasted" },
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(KEYS_URL);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        code?: string;
        code_verifier?: string;
        code_challenge_method?: string;
      };
      expect(body).toEqual({
        code: "or-auth-code",
        code_verifier: expect.any(String),
        code_challenge_method: "S256",
      });
      expect((body.code_verifier ?? "").length).toBeGreaterThan(0);
      return new Response(JSON.stringify({ key: "sk-or-exchanged" }), {
        status: 200,
      });
    }) as typeof fetch;

    const exchanged = await OpenRouterDriverConnection.adopt({}, async (_kind, body) => {
      expect(body).toContain("Authorize OpenRouter in the browser");
      expect(body).toContain("https://openrouter.ai/auth?");
      // The browser lands on the daemon's callback, then the client answers `opened`.
      return hitCallback(body, { code: "or-auth-code" }, originalFetch);
    });
    expect(exchanged.secrets.apiKey).toBe("sk-or-exchanged");
    expect(exchanged.settings.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(exchanged.name).toBe("OpenRouter");

    const typed = await OpenRouterDriverConnection.adopt({}, async () => ({ kind: "text", input: "or-auth-code" }));
    expect(typed.secrets.apiKey).toBe("sk-or-exchanged");
  });

  it("wraps a failed key-exchange fetch", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      OpenRouterDriverConnection.adopt({}, async () => ({
        input: "or-auth-code",
      })),
    ).rejects.toThrow(/openrouter key exchange/i);
  });
});
