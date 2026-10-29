import { PROVIDER_SDK_CONTRACT, registerProviders } from "@inhuman.tools/harness-provider-sdk";
import { DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import {
  adoptRegisteredDriver,
  allocateConnectionId,
  completionConnectionIds,
  loadDriverModule,
  openDriverRegistry,
  resolveAdoptClass,
} from "../index.js";
import { OtherDriverConnection, TestDriverConnection } from "./test-connection.js";

const mcpStdio = {
  name: "mcp-stdio",
  description: "MCP stdio",
  abilityClaim: ["mcp"],
  multiplicity: "add-as-secondary" as const,
  connection: TestDriverConnection,
};

const openai = {
  name: "openai-compat",
  description: "OpenAI-compatible chat completions",
  abilityClaim: ["completion"],
  multiplicity: "add-as-secondary" as const,
  connection: OtherDriverConnection,
};

const roster = registerProviders([
  {
    id: "mcp",
    name: "MCP",
    contract: PROVIDER_SDK_CONTRACT,
    drivers: [mcpStdio],
  },
  {
    id: "openai-compat",
    name: "OpenAI-compatible",
    contract: PROVIDER_SDK_CONTRACT,
    drivers: [openai],
  },
]);

describe("old caller adapters", () => {
  it("adopt, discovery filter, and execution resolve through one registry", async () => {
    const registry = openDriverRegistry(roster);
    const inventory = {
      "mcp-stdio": { importPath: "mcp-stdio" },
      "openai-compat": { importPath: "openai-compat" },
    };
    const adopted = await resolveAdoptClass(registry, "openai-compat", inventory);
    const executed = await loadDriverModule(registry, {
      name: "openai-compat",
      importPath: "openai-compat",
    });
    expect(adopted).toBe(OtherDriverConnection);
    expect(executed).toBe(adopted);
    const bags = await adoptRegisteredDriver(
      registry,
      "mcp-stdio",
      inventory,
      { name: "Mail", settings: { command: "mcp" } },
      async () => ({}),
    );
    expect(bags).toEqual({
      settings: { command: "mcp" },
      secrets: {},
    });
  });

  it("adopt unknown driver fails before a class loads", async () => {
    const registry = openDriverRegistry(roster);
    await expect(
      resolveAdoptClass(registry, "nous", {
        "mcp-stdio": { importPath: "mcp-stdio" },
      }),
    ).rejects.toThrow(/unknown driver nous/);
  });

  it("allocateConnectionId skips used ids", () => {
    expect(allocateConnectionId(new Set(), "Alpha")).toBe("alpha");
    expect(allocateConnectionId(new Set(["alpha"]), "Alpha")).toBe("alpha-2");
    expect(allocateConnectionId(new Set(["alpha", "alpha-2"]), "Alpha")).toBe("alpha-3");
  });

  it("completionConnectionIds keeps the live completion subset", () => {
    const completion = new DriverSpec({
      name: "openai-compat",
      importPath: "openai-compat",
      abilityClaim: ["completion"],
      multiplicity: "add-as-secondary",
    });
    const mcp = new DriverSpec({
      name: "mcp-stdio",
      importPath: "mcp-stdio",
      abilityClaim: ["mcp"],
      multiplicity: "add-as-secondary",
    });
    const connections = {
      alpha: { driver: completion, configuration: {} },
      mail: { driver: mcp, configuration: {} },
      off: { driver: completion, configuration: { enabled: false } },
    } as never;
    expect(completionConnectionIds(connections)).toEqual(["alpha"]);
    expect(completionConnectionIds(connections, "alpha")).toEqual(["alpha"]);
    expect(() => completionConnectionIds(connections, "mail")).toThrow(/not a completion/);
    expect(() => completionConnectionIds(connections, "nope")).toThrow(/unknown connection nope/);
  });
});
