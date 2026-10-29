import { PROVIDER_SDK_CONTRACT, registerProviders } from "@inhuman.tools/harness-provider-sdk";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { acquireConnection, dropConnection } from "@inhuman.tools/plexus-expectations/executor";
import { describe, expect, it } from "vitest";

import {
  requireFreeConnectionId,
  ensureRegisteredConnection,
  internForDiscovery,
  internForExecution,
  memoryCredentialsStore,
  openDriverRegistry,
  secretsView,
} from "../index.js";
import { TestDriverConnection } from "./test-connection.js";

const provider = {
  id: "mcp",
  name: "MCP",
  contract: PROVIDER_SDK_CONTRACT,
  drivers: [
    {
      name: "mcp-stdio",
      description: "MCP stdio",
      abilityClaim: ["mcp"],
      multiplicity: "add-as-secondary" as const,
      connection: TestDriverConnection,
    },
  ],
};

function kernelWith(id: string, driverName = "mcp-stdio") {
  const driver = new DriverSpec({
    name: driverName,
    description: "MCP stdio",
    importPath: driverName,
    abilityClaim: ["mcp"],
    multiplicity: "add-as-secondary",
  });
  const spec = new ConnectionSpec({ driver, name: id });
  return { connections: { [id]: spec } };
}

describe("PEW intern adapter", () => {
  it("discovery and two session owners share one interned connection", async () => {
    const registry = openDriverRegistry(registerProviders([provider]));
    const kernel = kernelWith("row");
    const store = memoryCredentialsStore();
    const discovery = {};
    const sessionA = {};
    const sessionB = {};
    const first = await internForDiscovery(registry, kernel, discovery, "row", {
      secrets: store,
    });
    const second = await internForExecution(registry, kernel, sessionA, "row", {
      secrets: store,
    });
    const third = await internForExecution(registry, kernel, sessionB, "row", {
      secrets: store,
    });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first).toBeInstanceOf(TestDriverConnection);
    expect(first.readyState).toBe("ready");
  });

  it("does not construct a second cache: drop remints through PEW", async () => {
    const kernel = kernelWith("row");
    const minted: TestDriverConnection[] = [];
    const construct = () => {
      const instance = new TestDriverConnection("row", {}, { get: () => undefined });
      minted.push(instance);
      return instance;
    };
    const first = await acquireConnection(kernel, {}, "row", construct);
    const shared = await acquireConnection(kernel, {}, "row", construct);
    expect(shared).toBe(first);
    expect(minted).toHaveLength(1);
    await dropConnection(kernel, "row");
    const reminted = await acquireConnection(kernel, {}, "row", construct);
    expect(reminted).not.toBe(first);
    expect(minted).toHaveLength(2);
  });

  it("duplicate connection ids fail before construct", async () => {
    const kernel = kernelWith("row");
    let constructed = 0;
    expect(() => requireFreeConnectionId(kernel, "row")).toThrow(/connection "row" collides/);
    expect(() => requireFreeConnectionId(kernel, "fresh")).not.toThrow();
    await acquireConnection(kernel, {}, "row", () => {
      constructed += 1;
      return new TestDriverConnection("row", {}, { get: () => undefined });
    });
    expect(constructed).toBe(1);
    expect(() => requireFreeConnectionId(kernel, "row")).toThrow(/connection "row" collides/);
    expect(constructed).toBe(1);
  });

  it("incompatible descriptor fails before the connection is interned", async () => {
    const registry = openDriverRegistry(registerProviders([provider]));
    const kernel = kernelWith("row", "mcp-stdio");
    kernel.connections.row!.driver.importPath = "other-path";
    await expect(
      ensureRegisteredConnection(registry, kernel, {}, "row", {
        secrets: secretsView(memoryCredentialsStore(), "row"),
      }),
    ).rejects.toThrow(/descriptor is incompatible/);
    await expect(
      internForDiscovery(registry, kernel, {}, "row", {
        secrets: memoryCredentialsStore(),
      }),
    ).rejects.toThrow(/descriptor is incompatible/);
  });
});
