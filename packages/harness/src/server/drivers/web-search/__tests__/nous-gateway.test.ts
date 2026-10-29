import { describe, expect, it } from "vitest";

import { FIRECRAWL_NOUS_GATEWAY_URL } from "@/providers/web/wire";

import { NousGatewayWebSearchConnection } from "../nous-gateway.js";

describe("NousGatewayWebSearchConnection", () => {
  it("is dedicated Firecrawl at the gateway origin", () => {
    const withUrl = new NousGatewayWebSearchConnection("web-nous", {
      apiUrl: FIRECRAWL_NOUS_GATEWAY_URL,
      sourceConnection: "nous-portal",
    });
    const fallback = new NousGatewayWebSearchConnection("web-nous", {});
    expect({
      vendor: withUrl.vendor,
      url: withUrl.apiUrl(),
      fallback: fallback.apiUrl(),
      adoptable: NousGatewayWebSearchConnection.offers[0]?.adoptable,
    }).toEqual({
      vendor: "firecrawl",
      url: FIRECRAWL_NOUS_GATEWAY_URL,
      fallback: FIRECRAWL_NOUS_GATEWAY_URL,
      adoptable: false,
    });
  });

  it("constructs against a borrowed OIDC secret bag", () => {
    const bag = {
      apiKey: "jwt",
      refreshToken: "rt",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const intern = new NousGatewayWebSearchConnection("web-nous", { apiUrl: FIRECRAWL_NOUS_GATEWAY_URL }, bag);
    expect(intern.apiKey()).toBe("jwt");
  });
});
