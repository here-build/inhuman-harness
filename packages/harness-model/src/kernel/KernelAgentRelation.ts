/**
 * Caller → worker edge. Daemon-projected from an interned `CallJob`.
 * Listing TUI walks this map; it does not intern the worker tape.
 * The Call on the caller document stays the work. This is the relation.
 */
import { Model, model, state } from "@inhuman.tools/model";

import type { KernelRoot } from "./KernelRoot.js";

@model("harness:kernel:agent-relation")
export class KernelAgentRelation extends Model<any, KernelRoot | null> {
  get callId(): string {
    return (this.parentFieldKey as string | null) ?? "";
  }

  @state accessor callerSessionId: string = "";
  @state accessor workerSessionId: string = "";
  /** Recipe / bot name. Empty = anonymous ask. */
  @state accessor spec: string = "";
  @state accessor oneShot: boolean = false;
  @state accessor completed: boolean = false;

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
