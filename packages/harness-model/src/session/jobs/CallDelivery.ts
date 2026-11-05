/**
 * Delivery stamp on {@link BotCallJob}. Kind is the class, not a JSON
 * `kind` string. Lifetime is catalog `turn` vs `call`; null is unset.
 */
import { Model, model, state } from "@inhuman.tools/model";

export type CallLifetime = "turn" | "call";

@model("harness:job:call-delivery")
export class CallDelivery extends Model {
  @state accessor lifetime: CallLifetime | null = null;

  constructor(props?: { readonly lifetime?: CallLifetime | null } | symbol) {
    super(props);
  }
}
