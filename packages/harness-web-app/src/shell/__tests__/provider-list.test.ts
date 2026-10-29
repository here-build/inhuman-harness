import { describe, expect, it } from "vitest";

import { needsOnboarding, providerRows, type DriverSource } from "../provider-list.js";

const offer = (name: string, baseUrl: string | null, live: boolean, adoptable = true, description = name) => ({
  name,
  description,
  live,
  adoptable,
  settings: baseUrl == null ? {} : { baseUrl },
});

const driver = (name: string, offers: readonly object[] = []): DriverSource => ({
  name,
  description: name,
  abilityClaim: ["completion"],
  offers,
});

const compat = driver("openai-compat", [
  offer("Ollama", "http://127.0.0.1:11434/v1", true),
  offer("OpenAI-compatible", null, false),
  offer("OpenAI", "https://api.openai.com/v1", false),
  offer("Groq", "https://api.groq.com/openai/v1", false),
]);

const drivers = {
  // The kernel's order is not the list's order.
  "openai-compat": compat,
  nous: driver("nous", [offer("Nous Portal", "https://inference-api.nousresearch.com/v1", true)]),
  grok: driver("grok", [offer("Grok", "https://cli-chat-proxy.grok.com/v1", true, true, "Grok subscription")]),
  openrouter: driver("openrouter", [offer("OpenRouter", "https://openrouter.ai/api/v1", true)]),
  chatgpt: driver("chatgpt", [
    offer("ChatGPT", "https://chatgpt.com/backend-api/codex", true, true, "ChatGPT subscription"),
  ]),
  web: { name: "web", abilityClaim: ["web-search"], offers: [offer("Exa", null, false)] },
};

const names = (rows: ReturnType<typeof providerRows>) => rows.map((row) => row.name);

describe("needs onboarding", () => {
  it("is true until a connection speaks completion", () => {
    expect(needsOnboarding(undefined)).toBe(true);
    expect(needsOnboarding({})).toBe(true);
    expect(needsOnboarding({ web: { driver: { name: "web", abilityClaim: ["web-search"] } } })).toBe(true);
    expect(needsOnboarding({ a: undefined, b: { driver: null } })).toBe(true);
    expect(needsOnboarding({ g: { driver: { name: "grok", abilityClaim: ["completion"] } } })).toBe(false);
  });
});

describe("provider rows", () => {
  it("orders subscriptions, gateways, local servers, keys, then the custom endpoint", () => {
    expect(names(providerRows(drivers, {}))).toEqual([
      "ChatGPT",
      "Grok",
      "OpenRouter",
      "Nous Portal",
      "Ollama",
      "OpenAI",
      "Groq",
      "OpenAI-compatible",
    ]);
  });

  it("says how each one signs in, from its offer", () => {
    const hints = Object.fromEntries(providerRows(drivers, {}).map((row) => [row.name, [row.group, row.hint]]));
    expect(hints).toMatchObject({
      ChatGPT: ["subscription", "Browser"],
      OpenRouter: ["gateway", "Browser"],
      Ollama: ["local", "Local · live"],
      Groq: ["key", "API key"],
      "OpenAI-compatible": ["custom", "Endpoint"],
    });
  });

  it("leaves out drivers that do not complete", () => {
    expect(names(providerRows(drivers, {}))).not.toContain("Exa");
  });

  it("hides an offer a connection already adopted, by name or by endpoint", () => {
    const rows = providerRows(drivers, {
      chatgpt: { name: "ChatGPT", driver: { name: "chatgpt" } },
      local: {
        name: "My llama",
        driver: { name: "openai-compat" },
        configuration: { baseUrl: "http://127.0.0.1:11434/v1" },
      },
      groq: { name: "Groq", driver: { name: "openai-compat" } },
    });
    expect(names(rows)).toEqual(["Grok", "OpenRouter", "Nous Portal", "OpenAI", "OpenAI-compatible"]);
  });

  it("matches an adopted name only within its own driver, and never hides the custom endpoint", () => {
    const rows = providerRows(drivers, {
      impostor: { name: "Grok", driver: { name: "openai-compat" } },
      custom: { name: "OpenAI-compatible", driver: { name: "openai-compat" } },
    });
    expect(names(rows)).toContain("Grok");
    expect(names(rows)).toContain("OpenAI-compatible");
  });

  it("starts an adopt with the offer's name and settings, or none when the daemon will not", () => {
    const rows = providerRows(
      {
        "openai-compat": driver("openai-compat", [
          offer("Groq", "https://g.example/v1", false, false),
          compat.offers![1]!,
        ]),
      },
      {},
    );
    expect(rows.map((row) => row.start)).toEqual([
      null,
      { driver: "openai-compat", name: "OpenAI-compatible", settings: {} },
    ]);
    expect(providerRows({ openrouter: drivers.openrouter }, {})[0]?.start).toEqual({
      driver: "openrouter",
      name: "OpenRouter",
      settings: { baseUrl: "https://openrouter.ai/api/v1" },
    });
  });

  it("lists a driver with no offers until a connection uses it", () => {
    const bare = { solo: driver("solo") };
    expect(providerRows(bare, {})).toMatchObject([{ name: "solo", start: { driver: "solo", name: "solo" } }]);
    expect(providerRows(bare, { c: { name: "solo", driver: { name: "solo" } } })).toEqual([]);
  });

  it("lists a driver whose offers cannot be read as one row", () => {
    const broken = {
      get offers(): never {
        throw new Error("offersJson is not valid JSON");
      },
      name: "broken",
      abilityClaim: ["completion"],
    };
    expect(providerRows({ broken }, {})).toMatchObject([{ name: "broken" }]);
  });
});
