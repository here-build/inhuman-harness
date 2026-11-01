import { expect, test } from "vitest";

import { DEFAULT_PLUGIN_HOOK_TIMEOUT_MS, PLUGIN_HOOK_TIMEOUT_KV, pluginHookTimeoutMs } from "../hook-deadline.js";

test("a valid session hook deadline wins; invalid or missing values fall back to the kernel, then the default", () => {
  const timeout = (value: string) => ({ [PLUGIN_HOOK_TIMEOUT_KV]: value });
  expect([
    pluginHookTimeoutMs({}, {}),
    pluginHookTimeoutMs(timeout("250"), timeout("9")),
    ...["", "junk", "0", "-1", "Infinity", "NaN"].map((bad) => pluginHookTimeoutMs(timeout(bad), timeout("9"))),
    pluginHookTimeoutMs(timeout("junk"), timeout("0")),
  ]).toEqual([DEFAULT_PLUGIN_HOOK_TIMEOUT_MS, 250, 9, 9, 9, 9, 9, 9, DEFAULT_PLUGIN_HOOK_TIMEOUT_MS]);
});
