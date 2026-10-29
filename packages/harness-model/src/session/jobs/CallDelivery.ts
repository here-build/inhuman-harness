/**
 * Delivery stamp on {@link BotCallJob}. Kind is the class, not a JSON
 * `kind` string. Lifetime is catalog `turn` vs `call`; null is unset.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

export type CallLifetime = "turn" | "call";

@syncing("harness:job:call-delivery")
export class CallDelivery extends PlexusModel {
  @syncing accessor lifetime: CallLifetime | null = null;

  constructor(props?: { readonly lifetime?: CallLifetime | null } | symbol) {
    super(props);
  }
}
