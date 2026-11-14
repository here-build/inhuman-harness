import { describe, expect, it } from "vitest";

import { duplicateConnectionOf } from "../connection-rpc.js";

const http = (url: string, secrets: Record<string, string> = {}) => ({
  driver: "mcp-http",
  settings: { url },
  secrets,
});

describe("duplicateConnectionOf", () => {
  it("rejects the same endpoint with the same token", () => {
    expect(
      duplicateConnectionOf(http("https://a.dev/mcp", { token: "t" }), {
        a: http("https://a.dev/mcp/", { token: "t" }),
      }),
    ).toBe("a");
  });

  it("rejects the same endpoint when both tokens are empty", () => {
    expect(duplicateConnectionOf(http("https://a.dev/mcp"), { a: http("https://a.dev/mcp") })).toBe("a");
  });

  it("allows a different token, endpoint, or driver", () => {
    const stored = { a: http("https://a.dev/mcp", { token: "t" }) };
    expect(duplicateConnectionOf(http("https://a.dev/mcp", { token: "u" }), stored)).toBeNull();
    expect(duplicateConnectionOf(http("https://a.dev/mcp"), stored)).toBeNull();
    expect(duplicateConnectionOf(http("https://b.dev/mcp", { token: "t" }), stored)).toBeNull();
    expect(
      duplicateConnectionOf({ ...http("https://a.dev/mcp", { token: "t" }), driver: "openai-compat" }, stored),
    ).toBeNull();
  });

  it("allows several OIDC sign-ins to one provider", () => {
    const oidc = { driver: "chatgpt", settings: {}, secrets: { apiKey: "x", refreshToken: "r1" } };
    expect(duplicateConnectionOf({ ...oidc, secrets: { apiKey: "x", refreshToken: "r2" } }, { a: oidc })).toBeNull();
  });

  it("matches stdio by command and args", () => {
    const stdio = (args: string[]) => ({ driver: "mcp-stdio", settings: { command: "npx", args }, secrets: {} });
    expect(duplicateConnectionOf(stdio(["srv"]), { a: stdio(["srv"]) })).toBe("a");
    expect(duplicateConnectionOf(stdio(["other"]), { a: stdio(["srv"]) })).toBeNull();
  });
});
