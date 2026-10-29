import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import {
  nousGatewaySourceOf,
  projectNousGatewayConnection,
  secretsConnectionId,
  sourceNousConnectionId,
  NOUS_GATEWAY_CONNECTION_ID,
  NOUS_GATEWAY_DRIVER_NAME,
} from "@/providers/nous";
import { FIRECRAWL_NOUS_GATEWAY_URL, WEB_EXTRACT_CAN, WEB_SEARCH_CAN } from "@/providers/web/wire";

import { pickWebExtractConnection, pickWebSearchConnection, projectKeylessConnection } from "../pick.js";
import { KEYLESS_CONNECTION_ID, WEB_EXTRACT_PIN_KV, WEB_SEARCH_PIN_KV } from "../types.js";

function spec(can: readonly string[]) {
  return new ConnectionSpec({ driver: new DriverSpec({ abilityClaim: can }) });
}

function face(can: readonly string[]) {
  return { driver: { abilityClaim: can } };
}

describe("pickWebSearchConnection", () => {
  it.each([
    {
      name: "pin wins; dedicated keyed beats keyless; grok does not auto-win",
      run: () => {
        const kernel = {
          kvs: {} as Record<string, string>,
          drivers: {} as Record<string, DriverSpec>,
          connections: {
            [KEYLESS_CONNECTION_ID]: spec([WEB_SEARCH_CAN]),
            exa: spec([WEB_SEARCH_CAN]),
            grok: spec(["completion", WEB_SEARCH_CAN]),
          },
        };
        const auto = pickWebSearchConnection(kernel);
        kernel.kvs[WEB_SEARCH_PIN_KV] = "grok";
        const pinned = pickWebSearchConnection(kernel);
        kernel.kvs[WEB_SEARCH_PIN_KV] = "";
        // @ts-expect-error delete occupancy from a closed inferred key
        delete kernel.connections.exa;
        const fallback = pickWebSearchConnection(kernel);
        return { auto, pinned, fallback };
      },
      want: { auto: "exa", pinned: "grok", fallback: KEYLESS_CONNECTION_ID },
    },
    {
      name: "extract pin is independent of search pin; grok cannot honor extract",
      run: () => {
        const kernel = {
          kvs: {} as Record<string, string>,
          drivers: {} as Record<string, DriverSpec>,
          connections: {
            [KEYLESS_CONNECTION_ID]: spec([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
            tavily: spec([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
            grok: spec(["completion", WEB_SEARCH_CAN]),
          },
        };
        const auto = pickWebExtractConnection(kernel);
        kernel.kvs[WEB_SEARCH_PIN_KV] = "grok";
        const searchPinIgnored = pickWebExtractConnection(kernel);
        kernel.kvs[WEB_EXTRACT_PIN_KV] = KEYLESS_CONNECTION_ID;
        const extractPin = pickWebExtractConnection(kernel);
        kernel.kvs[WEB_EXTRACT_PIN_KV] = "grok";
        const grokRefused = pickWebExtractConnection(kernel);
        return { auto, searchPinIgnored, extractPin, grokRefused };
      },
      want: {
        auto: "tavily",
        searchPinIgnored: "tavily",
        extractPin: KEYLESS_CONNECTION_ID,
        grokRefused: "tavily",
      },
    },
    {
      name: "projectKeylessConnection is skipped when fallback is off",
      run: () => {
        const driver = new DriverSpec();
        driver.abilityClaim = [WEB_SEARCH_CAN];
        const kernel = {
          kvs: { "web.keyless_fallback": "false" },
          drivers: { "web-keyless": driver },
          connections: {} as Record<string, ConnectionSpec>,
        };
        projectKeylessConnection(kernel);
        const off = kernel.connections[KEYLESS_CONNECTION_ID];
        kernel.kvs["web.keyless_fallback"] = "true";
        projectKeylessConnection(kernel);
        return { off, on: kernel.connections[KEYLESS_CONNECTION_ID]?.name };
      },
      want: { off: undefined, on: "web-keyless" },
    },
  ])("$name", ({ run, want }) => {
    expect(run()).toEqual(want);
  });

  it("dedicated nous intern beats keyless; BYOK dedicated beats intern regardless of insertion order", () => {
    const internOnly = {
      kvs: {} as Record<string, string>,
      drivers: {} as Record<string, DriverSpec>,
      connections: {
        [KEYLESS_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
        [NOUS_GATEWAY_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
      },
    };
    expect(pickWebSearchConnection(internOnly)).toBe(NOUS_GATEWAY_CONNECTION_ID);
    expect(pickWebExtractConnection(internOnly)).toBe(NOUS_GATEWAY_CONNECTION_ID);
    const internFirst = {
      kvs: {} as Record<string, string>,
      drivers: {} as Record<string, DriverSpec>,
      connections: {
        [NOUS_GATEWAY_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
        [KEYLESS_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
        exa: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
      },
    };
    expect(pickWebSearchConnection(internFirst)).toBe("exa");
    expect(pickWebExtractConnection(internFirst)).toBe("exa");
    const byokFirst = {
      kvs: {} as Record<string, string>,
      drivers: {} as Record<string, DriverSpec>,
      connections: {
        exa: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
        [KEYLESS_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
        [NOUS_GATEWAY_CONNECTION_ID]: face([WEB_SEARCH_CAN, WEB_EXTRACT_CAN]),
      },
    };
    expect(pickWebSearchConnection(byokFirst)).toBe("exa");
    expect(pickWebExtractConnection(byokFirst)).toBe("exa");
  });
});

function named(can: readonly string[], name: string, configuration: Record<string, unknown> = {}) {
  return { driver: { abilityClaim: can, name }, configuration };
}

describe("projectNousGatewayConnection", () => {
  it("projects intern from a live nous row and drops it when nous is gone or disabled", () => {
    const driver = new DriverSpec();
    driver.abilityClaim = [WEB_SEARCH_CAN, WEB_EXTRACT_CAN];
    driver.name = NOUS_GATEWAY_DRIVER_NAME;
    const kernel = {
      kvs: {} as Record<string, string>,
      drivers: { [NOUS_GATEWAY_DRIVER_NAME]: driver },
      connections: {
        "nous-portal": named(["completion"], "nous"),
      } as Record<string, ConnectionSpec | ReturnType<typeof named>>,
    };
    expect(sourceNousConnectionId(kernel)).toBe("nous-portal");
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toMatchObject({
      name: "nous-gateway",
      configuration: { apiUrl: FIRECRAWL_NOUS_GATEWAY_URL, sourceConnection: "nous-portal" },
    });
    expect(nousGatewaySourceOf(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-portal");
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-portal");
    expect(secretsConnectionId(kernel, "nous-portal")).toBe("nous-portal");

    kernel.connections["nous-portal"] = named(["completion"], "nous", { enabled: false });
    expect(sourceNousConnectionId(kernel)).toBeNull();
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toBeUndefined();
  });

  it("source A→B rebinds secrets; disabled A cannot retain A; no source falls back to intern id", () => {
    const driver = new DriverSpec();
    driver.abilityClaim = [WEB_SEARCH_CAN, WEB_EXTRACT_CAN];
    driver.name = NOUS_GATEWAY_DRIVER_NAME;
    const kernel = {
      kvs: {} as Record<string, string>,
      drivers: { [NOUS_GATEWAY_DRIVER_NAME]: driver },
      connections: {
        "nous-a": named(["completion"], "nous"),
        "nous-b": named(["completion"], "nous"),
      } as Record<string, ConnectionSpec | ReturnType<typeof named>>,
    };
    projectNousGatewayConnection(kernel);
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-a");

    kernel.connections["nous-a"] = named(["completion"], "nous", { enabled: false });
    projectNousGatewayConnection(kernel);
    expect(nousGatewaySourceOf(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-b");
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe("nous-b");
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toMatchObject({
      configuration: { sourceConnection: "nous-b" },
    });

    kernel.connections["nous-b"] = named(["completion"], "nous", { enabled: false });
    expect(sourceNousConnectionId(kernel)).toBeNull();
    projectNousGatewayConnection(kernel);
    expect(kernel.connections[NOUS_GATEWAY_CONNECTION_ID]).toBeUndefined();
    expect(secretsConnectionId(kernel, NOUS_GATEWAY_CONNECTION_ID)).toBe(NOUS_GATEWAY_CONNECTION_ID);
  });
});
