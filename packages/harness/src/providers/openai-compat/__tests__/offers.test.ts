/**
 * What clients see for the key-only catalogs, and how adopt answers each door.
 */
import { describe, expect, it } from "vitest";

import { OpenAiCompatDriverConnection } from "../connection.js";
import { REMOTE_OFFERS } from "../presence.js";
import { WELL_KNOWN_ENDPOINTS } from "../well-known.js";

describe("REMOTE_OFFERS", () => {
  it("is one adoptable key-only door per well-known name, first baseUrl", () => {
    const names = REMOTE_OFFERS.map((offer) => offer.name);
    expect(new Set(names).size).toBe(names.length);
    for (const offer of REMOTE_OFFERS) {
      expect(offer).toMatchObject({ live: false, adoptable: true });
      const first = WELL_KNOWN_ENDPOINTS.find((endpoint) => endpoint.name === offer.name);
      expect(offer.settings).toEqual({ baseUrl: first?.baseUrl });
    }
    expect(REMOTE_OFFERS.find((offer) => offer.name === "DeepSeek")?.settings).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
    });
  });

  it("leaves out names that have a door of their own", () => {
    const names = REMOTE_OFFERS.map((offer) => offer.name);
    expect(names).toEqual(expect.arrayContaining(["OpenAI", "Groq", "Mistral", "Together"]));
    expect(names).not.toContain("OpenRouter");
    expect(names).not.toContain("Nous Portal");
    expect(names).not.toContain("xAI");
  });
});

describe("OpenAiCompatDriverConnection.adopt", () => {
  function asking(...answers: string[]) {
    const bodies: string[] = [];
    const callback = async (_kind: "UI", body: string) => {
      bodies.push(body);
      return { input: answers.shift() ?? "" };
    };
    return { bodies, callback };
  }

  it("a loopback offer asks nothing and keeps no key", async () => {
    const ask = asking();
    const bags = await OpenAiCompatDriverConnection.adopt(
      { name: "LM Studio", settings: { baseUrl: "http://127.0.0.1:1234/v1" } },
      ask.callback,
    );
    expect(ask.bodies).toEqual([]);
    expect(bags).toEqual({ name: "LM Studio", settings: { baseUrl: "http://127.0.0.1:1234/v1" }, secrets: {} });
  });

  it("a remote offer asks one required key, named for the offer", async () => {
    const ask = asking("sk-test");
    const bags = await OpenAiCompatDriverConnection.adopt(
      { name: "Groq", settings: { baseUrl: "https://api.groq.com/openai/v1" } },
      ask.callback,
    );
    expect(ask.bodies).toEqual(['(harness/input :name "API key" :description "Groq API key" :secret #t)']);
    expect(bags).toEqual({
      name: "Groq",
      settings: { baseUrl: "https://api.groq.com/openai/v1" },
      secrets: { apiKey: "sk-test" },
    });
  });

  it("a remote offer whose caller brings the key asks nothing", async () => {
    const ask = asking();
    const bags = await OpenAiCompatDriverConnection.adopt(
      { name: "Groq", settings: { baseUrl: "https://api.groq.com/openai/v1" }, secrets: { apiKey: "sk-held" } },
      ask.callback,
    );
    expect(ask.bodies).toEqual([]);
    // The daemon writes the caller's secrets itself; the driver adds none.
    expect(bags.secrets).toEqual({});
  });

  it("a remote offer with an empty key refuses", async () => {
    const ask = asking("  ");
    await expect(
      OpenAiCompatDriverConnection.adopt(
        { name: "Groq", settings: { baseUrl: "https://api.groq.com/openai/v1" } },
        ask.callback,
      ),
    ).rejects.toThrow("Groq needs an API key");
  });

  it("the custom door still asks for the URL, then an optional key", async () => {
    const ask = asking("https://example.com/v1", "");
    const bags = await OpenAiCompatDriverConnection.adopt({ name: "OpenAI-compatible" }, ask.callback);
    expect(ask.bodies).toEqual([
      '(harness/input :name "Base URL" :description "OpenAI-compatible endpoint")',
      '(harness/input :name "API key" :description "Optional. Empty to skip." :secret #t)',
    ]);
    expect(bags).toEqual({ name: "example.com", settings: { baseUrl: "https://example.com/v1" }, secrets: {} });
  });
});
