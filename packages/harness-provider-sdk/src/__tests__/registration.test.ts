import { isDriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { describe, expect, it } from "vitest";

import {
  flattenDrivers,
  isRegisteredDriver,
  isRegisteredProvider,
  parseProviderRegistration,
  PROVIDER_SDK_CONTRACT,
  providerBrand,
  registerProviders,
} from "../index.js";
import { TestDriverConnection } from "./test-connection.js";

const mcpStdio = {
  name: "mcp-stdio",
  description: "MCP stdio",
  abilityClaim: ["mcp"],
  multiplicity: "add-as-secondary",
  connection: TestDriverConnection,
};

const mcpHttp = {
  name: "mcp-http",
  description: "MCP Streamable HTTP",
  abilityClaim: ["mcp"],
  multiplicity: "add-as-secondary",
  connection: TestDriverConnection,
};

const mcpProvider = {
  id: "mcp",
  name: "MCP",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [mcpStdio, mcpHttp],
};

describe("registration identity", () => {
  it("keeps provider id, driver names, and the PEW connection class", () => {
    expect(isDriverConnectionClass(TestDriverConnection)).toBe(true);
    const registered = parseProviderRegistration(mcpProvider);
    expect(isRegisteredProvider(registered)).toBe(true);
    expect(registered[providerBrand.registration]).toBe(true);
    expect(registered.id).toBe("mcp");
    expect(registered.drivers.map((driver) => driver.name)).toEqual(["mcp-stdio", "mcp-http"]);
    for (const driver of registered.drivers) {
      expect(isRegisteredDriver(driver)).toBe(true);
      expect(driver.providerId).toBe("mcp");
      expect(driver.connection).toBe(TestDriverConnection);
      expect(driver.importPath).toBe(driver.name);
    }
  });

  it("rejects a row whose connection is not a PEW driver class", () => {
    class NotADriver {}
    expect(() =>
      parseProviderRegistration({
        ...mcpProvider,
        drivers: [{ ...mcpStdio, connection: NotADriver }],
      }),
    ).toThrow(/PEW driver connection class required/);
  });

  it("rejects colliding driver names inside one provider", () => {
    expect(() =>
      parseProviderRegistration({
        ...mcpProvider,
        drivers: [mcpStdio, { ...mcpHttp, name: "mcp-stdio" }],
      }),
    ).toThrow(/driver "mcp-stdio" collides/);
  });

  it("rejects colliding provider ids and driver names across a roster", () => {
    const grok = {
      id: "grok",
      name: "Grok",
      contract: PROVIDER_SDK_CONTRACT,
      drivers: [
        {
          name: "grok",
          description: "Grok subscription",
          abilityClaim: ["completion", "web-search"],
          multiplicity: "add-by-default",
          connection: TestDriverConnection,
        },
      ],
    };
    const roster = registerProviders([mcpProvider, grok]);
    expect(flattenDrivers(roster).map((driver) => driver.name)).toEqual(["mcp-stdio", "mcp-http", "grok"]);
    expect(() => registerProviders([mcpProvider, mcpProvider])).toThrow(/provider "mcp" collides/);
    expect(() =>
      registerProviders([
        mcpProvider,
        {
          id: "other",
          name: "Other",
          contract: PROVIDER_SDK_CONTRACT,
          drivers: [{ ...mcpStdio, description: "shadow" }],
        },
      ]),
    ).toThrow(/driver "mcp-stdio" collides/);
  });
});
