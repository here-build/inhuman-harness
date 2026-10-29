import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import { FIRECRAWL_NOUS_GATEWAY_URL } from "@/providers/web/wire";

import { NOUS_GATEWAY_CONNECTION_ID, NOUS_GATEWAY_DRIVER_NAME } from "../ids.js";
import {
  nousGatewaySourceOf,
  projectNousGatewayConnection,
  secretsConnectionId,
  sourceNousConnectionId,
} from "../source.js";

function named(can: readonly string[], name: string, configuration: Record<string, unknown> = {}) {
  return { driver: { can, name }, configuration };
}

describe("projectNousGatewayConnection", () => {
  it("projects intern from a live nous row and drops it when nous is gone or disabled", () => {
    const driver = new DriverSpec();
    driver.abilityClaim = ["web-search", "web-extract"];
    driver.name = NOUS_GATEWAY_DRIVER_NAME;
    const kernel = {
      drivers: { [NOUS_GATEWAY_DRIVER_NAME]: driver },
      connections: {
        "nous-portal": named(["completion"], "nous"),
      } as Record<string, ConnectionSpec | ReturnType<typeof named>>,
    };
    expect(sourceNousConnectionId(kernel)).toBe("nous-portal");
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toMatchObject({
      name: "nous-gateway",
      configuration: {
        apiUrl: FIRECRAWL_NOUS_GATEWAY_URL,
        sourceConnection: "nous-portal",
      },
    });
    expect(nousGatewaySourceOf(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-portal");
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-portal");
    expect(secretsConnectionId(kernel, "nous-portal")).toBe("nous-portal");

    kernel.connections["nous-portal"] = named(["completion"], "nous", {
      enabled: false,
    });
    expect(sourceNousConnectionId(kernel)).toBeNull();
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toBeUndefined();
  });

  it("source A→B rebinds secrets; disabled A cannot retain A; no source falls back to intern id", () => {
    const driver = new DriverSpec();
    driver.abilityClaim = ["web-search", "web-extract"];
    driver.name = NOUS_GATEWAY_DRIVER_NAME;
    const kernel = {
      drivers: { [NOUS_GATEWAY_DRIVER_NAME]: driver },
      connections: {
        "nous-a": named(["completion"], "nous"),
        "nous-b": named(["completion"], "nous"),
      } as Record<string, ConnectionSpec | ReturnType<typeof named>>,
    };
    projectNousGatewayConnection(kernel);
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-a");

    kernel.connections["nous-a"] = named(["completion"], "nous", {
      enabled: false,
    });
    projectNousGatewayConnection(kernel);
    expect(nousGatewaySourceOf(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-b");
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-b");
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toMatchObject({
      configuration: { sourceConnection: "nous-b" },
    });

    kernel.connections["nous-b"] = named(["completion"], "nous", {
      enabled: false,
    });
    expect(sourceNousConnectionId(kernel)).toBeNull();
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toBeUndefined();
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe(NOUS_GATEWAY_CONNECTION_ID);
  });
});
