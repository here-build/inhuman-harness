import {
  CompletionExpectation,
  McpToolExpectation,
  WebExtractExpectation,
  WebSearchExpectation,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  admitCapability,
  CAPABILITY_EXPECTATION,
  CAPABILITY_KINDS,
  CAPABILITY_METHOD,
  connectionSupports,
  isCapabilityKind,
  parseCapabilityKind,
  parseCapabilityRequest,
  type CapabilityConnection,
} from "../index.js";

describe("capability shape", () => {
  it("names the shipped PEW/model kinds and no others", () => {
    expect(CAPABILITY_KINDS).toEqual(["completion", "mcp", "web-search", "web-extract"]);
    expect(CAPABILITY_EXPECTATION).toEqual({
      completion: CompletionExpectation.modelName,
      mcp: McpToolExpectation.modelName,
      "web-search": WebSearchExpectation.modelName,
      "web-extract": WebExtractExpectation.modelName,
    });
    expect(isCapabilityKind("completion")).toBe(true);
    expect(isCapabilityKind("telepathy")).toBe(false);
    expect(parseCapabilityKind("mcp")).toBe("mcp");
    expect(() => parseCapabilityKind("telepathy")).toThrow(/Invalid option|Invalid enum|expected one of/i);
  });

  it("admits from DriverSpec.can tokens, not vendor classes", () => {
    expect(admitCapability(["completion", "web-search"], "completion")).toBe(true);
    expect(admitCapability(["completion"], "mcp")).toBe(false);
    expect(CAPABILITY_METHOD.completion).toBe("complete");
    expect(CAPABILITY_METHOD.mcp).toBe("callTool");
  });

  it("parses a completion request against a real CompletionExpectation", () => {
    const round = new CompletionExpectation({ connectionId: "wire-1" });
    const parsed = parseCapabilityRequest({
      kind: "completion",
      request: { connectionId: "wire-1", model: "test-model", round },
    });
    expect(parsed.kind).toBe("completion");
    if (parsed.kind !== "completion") throw new Error("narrow");
    expect(parsed.request.round).toBe(round);
    expect(parsed.request.model).toBe("test-model");
  });

  it("rejects a completion request without a model round", () => {
    expect(() =>
      parseCapabilityRequest({
        kind: "completion",
        request: {
          connectionId: "wire-1",
          model: "test-model",
          round: { connectionId: "wire-1" },
        },
      }),
    ).toThrow(/completion round required/);
  });

  it("parses mcp, web-search, and web-extract envelopes", () => {
    expect(
      parseCapabilityRequest({
        kind: "mcp",
        request: {
          connectionId: "mcp-1",
          serverToolName: "list",
          args: { q: 1 },
        },
      }),
    ).toMatchObject({
      kind: "mcp",
      request: {
        connectionId: "mcp-1",
        serverToolName: "list",
        args: { q: 1 },
      },
    });
    expect(
      parseCapabilityRequest({
        kind: "web-search",
        request: { connectionId: "web-1", query: "site:example", limit: 3 },
      }),
    ).toMatchObject({
      kind: "web-search",
      request: { query: "site:example", limit: 3 },
    });
    expect(
      parseCapabilityRequest({
        kind: "web-extract",
        request: { connectionId: "web-1", url: "https://example.com" },
      }),
    ).toMatchObject({
      kind: "web-extract",
      request: { url: "https://example.com" },
    });
  });

  it("rejects an unknown capability kind", () => {
    expect(() => parseCapabilityRequest({ kind: "telepathy", request: {} })).toThrow();
  });

  it("duck-types interned capability methods without instanceof a vendor class", () => {
    const connection: CapabilityConnection = {
      connectionId: "wire-1",
      complete: async () => ({ text: "ok" }),
    };
    expect(connectionSupports(connection, "completion")).toBe(true);
    expect(connectionSupports(connection, "mcp")).toBe(false);
    expect(connectionSupports(connection, "web-search")).toBe(false);
  });
});
