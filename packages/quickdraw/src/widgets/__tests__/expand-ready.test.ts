import { expect, test } from "vitest";

import { expandWidgetPriors } from "../expand.js";

test("expandWidgetPriors does not enter a paint-ready subtree", () => {
  let entered = 0;
  const ready = {
    type: "markdown" as const,
    content: "x",
    paintReady: true as const,
    get style() {
      entered += 1;
      return undefined;
    },
  };
  const out = expandWidgetPriors(ready, { width: 40 });
  expect(out).toBe(ready);
  expect(entered).toBe(0);
});
