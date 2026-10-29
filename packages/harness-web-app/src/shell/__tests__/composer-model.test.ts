// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";
import { naturalName } from "../model-choice.js";

type SessionFace = {
  root: {
    uuid: string;
    sessionId: string;
    findRunningTurn: () => { uuid: string; approvalHead: unknown } | null;
    kvs: { connection: string; model: string };
  };
};

type Face = {
  id: string;
  driver: { abilityClaim: string[] };
  live: { models: string[] };
};

class ModelDial {
  attaching = false;
  requestedTarget: { kind: "kernel" } = { kind: "kernel" };
  sessionRpc: { request: typeof state.request } | null = null;
  kernel: { root: { approvalAskThrottleMs: number; connections: Record<string, Face> } } = {
    root: { approvalAskThrottleMs: 0, connections: {} },
  };
  session: SessionFace | null = null;
  readonly look = vi.fn();

  constructor() {
    this.sessionRpc = { request: state.request };
    this.kernel = {
      root: {
        approvalAskThrottleMs: 0,
        connections: {
          chatgpt: face("chatgpt", ["gpt-6.1-sol", "gpt-6-sol"]),
          grok: face("grok", ["grok-4.7"]),
          web: face("web-keyless", ["unused"], ["web-search"]),
        },
      },
    };
    this.session = {
      root: {
        uuid: "root:alpha",
        sessionId: "s-alpha",
        findRunningTurn: () => null,
        kvs: observable({ connection: "chatgpt", model: "gpt-6.1-sol" }),
      },
    };
    makeObservable(this, {
      attaching: observable,
      sessionRpc: observable.ref,
      kernel: observable,
      session: observable.ref,
    });
  }
}

const state: {
  request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
  dial: ModelDial | null;
} = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
  dial: null,
}));

vi.mock("../../client/context.js", () => ({
  useDial: () => {
    if (state.dial == null) throw new Error("dial missing");
    return state.dial;
  },
}));

function face(id: string, models: readonly string[], can: readonly string[] = ["completion"]): Face {
  return { id, driver: { abilityClaim: [...can] }, live: { models: [...models] } };
}

function openDial(): ModelDial {
  return new ModelDial();
}

let container: HTMLDivElement;
let root: Root;

function element<T extends Element>(selector: string): T {
  const node = container.querySelector<T>(selector);
  if (node == null) throw new Error(`missing ${selector}`);
  return node;
}

function dial(): ModelDial {
  const current = state.dial;
  if (current == null) throw new Error("dial missing");
  return current;
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(Composer));
  });
}

const trigger = (): HTMLButtonElement => element<HTMLButtonElement>(".model-trigger");

/** Providers in the root menu, in painted order. */
const wireRows = (): string[] =>
  [...container.querySelectorAll(".model-wire")].map((row) => row.firstElementChild?.textContent.trim() ?? "");

/** The model the closed picker names. */
const shownModel = (): string | null => trigger().getAttribute("aria-label");

/** Search results as `connection · model`, in painted order. */
const optionNodes = (): Element[] => [...container.querySelectorAll('[role="group"] [role="option"]')];
function options(): string[] {
  return optionNodes().map(
    (option) => `${option.closest('[role="group"]')?.getAttribute("aria-label")} · ${option.textContent.trim()}`,
  );
}
const selected = (): string[] =>
  options().filter((_, index) => optionNodes()[index]?.getAttribute("aria-selected") === "true");

async function searchFor(text: string): Promise<void> {
  const field = element<HTMLInputElement>('input[aria-label="Search models"]');
  await act(async () => {
    // Bypass React's value tracker, just as a browser edit would.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Search reaches every provider, so a test picks the way a hurried user does. */
async function pick(choice: { readonly connection: string; readonly model: string }): Promise<void> {
  await searchFor(choice.model);
  const option = optionNodes()[options().indexOf(`${choice.connection} · ${naturalName(choice.model)}`)];
  if (!(option instanceof HTMLElement)) throw new Error(`no option ${choice.model}`);
  await act(async () => {
    option.click();
  });
}

// happy-dom has no popover API. The browser owns open and dismiss; the test only clicks options.
if (!("hidePopover" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { value: () => undefined });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.request.mockReset();
  state.request.mockImplementation(async () => ({ ok: true }));
  state.dial = openDial();
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

describe("composer model choice", () => {
  it("names the permission mode under the model and writes a pick", async () => {
    await render();
    const word = element<HTMLButtonElement>(".permission-trigger");
    expect(word.textContent).toBe("auto");
    const row = (label: string): HTMLButtonElement => {
      const node = [...container.querySelectorAll<HTMLButtonElement>(".permission-row")].find(
        (candidate) => candidate.textContent.trim() === label,
      );
      if (node == null) throw new Error(`missing ${label}`);
      return node;
    };
    await act(async () => {
      row("manual").click();
    });
    expect(state.request).toHaveBeenCalledWith("policy/set", { policy: "manual" });
    // the old per-cluster auto switches are gone: the menu is the mode alone
    expect([...container.querySelectorAll(".permission-row")].map((node) => node.textContent.trim())).toEqual([
      "manual",
      "always approve",
      "auto",
    ]);
  });

  it("sits under the draft and names each wire when more than one is listed", async () => {
    await render();
    const order = [...container.querySelectorAll("textarea, .model-trigger")].map((node) =>
      node instanceof HTMLTextAreaElement ? "draft" : "model",
    );
    expect(order).toEqual(["draft", "model"]);
    expect(trigger().disabled).toBe(false);
    expect(trigger().getAttribute("aria-label")).toBe("Model: Gpt 6.1 Sol");
    expect(trigger().querySelector("svg")).toBeNull();
    expect(trigger().textContent).toContain("chatgpt");
    expect(wireRows()).toEqual(["chatgpt", "grok"]);
    // Every fixture model has a "g": one query lists them all, across providers.
    await searchFor("g");
    expect(options()).toEqual(["chatgpt · Gpt 6.1 Sol", "chatgpt · Gpt 6 Sol", "grok · Grok 4.7"]);
    expect(selected()).toEqual(["chatgpt · Gpt 6.1 Sol"]);
    await searchFor("4.7");
    expect(options()).toEqual(["grok · Grok 4.7"]);
  });

  it("looks at every listed wire while the menu is open, so their accounts poll", async () => {
    await render();
    const menu = container.querySelector(".model-picker");
    if (menu == null) throw new Error("menu missing");
    const toggle = async (newState: "open" | "closed"): Promise<void> => {
      await act(async () => {
        menu.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
      });
    };
    await toggle("open");
    await toggle("closed");
    expect(dial().look.mock.calls).toEqual([
      [["chatgpt", "grok"], []],
      [[], []],
    ]);
  });

  it("writes connection, then model, and shows the choice when the session echoes it", async () => {
    await render();
    await pick({ connection: "chatgpt", model: "gpt-6.1-sol" });
    expect(state.request).not.toHaveBeenCalled();

    await pick({ connection: "grok", model: "grok-4.7" });
    expect(state.request.mock.calls).toEqual([
      ["kv/set", { key: "connection", value: "grok", remember: true }],
      ["kv/set", { key: "model", value: "grok-4.7", remember: true }],
    ]);
    expect(shownModel()).toBe("Model: Gpt 6.1 Sol");

    const session = dial().session;
    if (session == null) throw new Error("session missing");
    await act(async () => {
      runInAction(() => {
        session.root.kvs.connection = "grok";
        session.root.kvs.model = "grok-4.7";
      });
    });
    expect(shownModel()).toBe("Model: Grok 4.7");
  });

  it("stops after a refused connection write", async () => {
    state.request.mockImplementation(async (method: string) => ({ ok: method !== "kv/set" }));
    await render();
    await pick({ connection: "grok", model: "grok-4.7" });
    expect(state.request.mock.calls).toEqual([["kv/set", { key: "connection", value: "grok", remember: true }]]);
    expect(container.textContent).toContain("Model was not changed.");
    expect(shownModel()).toBe("Model: Gpt 6.1 Sol");
  });

  it("shows the current model as text when no completion catalog is listed", async () => {
    await render();
    await act(async () => {
      runInAction(() => {
        // Connected, but nothing lists models yet: the model is named, not offered.
        dial().kernel.root.connections = { chatgpt: face("chatgpt", []) };
      });
    });
    expect(container.querySelector(".model-trigger")).toBeNull();
    expect(container.textContent).toContain("Gpt 6.1 Sol");

    await act(async () => {
      runInAction(() => {
        dial().session = null;
      });
    });
    expect(container.querySelector(".composer")).toBeNull();
    expect(container.querySelector('textarea[aria-label="Message draft"]')).toBeNull();
    expect(container.textContent).not.toContain("Model");
  });

  it("stays available during a running turn and locks while the session port is down", async () => {
    const session = dial().session;
    if (session == null) throw new Error("session missing");
    session.root.findRunningTurn = () => ({ uuid: "turn", approvalHead: null });
    await render();
    expect(trigger().disabled).toBe(false);

    await act(async () => {
      runInAction(() => {
        dial().sessionRpc = null;
      });
    });
    expect(trigger().disabled).toBe(true);
  });

  it("asks the daemon to cancel and drops the running chrome without writing the turn", async () => {
    const session = dial().session;
    if (session == null) throw new Error("session missing");
    const turn = observable({
      uuid: "pz0s0K8mtrirZ97",
      approvalHead: null,
      cancelRequested: false,
      get cutOff() {
        return this.cancelRequested;
      },
    });
    session.root.findRunningTurn = () => turn;
    await render();
    const stop = button("Stop");
    expect(stop.disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
    await act(async () => {
      stop.click();
    });
    expect(turn.cancelRequested).toBe(false);
    expect(state.request).toHaveBeenCalledWith("turn/cancel", { turnId: "pz0s0K8mtrirZ97" });
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
  });

  it("shows enter for a draft and swaps it for stop only when that draft is empty during a live turn", async () => {
    await render();
    expect(container.querySelector('button[aria-label="Send"], button[aria-label="Stop"]')).toBeNull();
    await typeDraft("hello");
    expect(button("Send").disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();

    const session = dial().session;
    if (session == null) throw new Error("session missing");
    // The turn is not observable. The next draft edit is what re-reads it.
    session.root.findRunningTurn = () => ({ uuid: "turn", approvalHead: null, cutOff: false });
    await typeDraft("hello!");
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();

    await typeDraft("");
    expect(button("Stop").disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
  });
});

describe("composer approval", () => {
  it("answers through ask/answer and leaves the leaf to the daemon", async () => {
    const session = dial().session;
    if (session == null) throw new Error("session missing");
    const head = observable({ uuid: "ask-1", humanApprove: null as boolean | null, approvalComment: null });
    session.root.findRunningTurn = () => ({ uuid: "turn", cutOff: false, approvalHead: head });
    await render();
    await act(async () => {
      button("Deny").click();
    });
    expect({ calls: state.request.mock.calls, approve: head.humanApprove, comment: head.approvalComment }).toEqual({
      calls: [["ask/answer", { sessionId: "s-alpha", jobId: "ask-1", allow: false }]],
      approve: null,
      comment: null,
    });
  });
});

function button(label: string): HTMLButtonElement {
  const node = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(node instanceof HTMLButtonElement)) throw new Error(label);
  return node;
}

async function typeDraft(value: string): Promise<void> {
  const draft = element<HTMLTextAreaElement>('textarea[aria-label="Message draft"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setValue == null) throw new Error("textarea value setter missing");
  await act(async () => {
    setValue.call(draft, value);
    draft.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
