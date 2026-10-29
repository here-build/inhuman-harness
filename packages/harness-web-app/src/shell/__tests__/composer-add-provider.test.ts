// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";

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

const DRIVERS = {
  "openai-compat": driver("openai-compat", [
    offer("Ollama", "http://127.0.0.1:11434/v1", true),
    offer("OpenAI-compatible", null, false),
    offer("Groq", "https://api.groq.com/openai/v1", false),
    offer("Mistral", "https://api.mistral.ai/v1", false),
  ]),
  chatgpt: driver("chatgpt", [offer("ChatGPT", "https://chatgpt.com/backend-api/codex", true, "ChatGPT subscription")]),
  grok: driver("grok", [offer("Grok", "https://cli-chat-proxy.grok.com/v1", true, "Grok subscription")]),
};

type Face = { id: string; name: string; driver: { name: string; abilityClaim: string[] }; live: { models: string[] } };
const face = (id: string, name: string, models: string[]): Face => ({
  id,
  name,
  driver: { name: id, abilityClaim: ["completion"] },
  live: { models },
});

const state = vi.hoisted(() => ({ dial: null as unknown }));

class ConnectedDial {
  attaching = false;
  link = null;
  sessionRpc: { request: ReturnType<typeof vi.fn> } | null = { request: vi.fn(async () => ({ ok: true })) };
  kernelRpc: { request: ReturnType<typeof vi.fn> } | null = { request: vi.fn(async () => ({ ok: true })) };
  kernel = {
    root: {
      approvalAskThrottleMs: 0,
      drivers: DRIVERS as Record<string, unknown>,
      connections: { chatgpt: face("chatgpt", "ChatGPT", ["gpt-6.1-sol"]) } as Record<string, Face>,
    },
  };
  session: {
    root: {
      uuid: string;
      sessionId: string;
      head: object | null;
      findRunningTurn: () => null;
      kvs: { connection: string; model: string };
    };
  } | null = {
    root: {
      uuid: "root:fresh",
      sessionId: "fresh",
      head: null,
      findRunningTurn: () => null,
      kvs: observable({ connection: "", model: "" }),
    },
  };
  readonly look = vi.fn();

  constructor() {
    makeObservable(this, {
      attaching: observable,
      sessionRpc: observable.ref,
      kernelRpc: observable.ref,
      kernel: observable,
      session: observable.ref,
    });
  }
}

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

const dial = () => state.dial as ConnectedDial;

let container: HTMLDivElement;
let root: Root;

const rows = () =>
  [...container.querySelectorAll('[role="option"].provider-option')].map((node) => node.firstElementChild?.textContent);
const trigger = () => container.querySelector<HTMLButtonElement>(".model-trigger");
const option = (name: string) => {
  const found = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.firstElementChild?.textContent === name,
  );
  if (found == null) throw new Error(`no row ${name}`);
  return found;
};
async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function toggle(newState: "open" | "closed") {
  const menu = container.querySelector(".model-picker");
  if (menu == null) throw new Error("menu missing");
  await act(async () => {
    menu.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
  });
}
const search = () => container.querySelector<HTMLInputElement>('input[role="combobox"]');
async function type(value: string) {
  const field = search();
  if (field == null) throw new Error("no search");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(node: Element, name: string) {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}
async function render() {
  await act(async () => {
    root.render(createElement(Composer));
  });
}

for (const name of ["showPopover", "hidePopover"] as const) {
  if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { value: () => undefined });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.dial = new ConnectedDial();
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

describe("adding a provider from the model picker", () => {
  it("keeps the list one row away, minus what is adopted", async () => {
    await render();
    expect(trigger()?.textContent).toContain("Choose a model");
    await toggle("open");
    expect(search()?.getAttribute("aria-label")).toBe("Search models");
    // Providers only show behind the row.
    expect(rows()).toEqual([]);
    const add = [...container.querySelectorAll('[role="option"]')].at(-1);
    expect(add?.textContent).toBe("Add a provider");
    await click(option("Add a provider"));
    expect(rows()).toEqual(["Grok", "Ollama", "Groq", "Mistral", "OpenAI-compatible"]);
    const groups = [...container.querySelectorAll(".model-group-label")].map((node) => node.textContent);
    expect(groups).toEqual(["Subscriptions", "On this machine", "With an API key", "Custom endpoint"]);
    expect(search()?.getAttribute("aria-label")).toBe("Search providers");
    // Wires stay in view, and the drivers whose offers are listed join them.
    expect(dial().look.mock.lastCall).toEqual([["chatgpt"], ["grok", "openai-compat"]]);

    // Esc steps back to the models before it closes the menu.
    const field = search();
    if (field == null) throw new Error("no search");
    await key(field, "Escape");
    expect(rows()).toEqual([]);
    expect(search()?.getAttribute("aria-label")).toBe("Search models");
    expect(dial().look.mock.lastCall).toEqual([["chatgpt"], []]);
  });

  it("filters the providers as you type", async () => {
    await render();
    await toggle("open");
    await click(option("Add a provider"));
    await type("m");
    expect(rows()).toEqual(["Ollama", "Mistral", "OpenAI-compatible"]);
    await type("zzz");
    expect(rows()).toEqual([]);
    expect(container.textContent).toContain("No providers match");
  });

  it("reaches providers from a search among models", async () => {
    await render();
    await toggle("open");
    await type("gro");
    expect(rows()).toEqual(["Grok", "Groq"]);
    expect(container.textContent).toContain("Add a provider");
    await click(option("Groq"));
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("connect/adopt", expect.objectContaining({ name: "Groq" }));
  });

  it("starts the flow on the session's own port and shows nothing else beside it", async () => {
    await render();
    await toggle("open");
    await click(option("Add a provider"));
    await click(option("Groq"));
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("connect/adopt", {
      driver: "openai-compat",
      name: "Groq",
      settings: { baseUrl: "https://api.groq.com/openai/v1" },
    });
    expect(dial().kernelRpc?.request).not.toHaveBeenCalled();
    expect(container.querySelector(".connect-step")).not.toBeNull();
    expect(container.querySelector(".model-search")).toBeNull();
    // Out of the list, the drivers are no longer in view.
    expect(dial().look.mock.lastCall).toEqual([["chatgpt"], []]);
  });

  it("returns to the list when the flow is cancelled", async () => {
    await render();
    await toggle("open");
    await click(option("Add a provider"));
    await click(option("Groq"));
    const cancel = [...container.querySelectorAll("button")].find((node) => node.textContent === "Cancel");
    if (cancel == null) throw new Error("no cancel");
    await click(cancel);
    expect(rows()).toContain("Groq");
    expect(container.querySelector(".connect-step")).toBeNull();
  });

  it("waits for a new connection's models, then goes back to the models", async () => {
    dial().sessionRpc?.request.mockImplementation(async () => ({ id: "grok" }));
    await render();
    await toggle("open");
    await click(option("Add a provider"));
    await click(option("Grok"));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Connected. Loading its models");
    expect(container.querySelector(".connect-step")).toBeNull();

    await act(async () => {
      runInAction(() => {
        dial().kernel.root.connections = {
          ...dial().kernel.root.connections,
          grok: face("grok", "Grok", ["grok-4.7"]),
        };
      });
    });
    expect([...container.querySelectorAll(".model-wire")].map((node) => node.firstElementChild?.textContent)).toEqual([
      "ChatGPT",
      "Grok",
    ]);
    expect(container.textContent).not.toContain("Loading its models");
  });
});
