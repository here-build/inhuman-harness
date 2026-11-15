// @vitest-environment happy-dom

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kernel, StoryDial } from "../../__stories__/world.js";
import { SettingsDialog } from "../settings.js";

let dial: StoryDial;
vi.mock("../../client/context.js", () => ({ useDial: () => dial }));

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dial = new StoryDial({ kernel: kernel({ wires: [] }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dial.kernel?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("SettingsDialog", () => {
  it("writes trimmed Skills fields with multiline body and clears body after save", async () => {
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Skills");

    const scope = within(container).getByLabelText("Where");
    expect(scope.getAttribute("aria-haspopup")).toBe("listbox");
    await act(async () => user.click(scope));
    await act(async () => user.click(within(container).getByRole("option", { name: "Home" })));

    await fill("Name", "  review-new  ");
    await fill("Description", "Verify code changes");
    const body = '  Keep literal values.\n{"case": "MixedCase"}\n';
    const textarea = await fill("Body", body);
    expect(textarea.tagName).toBe("TEXTAREA");

    await click("Save skill");
    expect(dial.calls.find((call) => call.method === "skill/write")?.params).toEqual({
      scope: "home",
      name: "review-new",
      description: "Verify code changes",
      body,
    });
    expect(within(container).getByRole("status").textContent).toBe("Skill saved.");
    expect(within(container).getByLabelText<HTMLTextAreaElement>("Body").value).toBe("");
  });

  it("validates Runtime fields, saves TriggerRange sliders to config/set, and preserves input on RPC failure", async () => {
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Runtime");

    await fill("Turns to keep", "not a number");
    await click("Save");
    expect(dial.calls.some((call) => call.method === "config/set")).toBe(false);
    expect(within(container).getByRole("status").textContent).toContain("need numbers");

    await fill("Turns to keep", "12");
    const soft = within(container).getByLabelText<HTMLInputElement>("Soft trigger");
    await act(async () => {
      soft.focus();
      await user.keyboard("{ArrowLeft}{ArrowLeft}");
    });
    expect(soft.value).toBe("78");

    await click("Save");
    expect(dial.calls.find((call) => call.method === "config/set")?.params).toMatchObject({
      compactKeepTurns: 12,
      compactTriggers: { soft: "78%", hard: "90%" },
    });
    expect(within(container).getByRole("status").textContent).toBe("Runtime settings saved.");

    vi.spyOn(dial.kernelRpc!, "request").mockRejectedValueOnce(new Error("Could not save runtime settings."));
    await fill("Turns to keep", "13");
    expect(within(container).queryByRole("status")).toBeNull();
    await click("Save");
    const failure = within(container).getByRole("status");
    expect(failure.textContent).toBe("Could not save runtime settings.");
    expect(failure.classList.contains("text-danger")).toBe(true);
    expect(within(container).getByLabelText<HTMLInputElement>("Turns to keep").value).toBe("13");
  });
});
