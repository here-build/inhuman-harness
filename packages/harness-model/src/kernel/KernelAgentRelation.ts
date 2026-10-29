/**
 * Caller → worker edge. Daemon-projected from an interned `CallJob`.
 * Listing TUI walks this map; it does not intern the worker tape.
 * The Call on the caller document stays the work. This is the relation.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { KernelRoot } from "./KernelRoot.js";

@syncing("harness:kernel:agent-relation")
export class KernelAgentRelation extends PlexusModel<KernelRoot | null> {
  get callId(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  @syncing accessor callerSessionId: string = "";
  @syncing accessor workerSessionId: string = "";
  /** Recipe / bot name. Empty = anonymous ask. */
  @syncing accessor spec: string = "";
  @syncing accessor oneShot: boolean = false;
  @syncing accessor completed: boolean = false;

  constructor(
    opts?:
      | {
          readonly callerSessionId?: string;
          readonly workerSessionId?: string;
          readonly spec?: string;
          readonly oneShot?: boolean;
          readonly completed?: boolean;
        }
      | symbol,
  ) {
    super(opts);
  }
}
