// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";
import type { AccountSource } from "../wire-account.js";

type Face = AccountSource & {
  id: string;
  name: string;
  driver: { name: string; abilityClaim: string[] };
  live: { models: string[] };
};
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
      drivers: {} as Record<string, unknown>,
      connections: { chatgpt: face("chatgpt", "ChatGPT", ["gpt-6.1-sol"]) } as Record<string, Face>,
    },
  };
  session: {
    root: {
      uuid: string;
      activity: { readonly kind: "idle" };
      autoModeProblems: Record<string, string>;
      sessionId: string;
      head: object | null;
      findRunningTurn: () => null;
      kvs: { connection: string; model: string };
    };
  } | null = {
    root: {
      uuid: "root:fresh",
      activity: { kind: "idle" },
      autoModeProblems: {},
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

describe("unauthorized provider recovery in the model picker", () => {
  it("keeps a 401 account visible without username, hides cached models, and offers sign-in and delete", async () => {
    runInAction(() => {
      dial().kernel.root.connections.chatgpt = {
        ...face("chatgpt", "ChatGPT", ["stale-model"]),
        live: { models: ["stale-model"], auth: "needs-auth", identity: { displayName: "Ada" } },
      };
    });
    await render();
    await toggle("open");
    expect(option("ChatGPT").textContent).not.toContain("Ada");
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    expect(option("ChatGPT").getAttribute("aria-haspopup")).toBe("menu");
    expect(container.textContent).not.toContain("Add a provider");
    await click(option("ChatGPT"));
    const submenu = container.querySelector('.model-submenu[aria-label="ChatGPT"]');
    if (submenu == null) throw new Error("no account menu");
    await act(async () => {
      submenu.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
    });
    expect(submenu.textContent).not.toContain("Stale Model");
    const signin = submenu.querySelector('button[role="menuitem"]');
    if (signin == null) throw new Error("no sign-in action");
    expect(signin.textContent).toBe("Sign in again");
    expect(submenu.textContent).toContain("Delete");
    dial().sessionRpc?.request.mockResolvedValue({
      form: "ui",
      pending: "reauth",
      body: JSON.stringify({ kind: "open-url", url: "https://login.example.test", description: "Sign in" }),
    });
    await click(signin);
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("connect/login", { id: "chatgpt" });
    expect(dial().sessionRpc?.request).not.toHaveBeenCalledWith("connect/adopt", expect.anything());
    const cancel = [...container.querySelectorAll("button")].find((node) => node.textContent === "Cancel");
    if (cancel == null) throw new Error("no cancel");
    await click(cancel);
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("ui/resolve", { pending: "reauth", kind: "cancel" });
  });

  it("can find an unauthorized provider by provider name and delete it, with retry on failure", async () => {
    runInAction(() => {
      dial().kernel.root.connections.grok = face("grok", "Grok", ["grok-4.7"]);
      dial().kernel.root.connections.chatgpt = {
        ...face("chatgpt", "ChatGPT", []),
        readyState: "failed",
        error: "models probe HTTP 401",
        live: { models: [], identity: { email: "ada@example.com" } },
      };
    });
    await render();
    await toggle("open");
    await type("chatgpt");
    expect(option("ChatGPT").textContent).not.toContain("ada@example.com");
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    await click(option("ChatGPT"));
    const submenu = container.querySelector('.model-submenu[aria-label="ChatGPT"]');
    if (submenu == null) throw new Error("no account menu");
    await act(async () => {
      submenu.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
    });
    const remove = [...submenu.querySelectorAll("button")].find((node) => node.textContent === "Delete");
    if (remove == null) throw new Error("no delete");
    dial().sessionRpc?.request.mockRejectedValueOnce(new Error("Delete failed"));
    await click(remove);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Delete failed");
    expect(remove.disabled).toBe(false);
    dial().sessionRpc?.request.mockImplementation(async (method) => {
      if (method === "connect/drop")
        runInAction(() => {
          delete dial().kernel.root.connections.chatgpt;
        });
      return { ok: true };
    });
    await click(remove);
    expect(dial().sessionRpc?.request).toHaveBeenCalledWith("connect/drop", { id: "chatgpt", confirm: true });
    // Only Grok remains, so the picker switches to single-provider direct models view.
    expect(container.querySelectorAll(".model-wire")).toHaveLength(0);
    expect([...container.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual(["Grok 4.7"]);
  });

  it("keeps recovery available if sign-in finishes before the refreshed catalog arrives", async () => {
    runInAction(() => {
      dial().kernel.root.connections.chatgpt = {
        ...face("chatgpt", "ChatGPT", []),
        live: { models: [], auth: "needs-auth" },
      };
    });
    await render();
    await toggle("open");
    await click(option("ChatGPT"));
    const submenu = container.querySelector('.model-submenu[aria-label="ChatGPT"]');
    if (submenu == null) throw new Error("no account menu");
    await act(async () => {
      submenu.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
    });
    const signin = submenu.querySelector("button");
    if (signin == null) throw new Error("no sign-in");
    await click(signin);
    expect(option("ChatGPT").textContent).toContain("Please sign in again.");
    await act(async () => {
      runInAction(() => {
        dial().kernel.root.connections.chatgpt = face("chatgpt", "ChatGPT", ["new-model"]);
      });
    });
    expect(container.textContent).not.toContain("Loading its models");
    expect(container.textContent).not.toContain("Please sign in again.");
    expect([...container.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual(["New Model"]);
  });
});
