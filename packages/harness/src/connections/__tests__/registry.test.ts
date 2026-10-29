import { PROVIDER_SDK_CONTRACT, registerProviders } from "@inhuman.tools/harness-provider-sdk";
import { DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import {
  applyRegistryToDrivers,
  connectionsBrand,
  DriverRegistry,
  isDriverRegistry,
  openDriverRegistry,
} from "../index.js";
import { OtherDriverConnection, TestDriverConnection } from "./test-connection.js";

const mcpStdio = {
  name: "mcp-stdio",
  description: "MCP stdio",
  abilityClaim: ["mcp"],
  multiplicity: "add-as-secondary" as const,
  connection: TestDriverConnection,
};

const mcpHttp = {
  name: "mcp-http",
  description: "MCP Streamable HTTP",
  abilityClaim: ["mcp"],
  multiplicity: "add-as-secondary" as const,
  connection: TestDriverConnection,
};

const mcpProvider = {
  id: "mcp",
  name: "MCP",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [mcpStdio, mcpHttp],
};

describe("driver registry", () => {
  it("opens from registered providers and resolves the PEW class", async () => {
    const registry = openDriverRegistry(registerProviders([mcpProvider]));
    expect(isDriverRegistry(registry)).toBe(true);
    expect(registry[connectionsBrand.registry]).toBe(true);
    expect(registry.list().map((driver) => driver.name)).toEqual(["mcp-stdio", "mcp-http"]);
    expect(await registry.resolve({ name: "mcp-stdio", importPath: "mcp-stdio" })).toBe(TestDriverConnection);
    expect(registry.connectionClass("mcp-http")).toBe(TestDriverConnection);
  });

  it("rejects duplicate driver names before any class is used", () => {
    const drivers = registerProviders([mcpProvider])[0]!.drivers;
    expect(() => DriverRegistry.fromDrivers([...drivers, ...drivers])).toThrow(/driver "mcp-stdio" collides/);
  });

  it("rejects an incompatible descriptor before resolve returns a class", async () => {
    const registry = openDriverRegistry(registerProviders([mcpProvider]));
    await expect(
      registry.resolve({
        name: "mcp-stdio",
        importPath: "other-path",
      }),
    ).rejects.toThrow(/descriptor is incompatible/);
    await expect(
      registry.resolve({
        name: "mcp-stdio",
        importPath: "mcp-stdio",
        abilityClaim: ["completion"],
      }),
    ).rejects.toThrow(/descriptor is incompatible/);
  });

  it("loads an unregistered importPath through the injected door", async () => {
    const registry = openDriverRegistry(registerProviders([mcpProvider]));
    const loaded = await registry.resolve(
      { name: "external", importPath: "external-driver" },
      { loadExternal: async () => TestDriverConnection },
    );
    expect(loaded).toBe(TestDriverConnection);
  });

  it("projects inventory without touching process facts", () => {
    const registry = openDriverRegistry(registerProviders([mcpProvider]));
    const drivers: Record<string, DriverSpec | undefined> = {};
    applyRegistryToDrivers(registry, drivers);
    expect(drivers["mcp-stdio"]?.readyState).toBe(null);
    expect(drivers["mcp-stdio"]?.abilityClaim).toEqual(["mcp"]);
    expect(drivers["mcp-http"]?.importPath).toBe("mcp-http");
  });

  it("opens mixed providers without importing vendors", async () => {
    const registry = openDriverRegistry(
      registerProviders([
        mcpProvider,
        {
          id: "grok",
          name: "Grok subscription",
          contract: PROVIDER_SDK_CONTRACT,
          drivers: [
            {
              name: "grok",
              description: "Grok subscription",
              abilityClaim: ["completion", "web-search"],
              multiplicity: "add-by-default" as const,
              connection: OtherDriverConnection,
            },
          ],
        },
      ]),
    );
    expect(await registry.resolve({ name: "grok", importPath: "grok" })).toBe(OtherDriverConnection);
    expect(
      await registry.resolve({
        name: "mcp-stdio",
        importPath: "mcp-stdio",
        abilityClaim: ["mcp"],
      }),
    ).toBe(TestDriverConnection);
  });
});
