import type { AwarenessSerializable, AwarenessShape, Plexus, PlexusModel } from "@here.build/plexus";

import type { ConnectionSpec } from "./models/ConnectionSpec.js";
import type { DriverSpec } from "./models/DriverSpec.js";
import type { WorkContainer } from "./models/WorkContainer.js";
import type { RevalidationDemandRef } from "./revalidation-demand.js";

/** `null` = never ensured / never loaded. */
export type ReadyState = null | "bootstrapping" | "ready" | "failed";

export function asReadyState(value: unknown): ReadyState {
  if (value === "bootstrapping" || value === "ready" || value === "failed") return value;
  return null;
}

/**
 * Revalidation demand is kernel-plane: interned connections outlive a session wrap.
 * Live catalog faces stay on DriverSpec / ConnectionSpec, not awareness lanes.
 */
export type KernelAwareness = AwarenessShape & {
  revalidationDemand?: readonly RevalidationDemandRef[];
  revalidationDemandFocus?: RevalidationDemandRef | null;
};

/** Live shell tails: one lane, `Record<job.uuid, frame>`. */
export const SHELL_TAILS_LANE = "shell-tails";

/** Role occupancy: one lane, `Record<expectation.uuid, frame | "">`. */
export const ROLE_EXPECTATIONS_LANE = "role:expectations";

/** Statusline left slot: the daemon's last successful eval. */
export const STATUSLINE_LANE = "statusline";

export type SessionAwareness = AwarenessShape & {
  /** Operator `policy.json` load/eval throw. Presence, not a leaf vote. */
  policyError?: string;
  [STATUSLINE_LANE]?: string;
  [SHELL_TAILS_LANE]?: Record<string, AwarenessSerializable>;
  [ROLE_EXPECTATIONS_LANE]?: Record<string, AwarenessSerializable>;
};

/**
 * Catalog parent of {@link DriverSpec} / {@link ConnectionSpec}.
 * Ordinary records, not virtual maps.
 */
export type SpecCatalog = PlexusModel<null> & {
  readonly drivers: Record<string, DriverSpec>;
  readonly connections: Record<string, ConnectionSpec>;
};

/** Product membership is YAML projected onto these records. */
export type KernelRootModel = SpecCatalog;

export type SessionRootModel = WorkContainer;

export type KernelPlexus = Plexus<KernelRootModel, KernelAwareness>;
export type SessionPlexus = Plexus<SessionRootModel, SessionAwareness>;
