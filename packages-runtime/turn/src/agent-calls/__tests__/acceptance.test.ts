import { createHash } from "node:crypto";

import { resetLocalIDs } from "@here.build/plexus";
import { AgentCallJob, BotCallJob, CallDelivery } from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { beforeEach, describe, expect, it } from "vitest";

import { shouldSkipTurnCancel } from "../acceptance.js";
import { isCallPaused, joinReleased, markDelivered } from "../index.js";
import { botCall, callsCatalog } from "./fixtures.js";

function revisionOf(definition: unknown): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}

describe("acceptance and join", () => {
  beforeEach(() => resetLocalIDs());

  it("call-lifetime join waits for delivery, not for prepared input", () => {
    const catalog = callsCatalog([botCall("offload", { lifetime: "call", background: true })]);
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
    });
    expect(joinReleased(call, catalog)).toBe(false);
    call.acceptPreparedInput({ prepared: true }, "worker");
    expect(joinReleased(call, catalog)).toBe(false);
    markDelivered(call);
    expect(joinReleased(call, catalog)).toBe(true);
  });

  it("wakes an existing join waiter when the delivery lands", async () => {
    const catalog = callsCatalog();
    const call = new BotCallJob({ name: "agent__send", background: true, orchestrationResult: true });
    call.acceptPreparedInput({ message: "hello" }, "standing-bot");
    let released = false;
    const waiting = when(() => joinReleased(call, catalog), { timeout: 1_000 }).then(() => {
      released = true;
      return true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    markDelivered(call);
    await waiting;
    expect(released).toBe(true);
  });

  it("child calls do not acquire bot acceptance or lifetime from catalog names", () => {
    const catalog = callsCatalog([botCall("offload")]);
    const call = new AgentCallJob({ name: "offload", background: true, orchestrationResult: true });
    expect({ released: joinReleased(call, catalog), skipsCancel: shouldSkipTurnCancel(call, catalog) }).toEqual({
      released: true,
      skipsCancel: false,
    });
  });

  it("named bot requests wait for delivery without a catalog contribution", () => {
    const catalog = callsCatalog();
    const call = new BotCallJob({ name: "agent__send", background: true, orchestrationResult: true });
    expect(joinReleased(call, catalog)).toBe(false);
    call.acceptPreparedInput({ message: "hello" }, "standing-bot");
    expect(joinReleased(call, catalog)).toBe(false);
    markDelivered(call);
    expect(joinReleased(call, catalog)).toBe(true);
  });

  it("turn lifetime does not skip cancel; call lifetime does", () => {
    const catalog = callsCatalog([
      botCall("turn-bot", { lifetime: "turn" }),
      botCall("work-bot", { lifetime: "call" }),
    ]);
    const turnCall = new BotCallJob({
      name: "turn-bot",
      delivery: new CallDelivery({ lifetime: "turn" }),
    });
    const workCall = new BotCallJob({
      name: "work-bot",
      delivery: new CallDelivery({ lifetime: "call" }),
    });
    const metaOnly = new BotCallJob({ name: "work-bot" });
    expect({
      turn: shouldSkipTurnCancel(turnCall, catalog),
      work: shouldSkipTurnCancel(workCall, catalog),
      meta: shouldSkipTurnCancel(metaOnly, catalog),
      workNoCatalog: shouldSkipTurnCancel(workCall),
      metaNoCatalog: shouldSkipTurnCancel(metaOnly),
    }).toEqual({
      turn: false,
      work: true,
      meta: true,
      workNoCatalog: true,
      metaNoCatalog: false,
    });
  });

  it("pauses when the compiled plugin revision or wire name moves", () => {
    const definition = { tools: [{ name: "offload" }] };
    const catalog = callsCatalog([botCall("offload", { pluginName: "abi" })], {
      plugins: new Map([["abi", { definition }]]),
    });
    const pinned = new BotCallJob({
      name: "offload",
      contributionPluginName: "abi",
      contributionBotName: "worker",
      contributionRevision: revisionOf(definition),
    });
    const upgraded = new BotCallJob({
      name: "offload",
      contributionPluginName: "abi",
      contributionBotName: "worker",
      contributionRevision: "other",
    });
    const missingWire = new BotCallJob({
      name: "gone",
      contributionPluginName: "abi",
      contributionBotName: "worker",
      contributionRevision: revisionOf(definition),
    });
    expect({
      pinned: isCallPaused(pinned, catalog),
      upgraded: isCallPaused(upgraded, catalog),
      missingWire: isCallPaused(missingWire, catalog),
    }).toEqual({ pinned: false, upgraded: true, missingWire: true });
  });

  it("behavior plugins pause from botRevisions, not pluginInstall", () => {
    const catalog = callsCatalog([], {
      botRevisions: new Map([["scout", "rev-1"]]),
    });
    const live = new BotCallJob({
      name: "scout",
      contributionPluginName: "behavior",
      contributionBotName: "scout",
      contributionRevision: "rev-1",
    });
    const stale = new BotCallJob({
      name: "scout",
      contributionPluginName: "behavior",
      contributionBotName: "scout",
      contributionRevision: "rev-0",
    });
    expect({
      live: isCallPaused(live, catalog),
      stale: isCallPaused(stale, catalog),
    }).toEqual({
      live: false,
      stale: true,
    });
  });
});
