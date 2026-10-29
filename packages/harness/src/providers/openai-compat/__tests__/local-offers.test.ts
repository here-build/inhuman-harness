/**
 * Local detection: the probe, the demand-gated interval, and the class wiring
 * (observer wakes it, kernel awareness gates the interval).
 */
import { applyAwarenessUpdate, encodeAwarenessUpdate, PlexusAwareness } from "@here.build/plexus";
import { publishRevalidationDemand } from "@inhuman.tools/plexus-expectations";
import { observable, reaction, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { OpenAiCompatDriverConnection } from "../connection.js";
import { detectedLocalOffers, LOCAL_PROBE_INTERVAL_MS } from "../local-offers.js";
import { CUSTOM_OFFER, probeLocalOffers, REMOTE_OFFERS } from "../presence.js";

const MODEL_LIST = JSON.stringify({ object: "list", data: [{ id: "qwen3", object: "model" }] });

/** A local box: answers 200 on the listed `{port}{path}` /models, refuses the rest. */
function serving(...bases: string[]) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (bases.some((base) => url === `http://127.0.0.1:${base}/models`))
      return new Response(MODEL_LIST, { status: 200 });
    if (url.endsWith("/models") && url.includes("127.0.0.1")) return new Response("nope", { status: 404 });
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  return { impl, calls };
}

describe("probeLocalOffers", () => {
  it("skips a server that answers 200 with a page instead of a model list", async () => {
    const impl = (async (input: string | URL | Request) =>
      String(input) === "http://127.0.0.1:8080/v1/models"
        ? new Response("<!doctype html><div id=app></div>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response("nope", { status: 404 })) as typeof fetch;
    expect(await probeLocalOffers(impl)).toEqual([]);
  });

  it("offers every answering known port as a live adoptable door, sorted", async () => {
    const { impl } = serving("11434/v1", "1234/v1");
    expect(await probeLocalOffers(impl)).toEqual([
      {
        name: "LM Studio",
        description: "Local OpenAI-compat :1234",
        live: true,
        adoptable: true,
        settings: { baseUrl: "http://127.0.0.1:1234/v1" },
      },
      {
        name: "Ollama",
        description: "Local OpenAI-compat :11434",
        live: true,
        adoptable: true,
        settings: { baseUrl: "http://127.0.0.1:11434/v1" },
      },
    ]);
  });

  it("misses (refused, 404) produce nothing", async () => {
    const { impl } = serving();
    expect(await probeLocalOffers(impl)).toEqual([]);
  });

  it("an ambiguous port is named by its port, unless a named server claimed it", async () => {
    const bare = serving("8080/v1", "8000/v1");
    const found = await probeLocalOffers(bare.impl);
    expect(found.map((offer) => offer.name)).toEqual(["local :8000", "local :8080"]);
    const lemonade = serving("8000/api/v1", "8000/v1");
    expect(await probeLocalOffers(lemonade.impl)).toMatchObject([
      { name: "Lemonade", settings: { baseUrl: "http://127.0.0.1:8000/api/v1" } },
    ]);
    expect(lemonade.calls).not.toContain("http://127.0.0.1:8000/v1/models");
  });
});

describe("detectedLocalOffers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("probes once on wake, re-probes only while looked at, and sleeps with its last observer", async () => {
    const lm = serving("1234/v1");
    const looking = observable.box(false);
    const box = detectedLocalOffers({ looking: () => looking.get(), fetch: () => lm.impl });
    expect(lm.calls).toEqual([]); // nothing observes: nothing runs

    const seen: number[] = [];
    const stop = reaction(
      () => box.get().length,
      (n) => seen.push(n),
    );
    await vi.advanceTimersByTimeAsync(0);
    const sweep = lm.calls.length;
    expect(sweep).toBeGreaterThan(0);
    expect(box.get()).toHaveLength(1);
    expect(seen).toEqual([1]);

    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS * 5);
    expect(lm.calls).toHaveLength(sweep); // nobody looking: no re-probe
    expect(vi.getTimerCount()).toBe(0);

    runInAction(() => looking.set(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(lm.calls.length).toBe(sweep * 2); // looking starts with an immediate sweep
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS);
    expect(lm.calls.length).toBe(sweep * 3);

    runInAction(() => looking.set(false));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS * 5);
    expect(lm.calls.length).toBe(sweep * 3);

    runInAction(() => looking.set(true));
    stop(); // last observer gone while looked at
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS * 5);
    expect(lm.calls.length).toBe(sweep * 4); // only the sweep looking began before sleep
  });

  it("a server that appears while looked at shows up and one that leaves goes away", async () => {
    let up = false;
    const impl = (async (input: string | URL | Request) => {
      if (up && String(input) === "http://127.0.0.1:11434/v1/models") return new Response(MODEL_LIST, { status: 200 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const box = detectedLocalOffers({ looking: () => true, fetch: () => impl });
    const stop = reaction(
      () => box.get(),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(box.get()).toEqual([]);
    up = true;
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS);
    expect(box.get().map((offer) => offer.name)).toEqual(["Ollama"]);
    up = false;
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS);
    expect(box.get()).toEqual([]);
    stop();
  });
});

describe("OpenAiCompatDriverConnection.offers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is detected, custom, then catalogs; the kernel awareness gates the interval", async () => {
    const hub = new PlexusAwareness(new Y.Doc());
    const lm = serving("1234/v1");
    class Probed extends OpenAiCompatDriverConnection {}
    Probed.probeFetch = lm.impl;
    Probed.awareness = hub;
    Probed.driverName = "probed";

    expect(Probed.offers).toEqual([CUSTOM_OFFER, ...REMOTE_OFFERS]); // plain read: nothing detected yet
    let offers = Probed.offers;
    const stop = reaction(
      () => Probed.offers,
      (next) => {
        offers = next;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(offers.map((offer) => offer.name).slice(0, 2)).toEqual(["LM Studio", CUSTOM_OFFER.name]);
    expect(offers.slice(2)).toEqual(REMOTE_OFFERS);

    const sweep = lm.calls.length;
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS * 3);
    expect(lm.calls).toHaveLength(sweep);

    const doc = new Y.Doc();
    const author = new PlexusAwareness(doc);
    publishRevalidationDemand(author, [{ kind: "driver", name: "probed" }]);
    applyAwarenessUpdate(hub, encodeAwarenessUpdate(author, [...author.meta.keys()]), "remote");
    await vi.advanceTimersByTimeAsync(LOCAL_PROBE_INTERVAL_MS);
    expect(lm.calls.length).toBeGreaterThan(sweep);

    const withInterval = vi.getTimerCount();
    stop();
    expect(vi.getTimerCount()).toBe(withInterval - 1); // our interval, and only ours, is gone
    author.destroy();
    doc.destroy();
  });
});
