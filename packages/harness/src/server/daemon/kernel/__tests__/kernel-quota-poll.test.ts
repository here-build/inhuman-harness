/**
 * Quota polling occupancy is KERNEL awareness, not the minting session's
 * awareness. Two session orchestrators intern one ChatGPT connection; A
 * parks, B focuses — the interned instance must keep polling.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAwarenessUpdate, encodeAwarenessUpdate, PlexusAwareness, resetLocalIDs } from "@here.build/plexus";
import { publishRevalidationDemand, publishRevalidationDemandFocus } from "@inhuman.tools/plexus-expectations";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";

import { ChatGptDriverConnection } from "@/providers/chatgpt";
import { ACCOUNT_IDLE_MS, ACCOUNT_STALE_MS, type AccountSnapshot } from "@/providers/openai-compat";

import { writeConnectionSecrets } from "../../../secrets.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../../session/SessionDaemon.js";
import { KernelDaemon } from "../KernelDaemon.js";

const CONNECTION_ID = "chatgpt";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => resetLocalIDs());

function muteFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/models") || url.includes("/user") || url.includes("userinfo") || url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }], models: [{ slug: "gpt-5.4" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function windowsOf(remainingPercent: number): AccountSnapshot {
  return {
    identity: { shortName: "", name: "" },
    identityDetail: { shortName: "", name: "", kind: "subscription" },
    balanceDetail: {
      windows: [{ label: "5h", remainingPercent, status: "ok" }],
    },
  };
}

function remainingOf(instance: ChatGptDriverConnection): number | undefined {
  return instance.state.account?.balanceDetail?.windows?.[0]?.remainingPercent;
}

function remoteAuthor(hub: PlexusAwareness): {
  author: PlexusAwareness;
  sync(): void;
  [Symbol.dispose](): void;
} {
  const doc = new Y.Doc();
  const author = new PlexusAwareness(doc);
  const sync = (): void => {
    const clients = [...author.meta.keys()];
    if (clients.length === 0) return;
    applyAwarenessUpdate(hub, encodeAwarenessUpdate(author, clients), "remote");
  };
  return {
    author,
    sync,
    [Symbol.dispose]() {
      author.destroy();
      doc.destroy();
    },
  };
}

async function openQuotaKernel(): Promise<{
  kernel: KernelDaemon;
  sessionA: SessionDaemon;
  sessionB: SessionDaemon;
}> {
  const system = await mkdtemp(join(tmpdir(), "harness-quota-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-quota-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  kernel.adjustConfig((config) => {
    config.connections[CONNECTION_ID] = {
      driver: "chatgpt",
      name: "chatgpt",
      annotation: "",
      settings: { baseUrl: ChatGptDriverConnection.oidcProfile.baseUrl },
    };
  });
  writeConnectionSecrets(kernel.root, CONNECTION_ID, {
    apiKey: "at",
    accountId: "acct",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const sessionA = await project.session("a");
  const sessionB = await project.session("b");
  onTestFinished(() => {
    void sessionA.park();
    void sessionB.park();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, sessionA, sessionB };
}

describe("openai-compat quota poll × KERNEL awareness", () => {
  it("A parks, B focuses interned chatgpt: 9 → 100/17, 45s poll, last client stops", async () => {
    muteFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { kernel, sessionA, sessionB } = await openQuotaKernel();
    const hub = kernel.plexus.awareness;
    const target = { kind: "connection" as const, id: CONNECTION_ID };

    type LoadAccount = { loadAccount(): Promise<AccountSnapshot | undefined> };
    const loads: number[] = [];
    const load = vi
      .spyOn(ChatGptDriverConnection.prototype as unknown as LoadAccount, "loadAccount")
      .mockImplementation(async () => {
        loads.push(9);
        return windowsOf(9);
      });

    const minted = await sessionA.orchestrator.ensure(CONNECTION_ID);
    expect(minted).toBeInstanceOf(ChatGptDriverConnection);
    const instance = minted as ChatGptDriverConnection;
    const reused = await sessionB.orchestrator.ensure(CONNECTION_ID);
    expect(reused).toBe(instance);

    await when(() => instance.readyState === "ready", { timeout: 5_000 });
    await Promise.resolve();
    expect({
      sameInstance: reused === instance,
      remaining: remainingOf(instance),
      seeded: loads.length > 0,
      attention: instance.revalidationDemand,
    }).toEqual({
      sameInstance: true,
      remaining: 9,
      seeded: true,
      attention: "none",
    });

    using focused = remoteAuthor(hub);
    publishRevalidationDemand(focused.author, [target]);
    publishRevalidationDemandFocus(focused.author, target);
    focused.sync();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await sessionA.park();
    expect({
      remaining: remainingOf(instance),
      attention: instance.revalidationDemand,
      instanceHub: instance.awareness === hub,
      classHub: ChatGptDriverConnection.awareness === hub,
      same: reused === instance,
    }).toEqual({
      remaining: 9,
      attention: "primary",
      instanceHub: true,
      classHub: true,
      same: true,
    });

    load.mockImplementation(async () => {
      loads.push(100);
      return windowsOf(100);
    });
    const lookingLoads = loads.length;
    await vi.advanceTimersByTimeAsync(ACCOUNT_STALE_MS);
    expect({ remaining: remainingOf(instance), loads: loads.length, attention: instance.revalidationDemand }).toEqual({
      remaining: 100,
      loads: lookingLoads + 1,
      attention: "primary",
    });

    load.mockImplementation(async () => {
      loads.push(17);
      return windowsOf(17);
    });
    await vi.advanceTimersByTimeAsync(ACCOUNT_STALE_MS);
    expect({ remaining: remainingOf(instance), loads: loads.length }).toEqual({
      remaining: 17,
      loads: lookingLoads + 2,
    });

    publishRevalidationDemandFocus(focused.author, null);
    publishRevalidationDemand(focused.author, []);
    focused.sync();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const afterLeave = loads.length;
    expect({ attention: instance.revalidationDemand, remaining: remainingOf(instance) }).toEqual({
      attention: "none",
      remaining: 17,
    });

    await vi.advanceTimersByTimeAsync(ACCOUNT_STALE_MS * 2);
    expect({ loads: loads.length, remaining: remainingOf(instance) }).toEqual({
      loads: afterLeave,
      remaining: 17,
    });

    load.mockImplementation(async () => {
      loads.push(4);
      return windowsOf(4);
    });
    await vi.advanceTimersByTimeAsync(ACCOUNT_IDLE_MS);
    expect({ remaining: remainingOf(instance), loads: loads.length, attention: instance.revalidationDemand }).toEqual({
      remaining: 4,
      loads: afterLeave + 1,
      attention: "none",
    });
  });

  it("occupied session interned its bound wire without a turn", async () => {
    muteFetch();
    vi.spyOn(
      ChatGptDriverConnection.prototype as unknown as { loadAccount(): Promise<AccountSnapshot | undefined> },
      "loadAccount",
    ).mockResolvedValue(windowsOf(33));
    const { kernel, sessionA } = await openQuotaKernel();
    sessionA.root.applyKvs([{ form: "kv-set", key: "connection", value: CONNECTION_ID }]);
    await when(
      () =>
        (kernel.plexus.root.connections[CONNECTION_ID]?.live.account as AccountSnapshot | undefined)?.balanceDetail
          ?.windows?.[0]?.remainingPercent === 33,
      { timeout: 5_000 },
    );
    expect(
      (kernel.plexus.root.connections[CONNECTION_ID]?.live.account as AccountSnapshot | undefined)?.balanceDetail
        ?.windows,
    ).toEqual([{ label: "5h", remainingPercent: 33, status: "ok" }]);
  });

  it("a client looking at a wire no session named interns it on the kernel", async () => {
    muteFetch();
    vi.spyOn(
      ChatGptDriverConnection.prototype as unknown as { loadAccount(): Promise<AccountSnapshot | undefined> },
      "loadAccount",
    ).mockResolvedValue(windowsOf(61));
    const { kernel } = await openQuotaKernel();
    using looking = remoteAuthor(kernel.plexus.awareness);
    publishRevalidationDemand(looking.author, [{ kind: "connection", id: CONNECTION_ID }]);
    looking.sync();
    await when(
      () =>
        (kernel.plexus.root.connections[CONNECTION_ID]?.live.account as AccountSnapshot | undefined)?.balanceDetail
          ?.windows?.[0]?.remainingPercent === 61,
      { timeout: 5_000 },
    );
  });
});
