// @vitest-environment happy-dom

import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ModelPickerBlock,
  wireAccount,
  type ConnectRpcRequest,
  type ModelPickerBlockProps,
  type ModelWireItem,
} from "../index.js";

function wire(
  connection: string,
  name: string,
  models: readonly string[] = ["same-model"],
  options: {
    readonly needsAuth?: boolean;
    readonly openrouter?: boolean;
    readonly modelPricing?: ModelWireItem["modelPricing"];
  } = {},
): ModelWireItem {
  return {
    connection,
    name,
    choices: models.map((model) => ({ connection, model })),
    account: wireAccount(
      {
        readyState: "ready",
        live: options.needsAuth ? { auth: "needs-auth", identity: { displayName: "Ada" } } : {},
      },
      name,
    ),
    ...(options.openrouter ? { openrouter: true } : {}),
    ...(options.modelPricing ? { modelPricing: options.modelPricing } : {}),
  };
}

let container: HTMLDivElement;
let root: Root;
let opened: Set<HTMLElement>;
let restorePopovers: () => void;

function installPopovers(): () => void {
  opened = new Set();
  const prototype = HTMLElement.prototype;
  const names = ["showPopover", "hidePopover", "matches"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(prototype, name));
  const nativeMatches = descriptors[2]?.value as ((this: HTMLElement, selector: string) => boolean) | undefined;

  const dispatchToggle = (node: HTMLElement, newState: "open" | "closed") => {
    node.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
  };
  const hide = (node: HTMLElement) => {
    if (!opened.delete(node)) return;
    for (const child of opened) {
      if (node.contains(child)) hide(child);
    }
    dispatchToggle(node, "closed");
  };

  Object.defineProperties(prototype, {
    matches: {
      configurable: true,
      value(this: HTMLElement, selector: string) {
        if (selector === ":popover-open") return opened.has(this);
        return nativeMatches?.call(this, selector) ?? false;
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
        dispatchToggle(this, "open");
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
      if (descriptor === undefined) Reflect.deleteProperty(prototype, name);
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  restorePopovers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function baseProps(overrides: Partial<ModelPickerBlockProps> = {}): ModelPickerBlockProps {
  return {
    wires: [wire("a", "ChatGPT", ["same-model", "fast-model"]), wire("b", "Grok")],
    current: { connection: "a", model: "same-model" },
    disabled: false,
    request: vi.fn<ConnectRpcRequest>(async () => ({ ok: true })),
    onChoose: vi.fn(),
    onLook: vi.fn(),
    ...overrides,
  };
}

function findNode<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = container.querySelector<T>(selector);
  if (node == null) throw new Error(`Missing node matching ${selector}`);
  return node;
}

const menu = () => findNode<HTMLDivElement>(".model-picker");
const list = () => findNode<HTMLDivElement>(".model-list");
const combobox = () => findNode<HTMLInputElement>('input[role="combobox"]');
const submenu = (name: string) => findNode<HTMLDivElement>(`.model-submenu[aria-label="${name}"]`);

function optionByText(label: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (row) =>
      row.firstElementChild?.textContent === label ||
      row.querySelector(".model-option-title > span")?.textContent === label,
  );
  if (match == null) throw new Error(`Missing option ${label}`);
  return match;
}

function buttonByText(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((btn) => btn.textContent === label);
  if (match == null) throw new Error(`Missing button ${label}`);
  return match;
}

async function openPicker() {
  await interact(() => menu().showPopover());
}

async function pressKey(key: string, target: HTMLElement) {
  await interact(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function typeSearch(value: string) {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(combobox(), value);
    combobox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ModelPickerBlock", () => {
  it("gates search at >20 single-provider models and renders OpenRouter groups, badges, and pricing", async () => {
    const onChoose = vi.fn();
    const render = (element: ReactNode) => interact(() => root.render(element));

    await render(
      h(
        ModelPickerBlock,
        baseProps({
          wires: [wire("small", "SmallProvider", ["m-1", "m-2", "m-3"])],
          current: { connection: "small", model: "m-1" },
          onChoose,
        }),
      ),
    );
    await openPicker();
    const smallSearchPresent = container.querySelector('input[role="combobox"]') !== null;

    const manyModels = Array.from({ length: 21 }, (_, idx) => `vendor/model-${idx + 1}`);
    const openrouterWire = wire(
      "or",
      "OpenRouter",
      ["nvidia/nemotron-3.5-super:free", "anthropic/claude-3.7-sonnet", ...manyModels.slice(2)],
      {
        openrouter: true,
        modelPricing: {
          "nvidia/nemotron-3.5-super:free": { prompt: 0, completion: 0 },
          "anthropic/claude-3.7-sonnet": { prompt: 3, completion: 15 },
        },
      },
    );

    await render(
      h(
        ModelPickerBlock,
        baseProps({
          wires: [openrouterWire],
          current: { connection: "or", model: "anthropic/claude-3.7-sonnet" },
          onChoose,
        }),
      ),
    );
    await openPicker();

    const largeSearchPresent = container.querySelector('input[role="combobox"]') !== null;
    const groups = [...container.querySelectorAll<HTMLElement>('[role="group"]')].map((g) =>
      g.getAttribute("aria-label"),
    );
    const freeRow = optionByText("Nemotron 3.5 Super");
    const paidRow = optionByText("Claude 3.7 Sonnet");
    const freeBadge = freeRow.querySelector(".model-badge")?.textContent ?? null;
    const freePrice = freeRow.querySelector(".model-pricing")?.textContent ?? null;
    const paidPrice = paidRow.querySelector(".model-pricing")?.textContent ?? null;

    await typeSearch("nemotron");
    await pressKey("Enter", combobox());

    expect({
      smallSearchPresent,
      largeSearchPresent,
      groups: groups.slice(0, 2),
      freeBadge,
      freePrice,
      paidPrice,
      chosen: onChoose.mock.calls,
    }).toEqual({
      smallSearchPresent: false,
      largeSearchPresent: true,
      groups: ["NVIDIA", "Anthropic"],
      freeBadge: "free",
      freePrice: "free",
      paidPrice: "$3/$15",
      chosen: [[{ connection: "or", model: "nvidia/nemotron-3.5-super:free" }]],
    });
  });

  it("navigates multi-provider submenus via keyboard/hover and searches across providers", async () => {
    const props = baseProps();
    await interact(() => root.render(h(ModelPickerBlock, props)));
    await openPicker();

    await pressKey("ArrowRight", combobox());
    const chatGptOpenedByKey = opened.has(submenu("ChatGPT"));
    await pressKey("ArrowLeft", combobox());
    const afterArrowLeft = {
      pickerOpen: opened.has(menu()),
      submenuOpen: opened.has(submenu("ChatGPT")),
      focusOnSearch: document.activeElement === combobox(),
    };

    await interact(() => {
      optionByText("ChatGPT").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    const chatGptHovered = opened.has(submenu("ChatGPT"));
    await interact(() => {
      optionByText("Grok").dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    const switchedOnHover = {
      chatGptOpen: opened.has(submenu("ChatGPT")),
      grokOpen: opened.has(submenu("Grok")),
    };

    await typeSearch("same model");
    const searchState = {
      grokClosedBySearch: !opened.has(submenu("Grok")),
      ariaControls: combobox().getAttribute("aria-controls") === list().id,
    };
    await pressKey("ArrowDown", combobox());
    await pressKey("Enter", combobox());

    expect({
      chatGptOpenedByKey,
      afterArrowLeft,
      chatGptHovered,
      switchedOnHover,
      searchState,
      chosen: vi.mocked(props.onChoose).mock.calls,
    }).toEqual({
      chatGptOpenedByKey: true,
      afterArrowLeft: { pickerOpen: true, submenuOpen: false, focusOnSearch: true },
      chatGptHovered: true,
      switchedOnHover: { chatGptOpen: false, grokOpen: true },
      searchState: { grokClosedBySearch: true, ariaControls: true },
      chosen: [[{ connection: "b", model: "same-model" }]],
    });
  });

  it("manages onLook subscriptions and guards auth-recovery and provider deletion lifecycles", async () => {
    const onLook = vi.fn<ModelPickerBlockProps["onLook"]>();
    const onChoose = vi.fn();
    let resolveDrop!: (value: unknown) => void;
    const request = vi.fn<ConnectRpcRequest>(async (method) => {
      if (method === "connect/login") {
        return {
          form: "ui",
          pending: "p-auth",
          body: JSON.stringify({ kind: "input", name: "API key", description: "", secret: true }),
        };
      }
      if (method === "connect/drop") {
        return await new Promise((resolve) => {
          resolveDrop = resolve;
        });
      }
      return { ok: true };
    });

    const render = (wires: readonly ModelWireItem[]) =>
      interact(() => root.render(h(ModelPickerBlock, baseProps({ wires, request, onLook, onChoose }))));

    const wireA = wire("a", "ChatGPT", ["same-model"]);
    const wireB = wire("b", "Grok");
    await render([wireA, wireB]);
    const callsBeforeOpen = onLook.mock.calls.length;

    await openPicker();
    const afterOpen = onLook.mock.calls.at(-1);
    const lookCountAtOpen = onLook.mock.calls.length;
    await typeSearch("gro");
    const lookCountAfterSearch = onLook.mock.calls.length;

    await render([wireA, wireB, wire("c", "Local")]);
    const afterAddingWire = onLook.mock.calls.at(-1);

    await interact(() => menu().hidePopover());
    const afterHide = onLook.mock.calls.at(-1);

    const expired = wire("expired", "ChatGPT", ["stale-model"], { needsAuth: true });
    await render([expired, wireB]);
    await openPicker();
    await pressKey("ArrowRight", combobox());
    const cachedModelsHidden = !submenu("ChatGPT").textContent.includes("Stale Model");

    await interact(() => buttonByText("Sign in again").click());
    const connectLoginCall = request.mock.calls.at(-1);
    await interact(() => menu().hidePopover());
    const cancelOnHideCall = request.mock.calls.at(-1);

    await openPicker();
    await pressKey("ArrowRight", combobox());
    await pressKey("End", combobox());
    await pressKey("Enter", combobox());
    await interact(() => resolveDrop({ ok: false }));
    const alertNode = findNode('[role="alert"]');
    const failedDeleteState = {
      message: alertNode.textContent,
      describedByAlert: (combobox().getAttribute("aria-describedby") ?? "").split(" ").includes(alertNode.id),
    };

    await interact(() => buttonByText("Delete").click());
    await interact(() => resolveDrop({ ok: true }));
    const clearedAlertAfterRetry = container.querySelector('[role="alert"]') === null;

    // Start a pending drop, dismiss/reopen before it resolves, then verify stale failure does not pollute reopened picker.
    await pressKey("ArrowRight", combobox());
    await pressKey("End", combobox());
    await pressKey("Enter", combobox());
    await interact(() => menu().hidePopover());
    await openPicker();
    await interact(() => optionByText("Grok").click());
    await interact(() => resolveDrop({ ok: false }));
    const staleIgnored = {
      grokOpen: opened.has(submenu("Grok")),
      alertAfterReopen: container.querySelector('[role="alert"]'),
      chosen: onChoose.mock.calls.length,
    };

    await interact(() => root.unmount());
    const afterUnmount = onLook.mock.calls.at(-1);
    root = createRoot(container);

    expect({
      callsBeforeOpen,
      afterOpen,
      searchSkippedOnLook: lookCountAtOpen === lookCountAfterSearch,
      afterAddingWire,
      afterHide,
      cachedModelsHidden,
      connectLoginCall,
      cancelOnHideCall,
      failedDeleteState,
      clearedAlertAfterRetry,
      staleIgnored,
      afterUnmount,
    }).toEqual({
      callsBeforeOpen: 0,
      afterOpen: [["a", "b"], []],
      searchSkippedOnLook: true,
      afterAddingWire: [["a", "b", "c"], []],
      afterHide: [[], []],
      cachedModelsHidden: true,
      connectLoginCall: ["connect/login", { id: "expired" }],
      cancelOnHideCall: ["ui/resolve", { pending: "p-auth", kind: "cancel" }],
      failedDeleteState: {
        message: "Could not delete the provider. Try again.",
        describedByAlert: true,
      },
      clearedAlertAfterRetry: true,
      staleIgnored: {
        grokOpen: true,
        alertAfterReopen: null,
        chosen: 0,
      },
      afterUnmount: [[], []],
    });
  });
});
