import { afterEach, describe, expect, it, vi } from "vitest";

import { DEVICE_CODE_GRANT as NOUS_DEVICE_GRANT } from "@/providers/auth";

import {
  NOUS_CLIENT_ID,
  NOUS_DEVICE_CODE_URL,
  NOUS_SCOPE,
  NOUS_TOKEN_URL,
  pollNousDeviceToken,
  requestNousDeviceCode,
} from "../auth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("nous device-code oauth", () => {
  it("requests a device code with the Hermes CLI client", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(NOUS_DEVICE_CODE_URL);
      const body = new URLSearchParams(String(init?.body));
      expect({
        method: init?.method,
        client: body.get("client_id"),
        scope: body.get("scope"),
      }).toEqual({
        method: "POST",
        client: NOUS_CLIENT_ID,
        scope: NOUS_SCOPE,
      });
      return new Response(
        JSON.stringify({
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://portal.nousresearch.com/manage-subscription",
          expires_in: 600,
          interval: 5,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await expect(requestNousDeviceCode()).resolves.toEqual({
      deviceCode: "dev-1",
      verificationUriComplete: "https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH",
      expiresInSec: 600,
      intervalSec: 5,
    });
  });

  it("polls through authorization_pending then stores tokens", async () => {
    vi.useFakeTimers();
    let polls = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe(NOUS_TOKEN_URL);
      const body = new URLSearchParams(String(init?.body));
      expect({
        grant: body.get("grant_type"),
        device: body.get("device_code"),
        client: body.get("client_id"),
      }).toEqual({
        grant: NOUS_DEVICE_GRANT,
        device: "dev-1",
        client: NOUS_CLIENT_ID,
      });
      polls += 1;
      if (polls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: "nous-at",
          refresh_token: "nous-rt",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const pending = pollNousDeviceToken({
      deviceCode: "dev-1",
      verificationUriComplete: "https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH",
      expiresInSec: 600,
      intervalSec: 5,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({
      apiKey: "nous-at",
      refreshToken: "nous-rt",
    });
    expect(polls).toBe(2);
  });
});
