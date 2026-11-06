// @vitest-environment happy-dom

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kernel, StoryDial } from "../../__stories__/world.js";
import { ConnectStep } from "../connect-step.js";
import { PermissionsPanel } from "../permissions-panel.js";
import { SettingsDialog } from "../settings.js";

let dial: StoryDial;
vi.mock("../../client/context.js", () => ({ useDial: () => dial }));

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  dial = new StoryDial({ kernel: kernel({ wires: [] }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: React.ReactNode) {
  await act(async () => root.render(element));
}

async function click(name: string) {
  await act(async () => user.click(within(container).getByRole("button", { name })));
}

async function fill(label: string, value: string) {
  const input = within(container).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

function describedText(input: HTMLElement) {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

describe("screen field migration", () => {
  it("focuses the composed secret input, links external help, and preserves IME and literal answers", async () => {
    const onDone = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === "connect/adopt"
        ? {
            form: "ui",
            pending: "key-park",
            body: '(harness/input :name "API key" :description "Paste the exact key." :secret #t)',
          }
        : { id: "connected" },
    );
    await render(
      h(ConnectStep, {
        start: { driver: "openai-compat", name: "Example" },
        request,
        onDone,
        onCancel: vi.fn(),
      }),
    );
    const input = await fill("API key", "sk-秘密 123");
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(describedText(input)).toContain("Paste the exact key.");
    expect(container.querySelector("label.label")).toBeNull();

    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(composing));
    expect(composing.defaultPrevented).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(request).toHaveBeenLastCalledWith("ui/resolve", {
      pending: "key-park",
      kind: "text",
      input: "sk-秘密 123",
    });
    expect(onDone).toHaveBeenCalledWith("connected");
  });

  it("keeps anchored skill scope and exact multiline content while announcing a successful save", async () => {
    await render(h(SettingsDialog, { onDismiss: vi.fn() }));
    expect(container.querySelector('form[method="dialog"]')).not.toBeNull();
    await click("Skills");
    const scope = within(container).getByLabelText("Where");
    expect(scope.getAttribute("aria-haspopup")).toBe("listbox");
    await act(async () => user.click(scope));
    await act(async () => user.click(within(container).getByRole("option", { name: "Home" })));
    await fill("Name", "  review-new  ");
    await fill("Description", "Проверка кода");
    const body = '  Keep literal values.\n{"case": "MixedCase"}\n';
    const textarea = await fill("Body", body);
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("rows")).toBe("5");
    await click("Save skill");
    expect(dial.calls.find((call) => call.method === "skill/write")?.params).toEqual({
      scope: "home",
      name: "review-new",
      description: "Проверка кода",
      body,
    });
    expect(within(container).getByRole("status").textContent).toBe("Skill saved.");
    expect((within(container).getByLabelText("Body") as HTMLTextAreaElement).value).toBe("");
  });

  it("distinguishes runtime validation, saved confirmation and RPC failure without changing numeric conversion", async () => {
    await render(h(SettingsDialog, { onDismiss: vi.fn() }));
    await click("Runtime");
    await fill("Turns to keep", "not a number");
    await click("Save");
    expect(dial.calls.some((call) => call.method === "config/set")).toBe(false);
    expect(within(container).getByRole("status").textContent).toContain("need numbers");
    await fill("Turns to keep", "12");
    await click("Save");
    expect(dial.calls.find((call) => call.method === "config/set")?.params).toMatchObject({ compactKeepTurns: 12 });
    expect(within(container).getByRole("status").textContent).toBe("Runtime settings saved.");

    vi.spyOn(dial.kernelRpc!, "request").mockRejectedValueOnce(new Error("Could not save runtime settings."));
    await fill("Turns to keep", "13");
    expect(within(container).queryByRole("status")).toBeNull();
    await click("Save");
    const failure = within(container).getByRole("status");
    expect(failure.textContent).toBe("Could not save runtime settings.");
    expect(failure.classList.contains("text-danger")).toBe(true);
    expect((within(container).getByLabelText("Turns to keep") as HTMLInputElement).value).toBe("13");
  });

  it("keeps permission probe help external and disables Explain without a session", async () => {
    await render(h(PermissionsPanel));
    const input = within(container).getByLabelText("Command, path or mcp:server/tool");
    expect(describedText(input)).toContain("Open a session to explain a call.");
    expect((within(container).getByRole("button", { name: "Explain" }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("label.label")).toBeNull();
  });
});
