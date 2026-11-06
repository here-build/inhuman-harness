// @vitest-environment happy-dom

import { act, createElement as h, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kernel, session, StoryDial } from "../../__stories__/world.js";
import { PermissionMode } from "../permission-mode.js";

type Mode = NonNullable<ComponentProps<typeof PermissionMode>["staged"]>;
const modes = [
  ["manual", "manual"],
  ["yolo", "always approve"],
  ["auto", "auto"],
] as const satisfies readonly (readonly [Mode, string])[];

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode = h(PermissionMode)) {
  await act(async () => root.render(node));
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function trigger(label?: string) {
  return within(container).getByRole<HTMLButtonElement>("button", {
    name: label == null ? /Permission mode:/ : `Permission mode: ${label}`,
  });
}

function menu() {
  return within(container).getByRole("menu", { name: /^Permission mode:/ });
}

function selected(label: string) {
  const items = within(menu()).getAllByRole("menuitemradio");
  expect(items.map((item) => item.textContent)).toEqual(modes.map(([, word]) => word));
  expect(items.filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent)).toEqual([
    label,
  ]);
}

function closed() {
  expect(within(container).queryByRole("menu")).toBeNull();
  expect(container.querySelector(".gp-native-popover")).toBeNull();
}

async function openSession() {
  const opened = session({ id: "permission-session", turns: [] });
  dial = new StoryDial({ kernel: kernel({ wires: [] }), sessions: [opened] });
  await dial.follow({ kind: "session", sessionId: opened.root.sessionId });
  return opened;
}

describe("permission mode menu migration", () => {
  it.each(modes)("displays %s with one current selection and closes Escape without committing", async (mode, label) => {
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = mode;
    });
    await render();
    const button = trigger(label);
    expect(button.textContent).toBe(label);
    expect(button.classList.contains("permission-trigger")).toBe(true);
    expect(button.classList.contains("label")).toBe(true);
    expect(button.getAttribute("aria-haspopup")).toBe("true");
    closed();

    await interact(() => user.click(button));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    selected(label);
    expect(document.activeElement).toBe(within(menu()).getByRole("menuitemradio", { name: label }));
    await interact(() => user.keyboard("{Escape}"));
    closed();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await settleFocus();
    expect(document.activeElement).toBe(button);
    expect(dial.calls).toEqual([]);
  });

  it.each([
    { staged: "yolo", seed: "auto", label: "always approve" },
    { staged: null, seed: "auto", label: "auto" },
    { staged: null, seed: null, label: "manual" },
  ] as const)("keeps staged/seed precedence local ($staged / $seed)", async ({ staged, seed, label }) => {
    await openSession();
    runInAction(() => {
      dial.session!.root.permissionMode = "yolo";
    });
    const onStage = vi.fn();
    await render(h(PermissionMode, { staged, seed, onStage }));
    await interact(() => user.click(trigger(label)));
    selected(label);
    await interact(() => user.keyboard("{ArrowDown}{Escape}"));
    expect(onStage).not.toHaveBeenCalled();
    expect(dial.calls).toEqual([]);
  });

  it("stages every typed mode without an RPC, closes actions, and retains the single current choice", async () => {
    await openSession();
    const kernelRequest = vi.spyOn(dial.kernelRpc!, "request");
    const sessionRequest = vi.spyOn(dial.sessionRpc!, "request");
    const onStage = vi.fn();
    function Staged() {
      const [staged, setStaged] = useState<Mode | null>(null);
      return h(PermissionMode, {
        seed: "auto",
        staged,
        onStage: (mode) => {
          onStage(mode);
          setStaged(mode);
        },
      });
    }
    await render(h(Staged));
    for (const [mode, label] of modes) {
      const button = trigger();
      await interact(() => user.click(button));
      await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: label })));
      expect(onStage).toHaveBeenLastCalledWith(mode);
      closed();
      await settleFocus();
      expect(document.activeElement).toBe(button);
      expect(trigger(label)).toBe(button);
      await interact(() => user.click(button));
      selected(label);
      await interact(() => user.keyboard("{Escape}"));
      await settleFocus();
    }
    expect(onStage).toHaveBeenCalledTimes(3);
    expect(sessionRequest).not.toHaveBeenCalled();
    expect(kernelRequest).not.toHaveBeenCalled();
    expect(dial.calls).toEqual([]);
  });

  it.each(modes)("routes %s only to session policy/set and updates the displayed mode", async (mode, label) => {
    const opened = await openSession();
    const sessionRequest = vi.spyOn(dial.sessionRpc!, "request");
    const kernelRequest = vi.spyOn(dial.kernelRpc!, "request");
    await render();
    const button = trigger();
    await interact(() => user.click(button));
    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: label })));
    expect(sessionRequest).toHaveBeenCalledExactlyOnceWith("policy/set", { policy: mode });
    expect(kernelRequest).not.toHaveBeenCalled();
    expect(opened.root.permissionMode).toBe(mode);
    expect(trigger(label)).toBe(button);
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
  });

  it.each(modes)("routes %s only to kernel config/set with defaultPermissionMode", async (mode, label) => {
    const request = vi.spyOn(dial.kernelRpc!, "request");
    await render();
    const button = trigger();
    await interact(() => user.click(button));
    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: label })));
    expect(request).toHaveBeenCalledExactlyOnceWith("config/set", { defaultPermissionMode: mode });
    expect(dial.kernel!.root.defaultPermissionMode).toBe(mode);
    expect(trigger(label)).toBe(button);
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
  });

  it("opens with ArrowDown/ArrowUp, navigates real RAC items, and commits with Enter/Space", async () => {
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = "manual";
    });
    await render();
    const button = trigger("manual");
    await interact(() => user.tab());
    expect(document.activeElement).toBe(button);
    await interact(() => user.keyboard("{ArrowDown}"));
    const manual = within(menu()).getByRole("menuitemradio", { name: "manual" });
    const yolo = within(menu()).getByRole("menuitemradio", { name: "always approve" });
    expect(document.activeElement).toBe(manual);
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(yolo);
    selected("manual");
    expect(dial.calls).toEqual([]);
    await interact(() => user.keyboard("{Enter}"));
    expect(dial.calls).toEqual([{ method: "config/set", params: { defaultPermissionMode: "yolo" } }]);
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);

    await interact(() => user.keyboard("{ArrowUp}"));
    expect(document.activeElement).toBe(within(menu()).getByRole("menuitemradio", { name: "always approve" }));
    await interact(() => user.keyboard("{ArrowDown} "));
    expect(dial.calls.at(-1)).toEqual({ method: "config/set", params: { defaultPermissionMode: "auto" } });
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
  });

  it("disables disconnected live mode for pointer and keyboard activation", async () => {
    dial = new StoryDial({ kernel: null, portless: true });
    await render();
    const button = trigger("auto");
    expect(button.disabled).toBe(true);
    await interact(() => user.click(button));
    await interact(() => user.tab());
    expect(document.activeElement).not.toBe(button);
    await interact(() => user.keyboard("{ArrowDown}{Enter}"));
    closed();
    expect(dial.calls).toEqual([]);
  });

  it("permits local staging while disconnected", async () => {
    dial = new StoryDial({ kernel: null, portless: true });
    const onStage = vi.fn();
    await render(h(PermissionMode, { seed: "yolo", onStage }));
    expect(trigger("always approve").disabled).toBe(false);
    await interact(() => user.click(trigger()));
    selected("always approve");
    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: "auto" })));
    expect(onStage).toHaveBeenCalledExactlyOnceWith("auto");
    expect(dial.calls).toEqual([]);
    closed();
  });

  it("reads the session mode before the kernel default and follows external mode updates", async () => {
    const opened = await openSession();
    runInAction(() => {
      opened.root.permissionMode = "manual";
      dial.kernel!.root.defaultPermissionMode = "yolo";
    });
    await render();
    await interact(() => user.click(trigger("manual")));
    selected("manual");
    await interact(() => {
      runInAction(() => {
        opened.root.permissionMode = "auto";
      });
    });
    expect(trigger("auto")).toBeTruthy();
    selected("auto");
    expect(dial.calls).toEqual([]);
  });

  it("assigns a distinct native CSS anchor per instance and cleans it up on close", async () => {
    await render(
      h(
        "div",
        null,
        h(PermissionMode, { seed: "manual", onStage: vi.fn() }),
        h(PermissionMode, { seed: "auto", onStage: vi.fn() }),
      ),
    );
    const anchors: string[] = [];
    for (const label of ["manual", "auto"]) {
      const button = trigger(label);
      await interact(() => user.click(button));
      const popover = container.querySelector<HTMLElement>(".gp-native-popover")!;
      expect(popover.getAttribute("popover")).toBe("auto");
      const anchor = button.style.getPropertyValue("anchor-name");
      expect(anchor).toMatch(/^--gp-anchor-/);
      expect(popover.style.getPropertyValue("position-anchor")).toBe(anchor);
      expect(popover.style.getPropertyValue("position-area")).toBe("top span-left");
      anchors.push(anchor);
      await interact(() => user.keyboard("{Escape}"));
      closed();
      expect(button.style.getPropertyValue("anchor-name")).toBe("");
      await settleFocus();
      expect(document.activeElement).toBe(button);
    }
    expect(new Set(anchors).size).toBe(2);
  });
});
