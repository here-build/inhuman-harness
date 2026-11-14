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
  ["auto", "auto"],
  ["yolo", "approve all"],
] as const;
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
function radio(label: string) {
  return within(container).getByRole<HTMLInputElement>("radio", { name: label });
}
function selected(label: string) {
  const group = within(container).getByRole("radiogroup", { name: "Permission mode" });
  const items = within(group).getAllByRole<HTMLInputElement>("radio");
  expect(items.map((item) => item.value)).toEqual(modes.map(([mode]) => mode));
  expect(items.filter((item) => item.checked)).toEqual([radio(label)]);
}
async function openSession() {
  const opened = session({ id: "permission-session", turns: [] });
  dial = new StoryDial({ kernel: kernel({ wires: [] }), sessions: [opened] });
  await dial.follow({ kind: "session", sessionId: opened.root.sessionId });
  return opened;
}

describe("permission mode text row", () => {
  it.each(modes)("shows all modes with %s selected", async (mode, label) => {
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = mode;
    });
    await render();
    selected(label);
    expect(within(container).queryByRole("menu")).toBeNull();
    expect(dial.calls).toEqual([]);
  });
  it.each([
    { staged: "yolo", seed: "auto", label: "approve all" },
    { staged: null, seed: "auto", label: "auto" },
    { staged: null, seed: null, label: "manual" },
  ] as const)("keeps staged/seed precedence local ($staged / $seed)", async ({ staged, seed, label }) => {
    await openSession();
    const onStage = vi.fn();
    await render(h(PermissionMode, { staged, seed, onStage }));
    selected(label);
    expect(within(container).queryByRole("button", { name: /Adjust auto permissions/ })).toBeNull();
    expect(onStage).not.toHaveBeenCalled();
    expect(dial.calls).toEqual([]);
  });
  it("stages every mode locally without an RPC", async () => {
    await openSession();
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
      await interact(() => user.click(radio(label)));
      expect(onStage).toHaveBeenLastCalledWith(mode);
      selected(label);
    }
    expect(onStage).toHaveBeenCalledTimes(3);
    expect(dial.calls).toEqual([]);
  });
  it.each(modes)("routes %s to the session", async (mode, label) => {
    const opened = await openSession();
    runInAction(() => {
      opened.root.permissionMode = mode === "manual" ? "auto" : "manual";
    });
    const sessionRequest = vi.spyOn(dial.sessionRpc!, "request");
    const kernelRequest = vi.spyOn(dial.kernelRpc!, "request");
    await render();
    await interact(() => user.click(radio(label)));
    expect(sessionRequest).toHaveBeenCalledExactlyOnceWith("policy/set", { policy: mode });
    expect(kernelRequest).not.toHaveBeenCalled();
    expect(opened.root.permissionMode).toBe(mode);
    selected(label);
  });
  it.each(modes)("routes %s to the kernel default without a session", async (mode, label) => {
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = mode === "manual" ? "auto" : "manual";
    });
    const request = vi.spyOn(dial.kernelRpc!, "request");
    await render();
    await interact(() => user.click(radio(label)));
    expect(request).toHaveBeenCalledExactlyOnceWith("config/set", { defaultPermissionMode: mode });
    selected(label);
  });
  it("tabs into the selected word and uses arrow keys to change modes", async () => {
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = "manual";
    });
    await render();
    await interact(() => user.tab());
    expect(document.activeElement).toBe(radio("manual"));
    await interact(() => user.keyboard("{ArrowRight}"));
    selected("auto");
    expect(document.activeElement).toBe(radio("auto"));
    await interact(() => user.keyboard("{ArrowRight}"));
    selected("approve all");
    expect(dial.calls).toEqual([
      { method: "config/set", params: { defaultPermissionMode: "auto" } },
      { method: "config/set", params: { defaultPermissionMode: "yolo" } },
    ]);
  });
  it("disables disconnected live controls but permits local staging", async () => {
    dial = new StoryDial({ kernel: null, portless: true });
    await render();
    expect(radio("auto").disabled).toBe(true);
    await interact(() => user.click(radio("manual")));
    expect(dial.calls).toEqual([]);
    const onStage = vi.fn();
    await render(h(PermissionMode, { seed: "yolo", onStage }));
    expect(radio("auto").disabled).toBe(false);
    await interact(() => user.click(radio("auto")));
    expect(onStage).toHaveBeenCalledExactlyOnceWith("auto");
    expect(dial.calls).toEqual([]);
  });
  it("follows external session updates before the kernel default", async () => {
    const opened = await openSession();
    runInAction(() => {
      opened.root.permissionMode = "manual";
      dial.kernel!.root.defaultPermissionMode = "yolo";
    });
    await render();
    selected("manual");
    await interact(() =>
      runInAction(() => {
        opened.root.permissionMode = "auto";
      }),
    );
    selected("auto");
    expect(dial.calls).toEqual([]);
  });
});
