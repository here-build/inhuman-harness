import { describe, expect, it } from "vitest";

import { KernelToolCatalog, type CatalogEntry } from "../../tool-catalog/index.js";
import { usesGenericSilentProjection } from "../index.js";

function botCall(wireName: string, show: "result" | "omit" | "turn"): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName: "pack" },
    packMeta: {
      kind: "bot-call",
      pluginName: "pack",
      target: "worker",
      background: true,
      lifetime: "turn",
      show,
      supportsNotify: false,
    },
  };
}

describe("usesGenericSilentProjection", () => {
  it("reads silent/turn from catalog metadata, not leases", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      botCall("fixture_silent", "omit"),
      botCall("fixture_turn", "turn"),
      botCall("fixture_result", "result"),
    ]);
    expect({
      silent: usesGenericSilentProjection({ name: "fixture_silent" }, catalog),
      turn: usesGenericSilentProjection({ name: "fixture_turn" }, catalog),
      result: usesGenericSilentProjection({ name: "fixture_result" }, catalog),
      missing: usesGenericSilentProjection({ name: "nope" }, catalog),
    }).toEqual({ silent: true, turn: true, result: false, missing: false });
  });
});
