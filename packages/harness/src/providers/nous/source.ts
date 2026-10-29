/**
 * Derived web-nous intern from a live Nous inference row.
 * Product pick (pin → dedicated → intern → keyless) stays in composition.
 */
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";

import { FIRECRAWL_NOUS_GATEWAY_URL } from "@/providers/web/wire";

import {
  NOUS_DRIVER_NAME,
  NOUS_GATEWAY_CONNECTION_ID,
  NOUS_GATEWAY_DRIVER_NAME,
  NOUS_GATEWAY_SOURCE_SETTING,
} from "./ids.js";

type NousSourceFace = {
  readonly driver: {
    readonly can?: readonly string[];
    readonly name?: unknown;
  };
  readonly configuration?: unknown;
};

type NousSourceKernel = {
  readonly drivers: { readonly [name: string]: DriverSpec | undefined };
  readonly connections: {
    readonly [id: string]: ConnectionSpec | NousSourceFace | undefined;
  };
};

export function sourceNousConnectionId(kernel: NousSourceKernel): string | null {
  for (const [id, spec] of Object.entries(kernel.connections)) {
    if (id === NOUS_GATEWAY_CONNECTION_ID || spec === undefined) continue;
    if (driverNameOf(spec) === NOUS_DRIVER_NAME && connectionEnabled(spec)) return id;
  }
  return null;
}

export function nousGatewaySourceOf(kernel: NousSourceKernel, connectionId: string): string | null {
  if (connectionId !== NOUS_GATEWAY_CONNECTION_ID) return null;
  const tagged = taggedNousSource(kernel.connections[connectionId]);
  if (tagged !== null && isLiveNous(kernel, tagged)) return tagged;
  return sourceNousConnectionId(kernel);
}

export function secretsConnectionId(kernel: NousSourceKernel, connectionId: string): string {
  return nousGatewaySourceOf(kernel, connectionId) ?? connectionId;
}

export function projectNousGatewayConnection(into: NousSourceKernel): void {
  const driver = into.drivers[NOUS_GATEWAY_DRIVER_NAME];
  const source = sourceNousConnectionId(into);
  const connections = into.connections as { [id: string]: ConnectionSpec };
  if (driver === undefined || source === null) {
    delete connections[NOUS_GATEWAY_CONNECTION_ID];
    return;
  }
  const spec = (connections[NOUS_GATEWAY_CONNECTION_ID] ??= new ConnectionSpec({
    driver,
  }));
  spec.driver = driver;
  spec.name = "nous-gateway";
  spec.annotation = "Nous Tool Gateway";
  spec.configuration = {
    apiUrl: FIRECRAWL_NOUS_GATEWAY_URL,
    [NOUS_GATEWAY_SOURCE_SETTING]: source,
  };
}

function driverNameOf(spec: NousSourceFace): string {
  const name = (spec.driver as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function connectionEnabled(spec: NousSourceFace): boolean {
  const cfg = spec.configuration;
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return true;
  return (cfg as { enabled?: unknown }).enabled !== false;
}

function taggedNousSource(spec: ConnectionSpec | NousSourceFace | undefined): string | null {
  if (spec === undefined) return null;
  const cfg = (spec as { configuration?: unknown }).configuration;
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const tagged = (cfg as { [NOUS_GATEWAY_SOURCE_SETTING]?: unknown })[NOUS_GATEWAY_SOURCE_SETTING];
  return typeof tagged === "string" && tagged.trim() !== "" ? tagged.trim() : null;
}

function isLiveNous(kernel: NousSourceKernel, id: string): boolean {
  const spec = kernel.connections[id];
  return spec !== undefined && driverNameOf(spec) === NOUS_DRIVER_NAME && connectionEnabled(spec);
}
