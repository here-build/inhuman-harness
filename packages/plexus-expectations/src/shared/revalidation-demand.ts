/**
 * Revalidation demand. Clients publish on kernel awareness; PEW reduces to
 * none | secondary | primary. Interned connections outlive a session wrap, so
 * occupancy is not session-plane. Drivers read the reduced token — never clientIds.
 */
import { FieldAwareness, type PlexusAwareness } from "@here.build/plexus";

import { ConnectionSpec } from "./models/ConnectionSpec.js";
import { DriverSpec } from "./models/DriverSpec.js";

export type RevalidationDemand = "none" | "secondary" | "primary";

export const REVALIDATION_DEMAND_LANE = "revalidationDemand";
export const REVALIDATION_DEMAND_FOCUS_LANE = "revalidationDemandFocus";

export type RevalidationDemandRef =
  | { readonly kind: "driver"; readonly name: string }
  | { readonly kind: "connection"; readonly id: string };

export type RevalidationDemandSubject = DriverSpec | ConnectionSpec;

export type RevalidationDemandSource = RevalidationDemandSubject | Iterable<RevalidationDemandSubject | null | undefined> | null | undefined;

export function revalidationDemandRefFromSpec(spec: RevalidationDemandSubject): RevalidationDemandRef {
  if (isConnectionSubject(spec)) return { kind: "connection", id: spec.id };
  return { kind: "driver", name: spec.name };
}

export function collectRevalidationDemandRefs(source: RevalidationDemandSource): RevalidationDemandRef[] {
  if (source == null) return [];
  if (isRevalidationDemandSubject(source)) return [revalidationDemandRefFromSpec(source)];
  const out: RevalidationDemandRef[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    if (item == null || !isRevalidationDemandSubject(item)) continue;
    const ref = revalidationDemandRefFromSpec(item);
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function publishRevalidationDemand(hub: PlexusAwareness, refs: readonly RevalidationDemandRef[]): void {
  const lane = new FieldAwareness(hub, REVALIDATION_DEMAND_LANE);
  if (refs.length === 0) {
    lane.clear();
    return;
  }
  lane.set(refs as never);
}

export function publishRevalidationDemandFocus(hub: PlexusAwareness, ref: RevalidationDemandRef | null): void {
  const lane = new FieldAwareness(hub, REVALIDATION_DEMAND_FOCUS_LANE);
  if (ref == null) {
    lane.clear();
    return;
  }
  lane.set(ref as never);
}

/** Union of every client's occupancy. Primary wins over secondary. */
export function revalidationDemandOf(hub: PlexusAwareness, target: RevalidationDemandRef): RevalidationDemand {
  const focus = new FieldAwareness(hub, REVALIDATION_DEMAND_FOCUS_LANE);
  for (const clientId of focus.clientIds) {
    const value = asRevalidationDemandRef(focus.getOther(clientId));
    if (value != null && sameRef(value, target)) return "primary";
  }
  const ambient = new FieldAwareness(hub, REVALIDATION_DEMAND_LANE);
  for (const clientId of ambient.clientIds) {
    const list = asRevalidationDemandRefList(ambient.getOther(clientId));
    if (list.some((item) => sameRef(item, target))) return "secondary";
  }
  return "none";
}

function isConnectionSubject(spec: RevalidationDemandSubject): spec is ConnectionSpec {
  if (spec instanceof ConnectionSpec) return true;
  if (spec instanceof DriverSpec) return false;
  return "driver" in spec && "configuration" in spec;
}

function isRevalidationDemandSubject(value: unknown): value is RevalidationDemandSubject {
  if (value instanceof ConnectionSpec || value instanceof DriverSpec) return true;
  if (typeof value !== "object" || value === null) return false;
  if ("driver" in value && "configuration" in value) return true;
  return "importPath" in value && "abilityClaim" in value;
}

function asRevalidationDemandRef(value: unknown): RevalidationDemandRef | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as { kind?: unknown; name?: unknown; id?: unknown };
  if (rec.kind === "driver" && typeof rec.name === "string" && rec.name !== "") {
    return { kind: "driver", name: rec.name };
  }
  if (rec.kind === "connection" && typeof rec.id === "string" && rec.id !== "") {
    return { kind: "connection", id: rec.id };
  }
  return null;
}

function asRevalidationDemandRefList(value: unknown): RevalidationDemandRef[] {
  if (!Array.isArray(value)) return [];
  const out: RevalidationDemandRef[] = [];
  for (const item of value) {
    const ref = asRevalidationDemandRef(item);
    if (ref != null) out.push(ref);
  }
  return out;
}

function sameRef(a: RevalidationDemandRef, b: RevalidationDemandRef): boolean {
  if (a.kind === "driver" && b.kind === "driver") return a.name === b.name;
  if (a.kind === "connection" && b.kind === "connection") return a.id === b.id;
  return false;
}

function refKey(ref: RevalidationDemandRef): string {
  return ref.kind === "driver" ? `driver:${ref.name}` : `connection:${ref.id}`;
}
