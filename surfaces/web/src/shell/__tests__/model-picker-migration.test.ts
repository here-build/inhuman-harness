// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completionWires, type ModelWire } from "../model-choice.js";
import { ModelPicker } from "../model-picker.js";
import type { ProviderRow } from "../provider-list.js";

type Props = ComponentProps<typeof ModelPicker>;
const wire = (connection: string, name: string, models = ["same-model"], needsAuth = false): ModelWire =>
  completionWires({
    [connection]: {
      id: connection,
      name,
      driver: { abilityClaim: ["completion"] },
      live: { models, ...(needsAuth ? { auth: "needs-auth", identity: { displayName: "Ada" } } : {}) },
    },
  })[0]!;
const provider = (name: string, driver = "compat", start = true): ProviderRow => ({
  key: name,
  driver,
  name,
  description: `${name} provider`,
  group: "key",
  hint: "API key",
  start: start ? { driver, name, settings: { baseUrl: "https://example.test/v1" } } : null,
});

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
const search = () => find<HTMLInputElement>('input[role="combobox"]');
const submenu = (name: string) => find<HTMLDivElement>(`.model-submenu[aria-label="${name}"]`);
const option = (name: string) => {
  const node = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) => row.firstElementChild?.textContent === name,
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
const active = () => byId(search().getAttribute("aria-activedescendant") ?? "");
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
    providers: [provider("Groq"), provider("Mistral"), provider("Unavailable", "other", false)],
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
  it("keeps a native target and persistent label/help, with commands distinct from names", async () => {
    await render();
    const trigger = find<HTMLButtonElement>(".model-trigger");
    expect(trigger.getAttribute("popovertarget")).toBe(menu().id);
    expect(trigger.getAttribute("aria-label")).toBe("Model: Same Model");
    expect(trigger.classList.contains("label")).toBe(true);
    expect(trigger.firstElementChild?.classList.contains("[font-variant-caps:normal]")).toBe(true);
    await open();
    expect(document.activeElement).toBe(search());
    expect(search().classList.contains("rounded-none")).toBe(true);
    expect(find<HTMLLabelElement>("label").htmlFor).toBe(search().id);
    expect(find("label").textContent).toBe("Search models");
    expect(byId(search().getAttribute("aria-describedby")!)?.textContent).toContain("Right");
    expect(option("Add a provider").firstElementChild?.classList.contains("label")).toBe(true);
    await type("same");
    expect(find("label").textContent).toBe("Search models");
    expect(
      [...container.querySelectorAll(".model-group-label")].every((node) => !node.classList.contains("label")),
    ).toBe(true);
    await render({ disabled: true });
    expect(trigger.disabled).toBe(true);
  });

  it.each(["Enter", " "])("activates shared buttons once with %j and respects disabled actions", async (name) => {
    const request = vi.fn<NonNullable<Props["request"]>>(async () => ({
      form: "ui",
      pending: "reauth",
      body: '(harness/open-url :url "https://login.example.test" :description "Sign in")',
    }));
    await render({ wires: [wire("expired", "ChatGPT", [], true)], request });
    const trigger = find<HTMLButtonElement>(".model-trigger");
    const activation = vi.fn();
    trigger.addEventListener("click", activation);
    await act(async () => trigger.focus());
    await key(name, trigger);
    await key(name, trigger, "keyup");
    expect(activation).toHaveBeenCalledTimes(1);
    // happy-dom does not execute the browser's popoverTarget default action.
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

  it("preserves nested close handling, provider back/Escape, and native model Escape", async () => {
    await render();
    await open();
    await key("ArrowRight");
    await key("ArrowLeft");
    expect(opened.has(menu())).toBe(true);
    expect(active()).toBe(option("ChatGPT"));
    expect(document.activeElement).toBe(search());
    await click(option("Add a provider"));
    await type("gro");
    expect(find("label").textContent).toBe("Search providers");
    const escape = await key("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(search().value).toBe("");
    expect(find("label").textContent).toBe("Search models");
    const nativeEscape = await key("Escape");
    expect(nativeEscape.defaultPrevented).toBe(false);
    await act(async () => menu().hidePopover());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    await open();
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(search());
  });

  it("retains delayed provider hover, cancellation, and sibling submenu switching", async () => {
    vi.useFakeTimers();
    await render();
    await open();
    const point = async (name: string, event: string) =>
      act(async () => {
        option(name).dispatchEvent(new PointerEvent(event, { bubbles: true }));
      });
    await point("ChatGPT", "pointerover");
    await act(async () => vi.advanceTimersByTime(119));
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    await point("ChatGPT", "pointerout");
    await act(async () => vi.advanceTimersByTime(1));
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    await point("ChatGPT", "pointerover");
    await act(async () => vi.advanceTimersByTime(120));
    expect(opened.has(submenu("ChatGPT"))).toBe(true);
    await point("Grok", "pointerover");
    await act(async () => vi.advanceTimersByTime(120));
    expect(opened.has(submenu("ChatGPT"))).toBe(false);
    expect(opened.has(submenu("Grok"))).toBe(true);
    expect(opened.has(menu())).toBe(true);
    await point("ChatGPT", "pointerover");
    await act(async () => menu().hidePopover());
    await act(async () => vi.advanceTimersByTime(120));
    expect(opened.size).toBe(0);
  });

  it("subscribes to wires and listed offer drivers only, refreshing and releasing the look", async () => {
    await render();
    expect(props.onLook).not.toHaveBeenCalled();
    await open();
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b"], []);
    await click(option("Add a provider"));
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b"], ["compat", "other"]);
    const calls = vi.mocked(props.onLook).mock.calls.length;
    await type("gro");
    expect(vi.mocked(props.onLook).mock.calls).toHaveLength(calls);
    await render({ wires: [...props.wires, wire("c", "Local")] });
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b", "c"], ["compat", "other"]);
    await key("Escape");
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b", "c"], []);
    await act(async () => menu().hidePopover());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    await open();
    act(() => root.unmount());
    expect(props.onLook).toHaveBeenLastCalledWith([], []);
    root = createRoot(container);
  });

  it("keeps non-adoptable providers inert and hides connect offers without a request port", async () => {
    await render();
    await open();
    await click(option("Add a provider"));
    expect(option("Unavailable").getAttribute("aria-disabled")).toBe("true");
    await click(option("Unavailable"));
    expect(props.request).not.toHaveBeenCalled();
    await key("End");
    await key("Enter");
    expect(props.request).not.toHaveBeenCalled();
    await key("Escape");
    await render({ request: null });
    expect(container.textContent).not.toContain("Add a provider");
    await type("missing");
    expect(find('[role="status"]').textContent).toBe("No models match");
    expect(props.onChoose).not.toHaveBeenCalled();
  });

  it("keeps auth recovery searchable, cached models hidden, and disables actions offline", async () => {
    await render({ wires: [wire("expired", "ChatGPT", ["stale-model"], true)], request: null });
    await open();
    expect(option("ChatGPT").textContent).toContain("Ada");
    await type("ada");
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
    expect(search().getAttribute("aria-invalid")).toBeNull(); // RPC failure, not invalid search text.
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
        hasChoice: submenu("Grok").textContent?.includes("Same Model"),
        notice: container.querySelector('[role="alert"]'),
      }).toEqual({ grokOpen: true, active: current, hasChoice: true, notice: null });
    },
  );

  it("keeps auth button arrow navigation and reconnect/cancel on the existing port", async () => {
    const request = vi.fn(async () => ({
      form: "ui",
      pending: "reauth",
      body: '(harness/open-url :url "https://login.example.test" :description "Sign in")',
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
            body: '(harness/input :name "API key")',
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

  it("starts a searched offer, cancels to providers, then opens the newly loaded catalog", async () => {
    const request = vi.fn<NonNullable<Props["request"]>>(async () => ({
      form: "ui",
      pending: "connect",
      body: '(harness/input :name "API key" :description "Enter key")',
    }));
    await render({ request });
    await open();
    await type("groq");
    await key("Enter");
    expect(request).toHaveBeenCalledWith("connect/adopt", {
      driver: "compat",
      name: "Groq",
      settings: { baseUrl: "https://example.test/v1" },
    });
    expect(container.querySelector(".connect-step")).not.toBeNull();
    expect(container.querySelector(".model-search")).toBeNull();
    expect(props.onLook).toHaveBeenLastCalledWith(["a", "b"], []);
    await click(action("Cancel"));
    expect(find("label").textContent).toBe("Search providers");
    expect(document.activeElement).toBe(search());
    request.mockResolvedValueOnce({ id: "new" });
    await click(option("Groq"));
    expect(find('[role="status"]').textContent).toBe("Connected. Loading its models…");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    await render({ wires: [...props.wires, wire("new", "New provider", ["new-model"])] });
    expect(container.textContent).not.toContain("Connected. Loading its models");
    expect(opened.has(submenu("New provider"))).toBe(true);
    expect(active()?.textContent).toBe("New Model");
    await key("Enter");
    expect(props.onChoose).toHaveBeenCalledExactlyOnceWith({ connection: "new", model: "new-model" });
  });
});
