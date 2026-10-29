// @vitest-environment happy-dom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectError } from "../connect-error.js";
import { ConnectStep } from "../connect-step.js";

const START = { driver: "openai-compat", name: "Groq", settings: { baseUrl: "https://api.groq.com/openai/v1" } };

const park = (pending: string, body: string) => ({ form: "ui", pending, body });
const OPEN = `(harness/open-url :url "https://auth.example/authorize" :description "Authorize in the browser")`;
const PASTE = `(harness/open-url :url "https://auth.example/authorize" :description "Authorize in the browser" :name "Or paste a key" :input 'password)`;
const REDIRECT = `(harness/open-url :url "https://auth.example/authorize" :description "Authorize in the browser" :name "Browser on another machine? Paste the address it ended on" :input 'password)`;
const KEY = `(harness/input :name "API key" :description "Paste your key." :secret #t)`;

type Call = { readonly method: string; readonly params: Record<string, unknown> };

/** A daemon that answers each call when the test says so. */
function daemon() {
  const calls: Call[] = [];
  const waiting: Array<{ call: Call; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const request = vi.fn((method: string, params: unknown) => {
    const call = { method, params: params as Record<string, unknown> };
    calls.push(call);
    return new Promise<unknown>((resolve, reject) => waiting.push({ call, resolve, reject }));
  });
  /** Answer the call that has waited longest, or the one for `method`. */
  const take = (method?: string) => {
    const at = waiting.findIndex((entry) => method == null || entry.call.method === method);
    if (at === -1) throw new Error("no call is waiting");
    return waiting.splice(at, 1)[0]!;
  };
  const answer = async (value: unknown, method?: string): Promise<void> => {
    const next = take(method);
    await act(async () => {
      next.resolve(value);
    });
  };
  const fail = async (message: string, method?: string): Promise<void> => {
    const next = take(method);
    await act(async () => {
      next.reject(new Error(message));
    });
  };
  return { calls, request, answer, fail };
}

let container: HTMLDivElement;
let root: Root;
const onDone = vi.fn();
const onCancel = vi.fn();

async function render(request: (method: string, params: unknown) => Promise<unknown>, strict = false) {
  const step = createElement(ConnectStep, { start: START, request, onDone, onCancel });
  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, step) : step);
  });
}

const text = () => container.textContent;
const byLabel = (label: string) => {
  const field = [...container.querySelectorAll("label")].find((node) => node.textContent === label);
  const input = field == null ? null : container.querySelector<HTMLInputElement>(`[id="${field.htmlFor}"]`);
  if (input == null) throw new Error(`no field ${label}`);
  return input;
};
const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find((node) => node.textContent === name);
  if (found == null) throw new Error(`no button ${name}`);
  return found;
};
async function click(node: Element) {
  // A link's default action is to navigate: the page under test reaches no network.
  document.addEventListener("click", (event) => event.preventDefault(), { once: true });
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
async function press(node: Element, key: string) {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onDone.mockReset();
  onCancel.mockReset();
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

describe("connect step", () => {
  it("starts the flow once, even where effects replay", async () => {
    const d = daemon();
    await render(d.request, true);
    expect(d.calls).toEqual([{ method: "connect/adopt", params: START }]);
    expect(text()).toContain("Connecting…");
  });

  it("opens the link, waits for the browser, and finishes with the connection", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", OPEN));
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Open");
    expect(link?.getAttribute("href")).toBe("https://auth.example/authorize");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(text()).toContain("Authorize in the browser");
    expect(container.querySelector("input")).toBeNull();

    if (link == null) throw new Error("no link");
    await click(link);
    expect(d.calls.at(-1)).toEqual({
      method: "ui/resolve",
      params: { pending: "p1", kind: "opened", url: "https://auth.example/authorize" },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Waiting for the browser…");
    expect(container.querySelector("a")).toBeNull();

    await d.answer({ id: "chatgpt" });
    expect(onDone).toHaveBeenCalledWith("chatgpt");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels a sign-in in flight and ignores however the in-flight call ends", async () => {
    for (const ending of ["refused", "error"] as const) {
      onDone.mockReset();
      onCancel.mockReset();
      const d = daemon();
      await render(d.request);
      await d.answer(park("p1", OPEN));
      const link = container.querySelector("a");
      if (link == null) throw new Error("no link");
      await click(link);
      await click(button("Cancel"));
      expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
      expect(onCancel).toHaveBeenCalledTimes(1);
      // The held `opened` call is still open; the daemon ends it as it aborts the sign-in.
      if (ending === "refused") await d.answer({ ok: false });
      else await d.fail("sign-in aborted");
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
      expect(text()).not.toContain("sign-in aborted");
      await act(async () => {
        root.render(createElement("div"));
      });
    }
  });

  it("takes a pasted key beside the link, and a redirect address in the clear", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", PASTE));
    const field = byLabel("Or paste a key");
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(button("Connect").disabled).toBe(true);
    await type(field, "sk-live-123");
    await click(button("Connect"));
    expect(d.calls.at(-1)).toEqual({
      method: "ui/resolve",
      params: { pending: "p1", kind: "text", input: "sk-live-123" },
    });
    await d.answer({ id: "grok" });
    expect(onDone).toHaveBeenCalledWith("grok");

    const redirect = daemon();
    await act(async () => {
      root.render(
        createElement(ConnectStep, { key: "redirect", start: START, request: redirect.request, onDone, onCancel }),
      );
    });
    await redirect.answer(park("p1", REDIRECT));
    const address = byLabel("Browser on another machine? Paste the address it ended on");
    expect(address.type).toBe("url");
    expect(address.getAttribute("autocomplete")).toBe("off");
    expect(address.getAttribute("spellcheck")).toBe("false");
  });

  it("asks for a labeled secret field, then the next thing the daemon wants", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", KEY));
    const field = byLabel("API key");
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(text()).toContain("Paste your key.");
    await type(field, "gsk_abc");
    await press(field, "Enter");
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "text", input: "gsk_abc" } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Connecting…");

    await d.answer(park("p1", `(harness/input :name "Base URL")`));
    expect(byLabel("Base URL").type).toBe("text");
    expect(byLabel("Base URL").value).toBe("");
  });

  it("sends a plain Cancel from a field", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", KEY));
    await click(button("Cancel"));
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("leaves the flow on Esc, without closing what holds it", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", KEY));
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      byLabel("API key").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    document.body.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("answers a confirmation with accept", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", `(harness/confirm :title "Replace" :description "Replace the existing connection?")`));
    expect(text()).toContain("Replace the existing connection?");
    await click(button("Accept"));
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "accept" } });
  });

  it("sends anything else to the terminal, and still lets go", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", `(harness/notice :message "hi")`));
    expect(text()).toContain("Finish this in the terminal: /connect");
    expect(container.querySelector("input")).toBeNull();
    await click(button("Cancel"));
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says what went wrong and retries from the start", async () => {
    const d = daemon();
    await render(d.request);
    await d.fail("connect ECONNREFUSED");
    const copy = connectError("Groq", "connect ECONNREFUSED");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain(copy.summary);
    expect(status?.querySelector(".connect-detail p")?.textContent).toBe(copy.detail);
    expect(status?.querySelector("summary")?.textContent).toBe("Details");
    await click(button("Retry"));
    expect(d.calls.map((call) => call.method)).toEqual(["connect/adopt", "connect/adopt"]);
    await d.answer(park("p1", KEY));
    expect(byLabel("API key")).toBeTruthy();
  });

  it("releases the park it holds when an answer fails, so Retry starts clean", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", KEY));
    await type(byLabel("API key"), "k");
    await click(button("Connect"));
    await d.fail("socket closed");
    expect(text()).toContain("socket closed");
    expect(container.querySelector("details")).toBeNull();
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
  });

  it("treats a refusal as the end of the flow, and an unknown answer as an error", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer({ ok: false });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const e = daemon();
    await act(async () => {
      root.render(createElement(ConnectStep, { key: "again", start: START, request: e.request, onDone, onCancel }));
    });
    await e.answer({ something: "else" });
    expect(text()).toContain("does not know");
  });

  it("releases the park it holds when it is torn down", async () => {
    const d = daemon();
    await render(d.request);
    await d.answer(park("p1", KEY));
    await act(async () => {
      root.render(createElement("div"));
    });
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "p1", kind: "cancel" } });
  });

  it("cancels a park that arrives after the step is gone", async () => {
    const d = daemon();
    await render(d.request);
    await act(async () => {
      root.render(createElement("div"));
    });
    await d.answer(park("late", KEY));
    expect(d.calls.at(-1)).toEqual({ method: "ui/resolve", params: { pending: "late", kind: "cancel" } });
  });
});
