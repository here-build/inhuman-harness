// RESULT-RECORDER SIDE-EFFECT COUNT — a safety property, not a correctness one. The design
// breaks the A↔futility↔doors package cycle by passing the futility tracker's narrow
// `record(name, args, result)` closure from the binder (bind.ts's `rosettaDef`) to the runner
// (today: manifold-tool.ts's drain). The failure modes are COUNT-shaped:
//   • recorded ZERO times per invocation — the wire is silently dropped (a tool built without a
//     tracker never records, exactly like today's `tracker?.record(...)` optional-chained call —
//     futility detection silently dies without anyone noticing, since nothing THROWS).
//   • recorded TWICE per invocation — double-wired at both the membrane and some other site would
//     inflate the ring buffer 2x per real call, producing FALSE futility doors (a degraded-tool
//     verdict reached in 2 real calls instead of 3, or a duplicate-call verdict off calls that
//     were never actually identical in the model's own turn count).
//
// `futility.test.ts` already proves a `Note:` EVENTUALLY fires through the server after 2-3
// shaped calls — but that indirect assertion cannot distinguish "recorded once" from "recorded
// twice, deduplicated by the ring/hash logic before it would matter" (both produce the same
// observable Note on the same call, since FutilityTracker's own triggers are already idempotent
// against a duplicate hash). This file spies the recorder directly — the exact call-count
// property the design's binder→runner boundary must preserve.

import type { FutilityTracker } from "@inhuman.tools/substrate";
import { describe, expect, it, vi } from "vitest";

import { buildManifoldEnv, type BoundServer } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

/** A minimal fake `FutilityTracker` — only `record` is ever called by bind.ts's `rosettaDef`
 *  (`drainPending` is manifold-tool.ts's own concern, untouched here) — spied directly, so this
 *  test asserts the EXACT closure the migration's binder→runner boundary crosses, not an
 *  end-to-end inference from door text. */
function spyTracker(): { tracker: FutilityTracker; record: ReturnType<typeof vi.fn> } {
  const record = vi.fn();
  const tracker = { record } as unknown as FutilityTracker;
  return { tracker, record };
}

describe("resultRecorder — exactly ONCE per successful tool invocation, never zero, never twice", () => {
  it("N invocations of ONE tool → record() called exactly N times, each with the (qualifiedName, args, result) the invocation actually used", async () => {
    const { tracker, record } = spyTracker();
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async (args) => `priced:${args.item as string}`,
          },
        ],
      },
    ];
    const manifoldEnv = await buildManifoldEnv(toolset, { tracker, attestation: "off" });
    const tool = createManifoldTool(manifoldEnv, "CATALOG");

    await tool.call({ expr: '(shop/price :item "widget")' });
    await tool.call({ expr: '(shop/price :item "gadget")' });
    await tool.call({ expr: '(shop/price :item "gizmo")' });

    expect(record).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenNthCalledWith(1, "shop/price", { item: "widget" }, "priced:widget");
    expect(record).toHaveBeenNthCalledWith(2, "shop/price", { item: "gadget" }, "priced:gadget");
    expect(record).toHaveBeenNthCalledWith(3, "shop/price", { item: "gizmo" }, "priced:gizmo");
  });

  it("MULTIPLE tool calls within ONE manifold call → record() still fires exactly once per invocation, not once per manifold call", async () => {
    const { tracker, record } = spyTracker();
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async (args) => `priced:${args.item as string}`,
          },
        ],
      },
    ];
    const manifoldEnv = await buildManifoldEnv(toolset, { tracker, attestation: "off" });
    const tool = createManifoldTool(manifoldEnv, "CATALOG");

    // ONE manifold call, THREE top-level statements, each its own tool invocation.
    await tool.call({
      expr: ['(shop/price :item "a")', '(shop/price :item "b")', '(shop/price :item "c")'],
    });

    expect(record).toHaveBeenCalledTimes(3);
  });

  it("a tool call whose upstream THROWS never records at all — the door is only ever about SUCCESSFUL results (bind.ts's own comment)", async () => {
    const { tracker, record } = spyTracker();
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "broken",
            description: "always throws",
            inputSchema: { type: "object", properties: {}, required: [] },
            invoke: async () => {
              throw new Error("upstream exploded");
            },
          },
        ],
      },
    ];
    const manifoldEnv = await buildManifoldEnv(toolset, { tracker, attestation: "off" });
    const tool = createManifoldTool(manifoldEnv, "CATALOG");

    const result = await tool.call({ expr: "(shop/broken)" });
    expect(result.isError).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it("a tool built WITHOUT a tracker records nowhere — the optional-chained wire degrades safely to absent, not to a crash", async () => {
    const toolset: BoundServer[] = [
      {
        slug: "shop",
        tools: [
          {
            name: "price",
            description: "price lookup",
            inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            invoke: async () => 10,
          },
        ],
      },
    ];
    // No `tracker` option at all — the binder-side wiring this test must never regress to
    // silently double-record once a tracker IS supplied.
    const manifoldEnv = await buildManifoldEnv(toolset, { attestation: "off" });
    const tool = createManifoldTool(manifoldEnv, "CATALOG");
    const result = await tool.call({ expr: '(shop/price :item "widget")' });
    expect(result.isError).toBeFalsy();
  });
});
