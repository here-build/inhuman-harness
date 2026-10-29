import { expect, test } from "vitest";

import { layout } from "../engine.js";
import type { LayoutNode } from "../types.js";

test("subtree dimming compounds locally and leaves neighboring content unchanged", () => {
  const root: LayoutNode = {
    type: "box",
    children: [
      { type: "text", key: "target", content: "selected" },
      {
        type: "box",
        regionProminence: 0.5,
        children: [{ type: "text", key: "neighbor", content: "other", style: { regionProminence: 0.4 } }],
      },
    ],
  };
  for (let i = 0; i < 2; i++) {
    const frame = layout(root, { w: 40, h: 10 });
    const fade = (key: string) =>
      frame.paintOrder
        .find((node) => node.key === key)
        ?.paint.map((op) => (op.kind === "raw" ? undefined : op.style.regionProminence));
    expect(fade("target")).toEqual([undefined]);
    expect(fade("neighbor")).toEqual([0.2]);
  }
});
