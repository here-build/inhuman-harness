// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Splash } from "../splash.js";

const offer = (name: string, baseUrl: string | null, live: boolean, description = name) => ({
  name,
  description,
  live,
  adoptable: true,
  settings: baseUrl == null ? {} : { baseUrl },
});
const driver = (name: string, offers: readonly object[]) => ({
  name,
  description: name,
  abilityClaim: ["completion"],
  offers,
});

const compat = (local: readonly object[]) =>
  driver("openai-compat", [
    ...local,
    offer("OpenAI-compatible", null, false, "Any OpenAI-compatible endpoint"),
    offer("OpenAI", "https://api.openai.com/v1", false),
    offer("Groq", "https://api.groq.com/openai/v1", false),
    offer("Mistral", "https://api.mistral.ai/v1", false),
  ]);

const drivers = (local: readonly object[] = []) => ({
  "openai-compat": compat(local),
  nous: driver("nous", [offer("Nous Portal", "https://inference-api.nousresearch.com/v1", true, "Nous inference")]),
  grok: driver("grok", [offer("Grok", "https://cli-chat-proxy.grok.com/v1", true, "Grok subscription")]),
  openrouter: driver("openrouter", [offer("OpenRouter", "https://openrouter.ai/api/v1", true, "OpenRouter API")]),
  chatgpt: driver("chatgpt", [offer("ChatGPT", "https://chatgpt.com/backend-api/codex", true, "ChatGPT subscription")]),
});

const state = vi.hoisted(() => ({ dial: null as unknown }));

class SplashDial {
  attaching = false;
  link = null;
  sessionRpc: { request: ReturnType<typeof vi.fn> } | null = null;
  kernelRpc: { request: ReturnType<typeof vi.fn> } | null = { request: vi.fn(async () => ({ ok: false })) };
  kernel = { root: { drivers: drivers() as Record<string, unknown>, connections: {} } };
  readonly look = vi.fn();

  constructor() {
    makeObservable(this, {
      attaching: observable,
      sessionRpc: observable.ref,
      kernelRpc: observable.ref,
      kernel: observable,
    });
  }
}

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

const dial = () => state.dial as SplashDial;

let container: HTMLDivElement;
let root: Root;

const names = (cluster: string) =>
  [...container.querySelectorAll(`.cluster[data-group="${cluster}"] .tile-name`)].map((node) => node.textContent);
const labels = () => [...container.querySelectorAll(".cluster h2")].map((node) => node.textContent);
const tile = (name: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button.tile")].find(
    (node) => node.querySelector(".tile-name")?.textContent === name,
  );
  if (found == null) throw new Error(`no tile ${name}`);
  return found;
};
const search = () => container.querySelector<HTMLInputElement>('input[type="search"]');
async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render() {
  await act(async () => {
    root.render(createElement(Splash));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.dial = new SplashDial();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("first-run splash", () => {
  it("clusters the providers, subscriptions first", async () => {
    await render();
    expect(labels()).toEqual(["Subscriptions", "Gateways", "On this machine", "Custom endpoint", "With an API key"]);
    expect(names("subscription")).toEqual(["ChatGPT", "Grok"]);
    expect(names("gateway")).toEqual(["OpenRouter", "Nous Portal"]);
    expect(names("custom")).toEqual(["OpenAI-compatible"]);
    expect(names("key")).toEqual(["OpenAI", "Groq", "Mistral"]);
    expect(container.querySelector("h1")?.textContent).toBe("Connect a model");
  });

  it("sizes tiles by cluster and tells a plan how it signs in", async () => {
    await render();
    const size = (cluster: string) =>
      container.querySelector<HTMLElement>(`.cluster[data-group="${cluster}"] .tiles`)?.dataset.size;
    expect([size("subscription"), size("gateway"), size("key")]).toEqual(["large", "medium", "small"]);
    expect(tile("ChatGPT").textContent).toContain("Sign in through the browser");
    expect(tile("ChatGPT").textContent).toContain("Uses your ChatGPT plan");
    // The dense tiles carry the name; the rest is a tooltip, not clutter.
    expect(tile("Groq").textContent).toBe("Groq");
  });

  it("says nothing is detected, quietly, then shows servers as they are found", async () => {
    await render();
    expect(container.querySelector('.cluster[data-group="local"] .cluster-note')?.textContent).toBe(
      "Start Ollama or LM Studio and it shows up here.",
    );
    expect(names("local")).toEqual([]);

    await act(async () => {
      runInAction(() => {
        dial().kernel.root.drivers = drivers([
          offer("Ollama", "http://127.0.0.1:11434/v1", true, "Local OpenAI-compat :11434"),
        ]);
      });
    });
    expect(names("local")).toEqual(["Ollama"]);
    expect(container.querySelector('.cluster[data-group="local"] .cluster-note')).toBeNull();
    expect(tile("Ollama").textContent).toContain("Running: Ollama");
    expect(tile("Ollama").textContent).toContain("localhost:11434");
    expect(tile("Ollama").querySelector(".live-dot")).not.toBeNull();
  });

  it("looks at the drivers while it is open and lets go when it is not", async () => {
    await render();
    expect(dial().look.mock.lastCall).toEqual([[], ["chatgpt", "grok", "openrouter", "nous", "openai-compat"]]);
    await act(async () => {
      root.render(createElement("div"));
    });
    expect(dial().look.mock.lastCall).toEqual([[], []]);
  });

  it("filters the API-key providers, and Enter takes the only match", async () => {
    await render();
    const field = search();
    if (field == null) throw new Error("no search");
    expect(field.getAttribute("aria-label")).toBe("Search providers that take an API key");
    await type(field, "gr");
    expect(names("key")).toEqual(["Groq"]);
    // Subscriptions are not filtered away: the search is the key cluster's.
    expect(names("subscription")).toEqual(["ChatGPT", "Grok"]);
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(dial().kernelRpc?.request).toHaveBeenCalledWith("connect/adopt", {
      driver: "openai-compat",
      name: "Groq",
      settings: { baseUrl: "https://api.groq.com/openai/v1" },
    });

    await act(async () => {
      root.render(createElement("div"));
    });
    await render();
    const again = search();
    if (again == null) throw new Error("no search");
    await type(again, "zzz");
    expect(container.querySelector('.cluster[data-group="key"] .cluster-note')?.textContent).toBe(
      "No provider matches.",
    );
  });

  it("runs the flow in place of the grid, on the kernel port, and returns focus on cancel", async () => {
    dial().kernelRpc = {
      request: vi.fn(async (method: string) =>
        method === "connect/adopt"
          ? { form: "ui", pending: "p1", body: '(harness/input :name "API key" :secret #t)' }
          : { ok: false },
      ),
    };
    await render();
    await click(tile("Groq"));
    expect(dial().kernelRpc?.request).toHaveBeenCalledWith("connect/adopt", {
      driver: "openai-compat",
      name: "Groq",
      settings: { baseUrl: "https://api.groq.com/openai/v1" },
    });
    expect(container.querySelector(".connect-step")).not.toBeNull();
    expect(container.querySelector(".splash-clusters")).toBeNull();
    expect(container.querySelector("label")?.textContent).toBe("API key");

    const cancel = [...container.querySelectorAll("button")].find((node) => node.textContent === "Cancel");
    if (cancel == null) throw new Error("no cancel");
    await click(cancel);
    expect(container.querySelector(".connect-step")).toBeNull();
    expect(document.activeElement).toBe(tile("Groq"));
  });

  it("uses the session's port where a session is open", async () => {
    dial().sessionRpc = { request: vi.fn(async () => ({ ok: false })) };
    await render();
    await click(tile("Groq"));
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("connect/adopt", expect.objectContaining({ name: "Groq" }));
    expect(dial().kernelRpc?.request).not.toHaveBeenCalled();
  });

  it("disables the tiles where no port can carry a flow", async () => {
    dial().kernelRpc = null;
    await render();
    expect(tile("ChatGPT").disabled).toBe(true);
    expect(tile("Groq").disabled).toBe(true);
  });

  it("says it is connected while the kernel catches up", async () => {
    dial().kernelRpc = { request: vi.fn(async () => ({ id: "chatgpt" })) };
    await render();
    await click(tile("ChatGPT"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Connected. Opening your workspace");
    expect(container.querySelector('[role="status"]')?.hasAttribute("data-waiting")).toBe(false);
    expect(container.querySelector(".link-glyph")?.hasAttribute("data-waiting")).toBe(false);
    expect(container.querySelector(".link-glyph")?.hasAttribute("data-settled")).toBe(true);
  });
});
