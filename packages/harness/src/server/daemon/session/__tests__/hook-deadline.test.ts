import { observable, runInAction } from "mobx";
import { describe, expect, it } from "vitest";

import {
  bounded,
  DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
  PLUGIN_HOOK_TIMEOUT_KV,
  pluginHookTimeoutMs,
} from "../hook-deadline.js";

describe("plugin hook bound", () => {
  it("a hook that never answers is abandoned at the deadline", async () => {
    expect(await bounded(new Promise<never>(() => {}), { ms: 10 })).toEqual({ kind: "timeout" });
  });

  it("a stop request ends the wait before the deadline", async () => {
    const stop = observable.box(false);
    const waiting = bounded(new Promise<never>(() => {}), { ms: 60_000, stopped: () => stop.get() });
    runInAction(() => stop.set(true));
    expect(await waiting).toEqual({ kind: "stopped" });
  });

  it("an answer inside the bound is returned, a rejection is rethrown", async () => {
    expect(await bounded(Promise.resolve(7), { ms: 1000 })).toEqual({ kind: "done", value: 7 });
    await expect(bounded(Promise.reject(new Error("no")), { ms: 1000 })).rejects.toThrow("no");
  });

  it("the timeout is configurable, session before kernel, junk ignored", () => {
    expect(pluginHookTimeoutMs({}, {})).toBe(DEFAULT_PLUGIN_HOOK_TIMEOUT_MS);
    expect(pluginHookTimeoutMs({ [PLUGIN_HOOK_TIMEOUT_KV]: "250" }, { [PLUGIN_HOOK_TIMEOUT_KV]: "9" })).toBe(250);
    expect(pluginHookTimeoutMs({ [PLUGIN_HOOK_TIMEOUT_KV]: "junk" }, { [PLUGIN_HOOK_TIMEOUT_KV]: "9" })).toBe(9);
  });
});
