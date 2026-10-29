/**
 * A bot call's lifetime, stamped from its catalog tool.
 * `show: "omit"` / `"turn"` are not marker hints.
 */
import { BotCallJob, CallDelivery, CallJob, type CallLifetime } from "@inhuman.tools/harness-model";

export function stampCallLifetime(call: CallJob, lifetime: CallLifetime): void {
  if (!(call instanceof BotCallJob)) return;
  const delivery = call.delivery;
  if (delivery == null) {
    call.delivery = new CallDelivery({ lifetime });
    return;
  }
  delivery.lifetime ??= lifetime;
}
