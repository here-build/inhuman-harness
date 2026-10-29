import { resetLocalIDs } from "@here.build/plexus";
import { BotCallJob, CallDelivery } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { stampCallLifetime } from "../index.js";

describe("delivery lifetime", () => {
  beforeEach(() => resetLocalIDs());

  it("stampCallLifetime fills empty delivery and leaves an existing lifetime", () => {
    const empty = new BotCallJob({ name: "a" });
    stampCallLifetime(empty, "turn");
    const kept = new BotCallJob({
      name: "b",
      delivery: new CallDelivery({ lifetime: "call" }),
    });
    stampCallLifetime(kept, "turn");
    const unset = new BotCallJob({ name: "c", delivery: new CallDelivery() });
    stampCallLifetime(unset, "call");
    expect({
      empty: empty.delivery instanceof CallDelivery ? empty.delivery.lifetime : empty.delivery,
      kept: kept.delivery instanceof CallDelivery ? kept.delivery.lifetime : kept.delivery,
      unset: unset.delivery instanceof CallDelivery ? unset.delivery.lifetime : unset.delivery,
    }).toEqual({
      empty: "turn",
      kept: "call",
      unset: "call",
    });
  });
});
