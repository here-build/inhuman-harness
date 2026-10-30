import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRelease } from "./release-check.mjs";

test("the runtime closure of inhuman is publishable", () => {
  const { problems } = checkRelease();
  assert.deepEqual(problems, []);
});
