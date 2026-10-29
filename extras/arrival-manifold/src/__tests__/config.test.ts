import { describe, expect, it } from "vitest";

import { parseManifoldConfig, responseCharacterCapFromEnv, typeHintsModeFromEnv } from "../config.js";

describe("parseManifoldConfig", () => {
  it("reads stdio entries, one server per key, key order preserved", () => {
    const config = parseManifoldConfig({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@github/mcp-server"], env: { GITHUB_TOKEN: "x" } },
        slack: { command: "npx", args: ["-y", "@slack/mcp-server"] },
      },
    });
    expect(config.servers).toEqual([
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@github/mcp-server"],
        env: { GITHUB_TOKEN: "x" },
      },
      { name: "slack", transport: "stdio", command: "npx", args: ["-y", "@slack/mcp-server"] },
    ]);
  });

  it("allows a minimal stdio entry with just a command (args/env optional)", () => {
    const config = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(config.servers).toEqual([{ name: "ping", transport: "stdio", command: "ping-server" }]);
  });

  it("reads http entries, discriminated by url instead of command", () => {
    const config = parseManifoldConfig({
      mcpServers: {
        weather: { url: "https://weather.example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    expect(config.servers).toEqual([
      {
        name: "weather",
        transport: "http",
        url: "https://weather.example.com/mcp",
        headers: { Authorization: "Bearer x" },
      },
    ]);
  });

  it("allows a minimal http entry with just a url (headers optional)", () => {
    const config = parseManifoldConfig({ mcpServers: { weather: { url: "https://weather.example.com/mcp" } } });
    expect(config.servers).toEqual([{ name: "weather", transport: "http", url: "https://weather.example.com/mcp" }]);
  });

  it("allows a mix of stdio and http entries in one config", () => {
    const config = parseManifoldConfig({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@github/mcp-server"] },
        weather: { url: "https://weather.example.com/mcp" },
      },
    });
    expect(config.servers.map((s) => s.transport)).toEqual(["stdio", "http"]);
  });

  it("rejects a config with no mcpServers key", () => {
    expect(() => parseManifoldConfig({})).toThrow(/mcpServers/);
  });

  it("rejects an empty mcpServers object", () => {
    expect(() => parseManifoldConfig({ mcpServers: {} })).toThrow(/at least one/);
  });

  it("rejects a server entry with neither command nor url, naming the offending server", () => {
    expect(() => parseManifoldConfig({ mcpServers: { github: { args: ["x"] } } })).toThrow(/github/);
  });

  it("rejects a server entry with BOTH command and url (ambiguous transport)", () => {
    expect(() =>
      parseManifoldConfig({ mcpServers: { github: { command: "npx", url: "https://example.com/mcp" } } }),
    ).toThrow(/github/);
  });

  it("reads the optional evalTimeoutMs root key (H-1 budget), undefined when absent", () => {
    const withBudget = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, evalTimeoutMs: 5000 });
    expect(withBudget.evalTimeoutMs).toBe(5000);
    const without = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(without.evalTimeoutMs).toBeUndefined();
  });

  it("rejects a non-positive or fractional evalTimeoutMs", () => {
    expect(() => parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, evalTimeoutMs: 0 })).toThrow(
      /evalTimeoutMs/,
    );
    expect(() => parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, evalTimeoutMs: 1.5 })).toThrow(
      /evalTimeoutMs/,
    );
  });

  it("reads the optional catalog root key (detail knob), undefined when absent", () => {
    const withCatalog = parseManifoldConfig({
      mcpServers: { ping: { command: "ping-server" } },
      catalog: { detail: "summary", summaryText: "See in-world discovery verbs." },
    });
    expect(withCatalog.catalog).toEqual({ detail: "summary", summaryText: "See in-world discovery verbs." });
    const without = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(without.catalog).toBeUndefined();
  });

  it("rejects catalog.detail 'summary' with no summaryText", () => {
    expect(() =>
      parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, catalog: { detail: "summary" } }),
    ).toThrow(/summaryText/);
  });

  it("rejects an unrecognized catalog.detail value", () => {
    expect(() =>
      parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, catalog: { detail: "verbose" } }),
    ).toThrow(/catalog/);
  });

  it("reads the optional per-server tools allowlist, undefined when absent", () => {
    const withAllowlist = parseManifoldConfig({
      mcpServers: { github: { command: "npx", tools: ["search-issues", "get-issue"] } },
    });
    expect(withAllowlist.servers[0]?.tools).toEqual(["search-issues", "get-issue"]);
    const without = parseManifoldConfig({ mcpServers: { github: { command: "npx" } } });
    expect(without.servers[0]?.tools).toBeUndefined();
  });

  it("reads a tools allowlist on an http entry too", () => {
    const config = parseManifoldConfig({
      mcpServers: { weather: { url: "https://weather.example.com/mcp", tools: ["forecast"] } },
    });
    expect(config.servers[0]?.tools).toEqual(["forecast"]);
  });

  it("reads the optional observation root key (size budget), undefined when absent", () => {
    const withBudget = parseManifoldConfig({
      mcpServers: { ping: { command: "ping-server" } },
      observation: { maxTotalChars: 20_000 },
    });
    expect(withBudget.observation).toEqual({ maxTotalChars: 20_000 });
    const without = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(without.observation).toBeUndefined();
  });

  it("rejects a non-positive or fractional observation.maxTotalChars", () => {
    expect(() =>
      parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, observation: { maxTotalChars: 0 } }),
    ).toThrow(/observation/);
    expect(() =>
      parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, observation: { maxTotalChars: 1.5 } }),
    ).toThrow(/observation/);
  });

  it("reads the optional promptFields root key (opt-in intent/successCriteria), undefined when absent", () => {
    const withBoth = parseManifoldConfig({
      mcpServers: { ping: { command: "ping-server" } },
      promptFields: { intent: true, successCriteria: true },
    });
    expect(withBoth.promptFields).toEqual({ intent: true, successCriteria: true });
    const withOne = parseManifoldConfig({
      mcpServers: { ping: { command: "ping-server" } },
      promptFields: { intent: true },
    });
    expect(withOne.promptFields).toEqual({ intent: true });
    const without = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(without.promptFields).toBeUndefined();
  });

  it("rejects a non-boolean promptFields sub-key", () => {
    expect(() =>
      parseManifoldConfig({
        mcpServers: { ping: { command: "ping-server" } },
        promptFields: { intent: "yes" },
      }),
    ).toThrow(/promptFields/);
  });

  it("reads the optional typeHints kill switch, defaulting to 'telemetry' when absent (doc §6/G9)", () => {
    const explicit = parseManifoldConfig({
      mcpServers: { ping: { command: "ping-server" } },
      typeHints: "on-error",
    });
    expect(explicit.typeHints).toBe("on-error");
    const off = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, typeHints: "off" });
    expect(off.typeHints).toBe("off");
    const absent = parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } } });
    expect(absent.typeHints).toBe("telemetry");
  });

  it("rejects an unrecognized typeHints value", () => {
    expect(() =>
      parseManifoldConfig({ mcpServers: { ping: { command: "ping-server" } }, typeHints: "verbose" }),
    ).toThrow(/typeHints/);
  });

  it("MANIFOLD_TYPE_HINTS env override: valid values pass, unset/empty means no override, junk is a loud error", () => {
    expect(typeHintsModeFromEnv("off")).toBe("off");
    expect(typeHintsModeFromEnv("telemetry")).toBe("telemetry");
    expect(typeHintsModeFromEnv("on-error")).toBe("on-error");
    expect(typeHintsModeFromEnv(undefined)).toBeUndefined();
    expect(typeHintsModeFromEnv("")).toBeUndefined();
    expect(() => typeHintsModeFromEnv("verbose")).toThrow(/MANIFOLD_TYPE_HINTS/);
  });

  it("ARRIVAL_RESPONSE_CHARACTER_CAP env override: a positive integer passes, unset/empty means no override, junk is a loud error", () => {
    expect(responseCharacterCapFromEnv("8000")).toBe(8000);
    expect(responseCharacterCapFromEnv(undefined)).toBeUndefined();
    expect(responseCharacterCapFromEnv("")).toBeUndefined();
    expect(() => responseCharacterCapFromEnv("0")).toThrow(/ARRIVAL_RESPONSE_CHARACTER_CAP/);
    expect(() => responseCharacterCapFromEnv("-5")).toThrow(/ARRIVAL_RESPONSE_CHARACTER_CAP/);
    expect(() => responseCharacterCapFromEnv("1.5")).toThrow(/ARRIVAL_RESPONSE_CHARACTER_CAP/);
    expect(() => responseCharacterCapFromEnv("not-a-number")).toThrow(/ARRIVAL_RESPONSE_CHARACTER_CAP/);
  });
});
