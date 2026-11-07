// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completionWires, type ModelWire } from "../model-choice.js";
import { ModelPicker } from "../model-picker.js";

type Props = ComponentProps<typeof ModelPicker>;
const wire = (
  connection: string,
  name: string,
  models = ["same-model"],
  needsAuth = false,
  extraLive: Record<string, unknown> = {},
): ModelWire =>
  completionWires({
    [connection]: {
      id: connection,
      name,
      driver: { abilityClaim: ["completion"] },
      live: {
        models,
        ...(needsAuth ? { auth: "needs-auth", identity: { displayName: "Ada" } } : {}),
        ...extraLive,
      },
    },
  })[0]!;

let container: HTMLDivElement;
let root: Root;
let props: Props;
let opened: Set<HTMLElement>;
let restorePopovers: () => void;
const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = container.querySelector<T>(selector);
  if (node == null) throw new Error(`Missing ${selector}`);
  return node;
};
const menu = () => find<HTMLDivElement>(".model-picker");
const list = () => find<HTMLDivElement>(".model-list");
const search = () => find<HTMLInputElement>('input[role="combobox"]');
const submenu = (name: string) => find<HTMLDivElement>(`.model-submenu[aria-label="${name}"]`);
const option = (name: string) => {
  const node = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) =>
      row.firstElementChild?.textContent === name ||
      row.querySelector(".model-option-title > span")?.textContent === name,
  );
  if (node == null) throw new Error(`Missing option ${name}`);
  return node;
};
const action = (name: string) => {
  const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.textContent === name);
  if (node == null) throw new Error(`Missing button ${name}`);
  return node;
};
const byId = (id: string) => container.querySelector<HTMLElement>(`[id="${id}"]`);
const active = () => {
  const combobox = container.querySelector<HTMLInputElement>('input[role="combobox"]');
  const id = (combobox ?? list()).getAttribute("aria-activedescendant") ?? "";
  return byId(id);
};
async function render(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () => root.render(createElement(ModelPicker, props)));
}
async function click(node: HTMLElement) {
  await act(async () => node.click());
}
async function key(name: string, node: HTMLElement = search(), eventType = "keydown") {
  const event = new KeyboardEvent(eventType, { key: name, bubbles: true, cancelable: true });
  await act(async () => node.dispatchEvent(event));
  return event;
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open() {
  await act(async () => menu().showPopover());
}

// Local event/state doubles only: happy-dom does not implement the native top
// layer. These exercise the picker's toggle handlers, not browser placement,
// light-dismiss, Escape defaults, or automatic focus restoration.
function installPopovers() {
  opened = new Set();
  const prototype = HTMLElement.prototype;
  const names = ["showPopover", "hidePopover", "matches"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(prototype, name));
  const matches = prototype.matches;
  const toggle = (node: HTMLElement, newState: "open" | "closed") => {
    node.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
  };
  const hide = (node: HTMLElement) => {
    if (!opened.delete(node)) return;
    for (const child of opened) if (node.contains(child)) hide(child);
    toggle(node, "closed");
  };
  Object.defineProperties(prototype, {
    matches: {
      configurable: true,
      value(this: HTMLElement, selector: string) {
        return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
      },
    },
    showPopover: {
      configurable: true,
      value(this: HTMLElement) {
        if (opened.has(this)) return;
        if (this.classList.contains("model-submenu")) {
          for (const sibling of opened) {
            if (sibling.classList.contains("model-submenu")) hide(sibling);
          }
        }
        opened.add(this);
        toggle(this, "open");
      },
    },
    hidePopover: {
      configurable: true,
      value(this: HTMLElement) {
        hide(this);
      },
    },
  });
  return () => {
    for (const [index, name] of names.entries()) {
      const descriptor = descriptors[index];
      if (descriptor == null) Reflect.deleteProperty(prototype, name);
      else Object.defineProperty(prototype, name, descriptor);
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  restorePopovers = installPopovers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    wires: [wire("a", "ChatGPT", ["same-model", "fast-model"]), wire("b", "Grok")],
    current: { connection: "a", model: "same-model" },
    disabled: false,
    request: vi.fn(async () => ({ ok: true })),
    onChoose: vi.fn(),
    onLook: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  restorePopovers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("model picker shared-control migration parity", () => {
  it("renders single-line provider rows without usernames or first-level active model name and uses a placeholder-only search", async () => {
    const chatgpt = wire("a", "ChatGPT", ["same-model", "fast-model"], false, {
      identity: { displayName: "Ada Lovelace", plan: "pro" },
      account: {
        balanceDetail: {
          windows: [{ label: "5h", remainingPercent: 62 }],
        },
      },
    });
    const openrouter = wire("b", "OpenRouter", ["nvidia/nemotron-3.5-super"], false, {
      identity: { displayName: "ada_or" },
      account: {
        balance: { balance: "74.75", currency: { code: "USD", symbol: "$" } },
      },
    });
    await render({ wires: [chatgpt, openrouter] });
    const trigger = find<HTMLButtonElement>(".model-trigger");
    expect(trigger.getAttribute("popovertarget")).toBe(menu().id);
    expect(trigger.getAttribute("aria-label")).toBe("Model: Same Model");
    expect(trigger.classList.contains("label")).toBe(true);
    expect(trigger.firstElementChild?.classList.contains("[font-variant-caps:normal]")).toBe(true);
    await open();
    expect(document.activeElement).toBe(search());
    expect(search().placeholder).toBe("Search by model name");
    expect(search().getAttribute("aria-label")).toBe("Search by model name");
    expect(container.querySelector("label")).toBeNull();
    expect(search().getAttribute("aria-describedby")).toBeNull();
    expect(container.textContent).not.toContain("Add a provider");
    expect(container.textContent).not.toContain("Ada Lovelace");
    expect(container.textContent).not.toContain("ada_or");
    expect(option("ChatGPT").getAttribute("aria-selected")).toBe("true");
    expect(option("OpenRouter").getAttribute("aria-selected")).toBe("false");
    expect(option("ChatGPT").textContent).toContain("62% left · 5h");
    expect(option("ChatGPT").textContent).not.toContain("Same Model");
    expect(option("OpenRouter").textContent).toContain("$74.75");
    await type("same");
    expect(
      [...container.querySelectorAll(".model-group-label")].every((node) => !node.classList.contains("label")),
    ).toBe(true);
    await render({ disabled: true });
    expect(trigger.disabled).toBe(true);
  });

  it("instantly shows models for a single provider and only renders search when there are more than 20 models", async () => {
    const smallModels = ["gpt-6.1-sol", "gpt-6-mini"];
    await render({
      wires: [wire("a", "ChatGPT", smallModels)],
      current: { connection: "a", model: "gpt-6-mini" },
    });
    await open();
    expect(container.querySelectorAll(".model-wire")).toHaveLength(0);
    expect(container.querySelector('input[role="combobox"]')).toBeNull();
    expect(document.activeElement).toBe(list());
    expect(active()?.textContent).toContain("GPT 6 Mini");
    await key("ArrowUp", list());
    expect(active()?.textContent).toContain("GPT 6.1 Sol");
    await key("Enter", list());
    expect(props.onChoose).toHaveBeenCalledExactlyOnceWith({ connection: "a", model: "gpt-6.1-sol" });

    const largeModels = Array.from({ length: 21 }, (_, idx) => `gpt-model-${idx + 1}`);
    await render({
      wires: [wire("a", "ChatGPT", largeModels)],
      current: { connection: "a", model: "gpt-model-1" },
    });
    await open();
    expect(container.querySelectorAll(".model-wire")).toHaveLength(0);
    expect(search().placeholder).toBe("Search by model name");
    expect(document.activeElement).toBe(search());
    await type("21");
    expect([...container.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual([
      "GPT Model 21",
    ]);
    await key("Enter");
    expect(props.onChoose).toHaveBeenLastCalledWith({ connection: "a", model: "gpt-model-21" });
  });

  it("renders OpenRouter models grouped by company with icons, dimmed pricing, and badges in both list and active trigger", async () => {
    const openrouter = wire(
      "openrouter",
      "OpenRouter",
      ["nvidia/nemotron-3.5-super", "nvidia/nemotron-3.5-super:free", "cohere/command-a:batch"],
      false,
      {
        modelNames: {
          "nvidia/nemotron-3.5-super": "Nvidia: Nemotron 3.5 Super",
          "nvidia/nemotron-3.5-super:free": "Nvidia: Nemotron 3.5 Super (free)",
        },
        modelPricing: {
          "nvidia/nemotron-3.5-super": { cacheRead: 0.1, prompt: 1, completion: 10 },
          "nvidia/nemotron-3.5-super:free": { prompt: 0, completion: 0 },
          "cohere/command-a:batch": { prompt: 2.5, completion: 10 },
        },
      },
    );
    await render({
      wires: [openrouter],
      current: { connection: "openrouter", model: "nvidia/nemotron-3.5-super:free" },
    });
    const trigger = find<HTMLButtonElement>(".model-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("Model: Nemotron 3.5 Super");
    expect(trigger.querySelector(".model-badge")?.textContent).toBe("free");

    await open();
    const groups = [...container.querySelectorAll<HTMLElement>(".model-group")];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["NVIDIA", "Cohere"]);
    expect(groups[0]?.querySelector('[data-provider-icon="nvidia"]')).not.toBeNull();
    expect(groups[1]?.querySelector('[data-provider-icon="cohere"]')).not.toBeNull();

    const rows = [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => ({
      title: row.querySelector(".model-option-title > span")?.textContent,
      badges: [...row.querySelectorAll(".model-badge")].map((b) => b.textContent),
      pricing: row.querySelector(".model-pricing")?.textContent ?? "",
    }));
    expect(rows).toEqual([
      { title: "Nemotron 3.5 Super", badges: [], pricing: "$0.1/$1/$10" },
      { title: "Nemotron 3.5 Super", badges: ["free"], pricing: "free" },
      { title: "Command-A", badges: ["batch"], pricing: "$2.5/$10" },
    ]);
  });

  it.each(["Enter", " "])("activates shared buttons once with %j and respects disabled actions", async (name) => {
    const request = vi.fn<NonNullable<Props["request"]>>(async () => ({
      form: "ui",
      pending: "reauth",
      body: JSON.stringify({ kind: "open-url", url: "https://login.example.test", description: "Sign in" }),
    }));
    await render({ wires: [wire("expired", "ChatGPT", [], true)], request });
    const trigger = find<HTMLButtonElement>(".model-trigger");
    const activation = vi.fn();
    trigger.addEventListener("click", activation);
    await act(async () => trigger.focus());
    await key(name, trigger);
    await key(name, trigger, "keyup");
    expect(activation).toHaveBeenCalledTimes(1);
    await open();
    await key("ArrowRight");
    const signin = action("Sign in again");
    await act(async () => signin.focus());
    await key(name, signin);
    await key(name, signin, "keyup");
    expect(request).toHaveBeenCalledExactlyOnceWith("connect/login", { id: "expired" });
    await click(action("Cancel"));
    await render({ request: null, disabled: true });
    await key(name, trigger);
    await key(name, trigger, "keyup");
    expect(activation).toHaveBeenCalledTimes(1);
    await key("ArrowRight");
    const disabledSignIn = action("Sign in again");
    const calls = request.mock.calls.length;
    await key(name, disabledSignIn);
    await key(name, disabledSignIn, "keyup");
    expect(request.mock.calls).toHaveLength(calls);
  });

  it("keeps focus in search, selected markers and exact connection/model identity", async () => {
    await render({ current: { connection: "b", model: "same-model" } });
    await open();
    expect(active()).toBe(option("Grok"));
    const right = await key("ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(opened.has(submenu("Grok"))).toBe(true);
    expect(search().getAttribute("aria-controls")).toBe(submenu("Grok").id);
    expect(active()?.getAttribute("aria-selected")).toBe("true");
    expect(active()?.querySelector("svg")).not.toBeNull();
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => active()!.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search());
    await key("Enter");
    expect(props.onChoose).toHaveBeenCalledExactlyOnceWith({ connection: "b", model: "same-model" });
    expect(opened.size).toBe(0);
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
  });

  it("clamps navigation and searches natural model names across connections", async () => {
    await render();
    await open();
    await key("ArrowRight");
    await key("End");
    expect(active()?.textContent).toBe("Fast Model");
    await key("ArrowDown");
    expect(active()?.textContent).toBe("Fast Model");
    await key("Home");
    await key("ArrowUp");
    expect(active()?.textContent).toBe("Same Model");
    await type("same model");
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    expect(search().getAttribute("aria-controls")).toBe(find(".model-list").id);
    await key("ArrowDown");
    expect(active()?.getAttribute("aria-selected")).toBe("false");
    await key("Enter");
    expect(props.onChoose).toHaveBeenCalledExactlyOnceWith({ connection: "b", model: "same-model" });
  });

  it("preserves nested close handling and native model Escape", async () => {
    await render();
    await open();
    await key("ArrowRight");
    await key("ArrowLeft");
    expect(opened.has(menu())).toBe(true);
    expect(active()).toBe(option("ChatGPT"));
    expect(document.activeElement).toBe(search());
    await type("same");
    const nativeEscape = await key("Escape");
    expect(nativeEscape.defaultPrevented).toBe(false);
    await act(async () => menu().hidePopover());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    await open();
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(search());
  });

  it("opens provider submenus immediately on hover and switches sibling submenus", async () => {
    await render();
    await open();
    const point = async (name: string, event: string) =>
      act(async () => {
        option(name).dispatchEvent(new PointerEvent(event, { bubbles: true }));
      });
    await point("ChatGPT", "pointerover");
    expect(opened.has(submenu("ChatGPT"))).toBe(true);
    await point("Grok", "pointerover");
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    expect(opened.has(submenu("Grok"))).toBe(true);
    expect(opened.has(menu())).toBe(true);
    await act(async () => menu().hidePopover());
    expect(opened.size).toBe(0);
  });

  it("subscribes to wires only, refreshing and releasing the look", async () => {
    await render();
    expect(props.onLook).not.toHaveBeenCalled();
    await open();
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b"], []);
    const calls = vi.mocked(props.onLook).mock.calls.length;
    await type("gro");
    expect(vi.mocked(props.onLook).mock.calls).toHaveLength(calls);
    await render({ wires: [...props.wires, wire("c", "Local")] });
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b", "c"], []);
    await act(async () => menu().hidePopover());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    await open();
    act(() => root.unmount());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    root = createRoot(container);
  });

  it("keeps auth recovery searchable by provider name, cached models hidden, and disables actions offline", async () => {
    await render({ wires: [wire("expired", "ChatGPT", ["stale-model"], true)], request: null });
    await open();
    expect(option("ChatGPT").textContent).not.toContain("Ada");
    await type("chatgpt");
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    await key("Enter");
    expect(search().value).toBe("");
    expect(search().getAttribute("aria-haspopup")).toBe("menu");
    expect(submenu("ChatGPT").textContent).not.toContain("Stale Model");
    expect(action("Sign in again").disabled).toBe(true);
    expect(action("Delete").disabled).toBe(true);
    await key("Enter");
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("retains delete failure/retry, pending guards and an associated persistent error", async () => {
    const request = vi.fn<NonNullable<Props["request"]>>();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render({ wires: [wire("expired", "ChatGPT", [], true)], request });
    await open();
    await key("ArrowRight");
    await key("End");
    await key("Enter");
    expect(action("Deleting…").disabled).toBe(true);
    expect(action("Sign in again").disabled).toBe(true);
    await key("Enter");
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false }));
    const error = find('[role="alert"]');
    expect(error.textContent).toBe("Could not delete the provider. Try again.");
    expect(search().getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    expect(search().getAttribute("aria-invalid")).toBeNull();
    expect(action("Delete").disabled).toBe(false);
    request.mockResolvedValueOnce({ ok: true });
    await click(action("Delete"));
    expect(request).toHaveBeenLastCalledWith("connect/drop", { id: "expired", confirm: true });
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it.each([{ ok: true }, { ok: false }])(
    "keeps a reopened picker independent of an earlier provider deletion (%j)",
    async (reply) => {
      let finish!: (value: unknown) => void;
      const request = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await render({ wires: [wire("expired", "ChatGPT", [], true), wire("b", "Grok")], request });
      await open();
      await key("ArrowRight");
      await click(action("Delete"));
      await act(async () => menu().hidePopover());
      await open();
      await click(option("Grok"));
      const current = search().getAttribute("aria-activedescendant");
      await act(async () => finish(reply));
      expect({
        grokOpen: opened.has(submenu("Grok")),
        active: search().getAttribute("aria-activedescendant"),
        hasChoice: submenu("Grok").textContent.includes("Same Model"),
        notice: container.querySelector('[role="alert"]'),
      }).toEqual({ grokOpen: true, active: current, hasChoice: true, notice: null });
    },
  );

  it("keeps auth button arrow navigation and reconnect/cancel on the existing port", async () => {
    const request = vi.fn(async () => ({
      form: "ui",
      pending: "reauth",
      body: JSON.stringify({ kind: "open-url", url: "https://login.example.test", description: "Sign in" }),
    }));
    await render({ wires: [wire("expired", "ChatGPT", [], true)], request });
    await open();
    await key("ArrowRight");
    await act(async () => action("Sign in again").focus());
    const down = await key("ArrowDown", action("Sign in again"));
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(action("Delete"));
    await key("Home", action("Delete"));
    expect(document.activeElement).toBe(action("Sign in again"));
    await click(action("Sign in again"));
    expect(request).toHaveBeenCalledExactlyOnceWith("connect/login", { id: "expired" });
    expect(container.querySelector(".model-search")).toBeNull();
    await click(action("Cancel"));
    expect(request).toHaveBeenLastCalledWith("ui/resolve", { pending: "reauth", kind: "cancel" });
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    expect(document.activeElement).toBe(search());
  });

  it("releases an auth park as soon as the native picker is dismissed", async () => {
    const request = vi.fn(async (method: string) =>
      method === "connect/login"
        ? {
            form: "ui",
            pending: "dismissed-auth",
            body: JSON.stringify({ kind: "input", name: "API key" }),
          }
        : { ok: false },
    );
    await render({ wires: [wire("expired", "ChatGPT", [], true)], request });
    await open();
    await key("ArrowRight");
    await click(action("Sign in again"));
    await act(async () => menu().hidePopover());
    expect(request).toHaveBeenLastCalledWith("ui/resolve", { pending: "dismissed-auth", kind: "cancel" });
    await open();
    expect({ flow: container.querySelector(".connect-step"), active: active()?.textContent }).toEqual({
      flow: null,
      active: expect.stringContaining("ChatGPT"),
    });
  });
});
