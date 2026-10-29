import { afterEach, describe, expect, it } from "vitest";

import { NOUS_BASE_URL, NOUS_CLIENT_ID, NOUS_DEVICE_CODE_URL, NOUS_TOKEN_URL } from "../auth.js";
import { NousDriverConnection } from "../driver.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NousDriverConnection", () => {
  it("keeps the existing inference offer and label", () => {
    expect({
      label: NousDriverConnection.configurationLabel,
      driver: NousDriverConnection.oidcProfile.driver,
      baseUrl: NousDriverConnection.offers[0]?.settings,
      adoptable: NousDriverConnection.offers[0]?.adoptable,
    }).toEqual({
      label: "nous",
      driver: "nous",
      baseUrl: { baseUrl: NOUS_BASE_URL },
      adoptable: true,
    });
  });

  it("adopts through Hermes device-code then stores tokens", async () => {
    const opened: string[] = [];
    globalThis.fetch = (async (url: string) => {
      if (String(url) === NOUS_DEVICE_CODE_URL) {
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
      }
      expect(String(url)).toBe(NOUS_TOKEN_URL);
      return new Response(
        JSON.stringify({
          access_token: "nous-at",
          refresh_token: "nous-rt",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const bags = await NousDriverConnection.adopt({}, async (kind, body) => {
      expect(kind).toBe("UI");
      opened.push(body);
      return {};
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("user_code=ABCD-EFGH");
    expect(bags).toMatchObject({
      name: "Nous Portal",
      settings: { baseUrl: NOUS_BASE_URL },
      secrets: { apiKey: "nous-at", refreshToken: "nous-rt" },
    });
    expect(NOUS_CLIENT_ID).toBe("hermes-cli");
  });
});
