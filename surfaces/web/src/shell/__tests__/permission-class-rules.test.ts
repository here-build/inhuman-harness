// @vitest-environment happy-dom

import { act, createElement as h, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kernel, session, StoryDial } from "../../__stories__/world.js";
import { overridesOf, PermissionMode } from "../permission-mode.js";

let dial: StoryDial;
vi.mock("../../client/context.js", () => ({ useDial: () => dial }));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opened = session({ id: "rules-session", turns: [] });
  dial = new StoryDial({ kernel: kernel({ wires: [] }), sessions: [opened] });
  await dial.follow({ kind: "session", sessionId: opened.root.sessionId });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("per-class rules", () => {
  it("opens from Auto's sprocket without changing mode and restores focus on Escape", async () => {
    runInAction(() => {
      dial.session!.root.permissionMode = "manual";
    });
    const user = userEvent.setup({ document });
    await act(async () => root.render(h(PermissionMode)));
    const trigger = within(container).getByRole("button", { name: "Adjust auto permissions" });
    await act(async () => user.click(trigger));
    expect(within(container).getByRole("dialog", { name: "Auto permissions" })).toBeDefined();
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "manual" }).checked).toBe(true);
    expect(dial.calls.filter((call) => call.method === "policy/set")).toEqual([]);
    await act(async () => user.tab());
    await act(async () => user.keyboard("{Escape}"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(within(container).queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("shows and clears a classifier failure on the auto-mode control itself", async () => {
    const sessionRoot = dial.session?.root;
    if (sessionRoot == null) throw new Error("The test session is not attached");
    runInAction(() => {
      sessionRoot.permissionMode = "auto";
      sessionRoot.kvs.judgeConnection = "local";
      sessionRoot.kvs.judgeModel = "judge";
    });
    await act(async () => root.render(h(PermissionMode)));
    expect(within(container).getByRole("radio", { name: "auto" })).toBeDefined();
    await act(async () =>
      runInAction(() => {
        sessionRoot.autoModeProblems["local\njudge"] = "No models loaded";
      }),
    );
    expect(within(container).getByRole("status").textContent).toContain("No models loaded");
    await act(async () =>
      runInAction(() => {
        delete sessionRoot.autoModeProblems["local\njudge"];
      }),
    );
    expect(within(container).getByRole("radio", { name: "auto" })).toBeDefined();
  });
  it("reads overrides by scope and source", () => {
    const sessionLayer = JSON.stringify({
      manual: { classes: { "package-install": "allow" } },
      auto: { classes: { "package-install": "allow" } },
      yolo: { classes: { "package-install": "allow" } },
    });
    const rows = overridesOf(
      { authorizationUserJson: "", authorizationProjectJson: "", authorizationOverlayJson: sessionLayer },
      "manual",
      "",
    );
    expect({
      install: rows.find((row) => row.id === "package-install"),
      network: rows.find((row) => row.id === "network-egress"),
    }).toEqual({
      install: { id: "package-install", effective: "always", session: "always", project: null, source: "session" },
      network: { id: "network-egress", effective: "manual", session: null, project: null, source: "" },
    });
  });

  it("offers always only on unrisky classes and writes a pick at the chosen scope", async () => {
    runInAction(() => {
      dial.session!.root.permissionMode = "manual";
    });
    const user = userEvent.setup({ document });
    await act(async () => root.render(h(PermissionMode)));
    await act(async () => user.click(within(container).getByRole("button", { name: "Adjust auto permissions" })));
    const panel = within(container).getByRole("dialog", { name: "Auto permissions" });
    const install = within(panel).getByRole("radiogroup", { name: "Installs packages" });
    const credential = within(panel).getByRole("radiogroup", { name: "Touches credentials" });
    expect(within(credential).queryByRole("radio", { name: "always" })).toBeNull();
    await act(async () => user.click(within(panel).getByRole("radio", { name: "this project" })));
    await act(async () => user.click(within(install).getByRole("radio", { name: "always" })));
    expect(dial.calls.filter((call) => call.method === "policy/class-mode")).toEqual([
      { method: "policy/class-mode", params: { class: "package-install", mode: "always", scope: "project" } },
    ]);
  });

  it("keeps staged/seed precedence local without RPCs and disables live controls when disconnected", async () => {
    type Mode = NonNullable<ComponentProps<typeof PermissionMode>["staged"]>;
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

    const user = userEvent.setup({ document });
    await act(async () => root.render(h(PermissionMode, { staged: "yolo", seed: "auto", onStage: vi.fn() })));
    expect(within(container).queryByRole("button", { name: /Adjust auto permissions/ })).toBeNull();
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "approve all" }).checked).toBe(true);

    await act(async () => root.render(h(Staged)));
    await act(async () => user.click(within(container).getByRole("radio", { name: "approve all" })));
    expect(onStage).toHaveBeenCalledExactlyOnceWith("yolo");
    expect(dial.calls).toEqual([]);

    dial.kernel?.destroy();
    dial = new StoryDial({ kernel: null, portless: true });
    await act(async () => root.render(h(PermissionMode)));
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "auto" }).disabled).toBe(true);
    await act(async () => user.click(within(container).getByRole("radio", { name: "manual" })));
    expect(dial.calls).toEqual([]);

    const offlineStage = vi.fn();
    await act(async () => root.render(h(PermissionMode, { seed: "yolo", onStage: offlineStage })));
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "auto" }).disabled).toBe(false);
    await act(async () => user.click(within(container).getByRole("radio", { name: "auto" })));
    expect(offlineStage).toHaveBeenCalledExactlyOnceWith("auto");
    expect(dial.calls).toEqual([]);
  });

  it("routes live mode changes to session vs kernel and follows external MobX updates", async () => {
    const opened = dial.session!;
    runInAction(() => {
      opened.root.permissionMode = "manual";
      dial.kernel!.root.defaultPermissionMode = "yolo";
    });
    const sessionRequest = vi.spyOn(dial.sessionRpc!, "request");
    const kernelRequest = vi.spyOn(dial.kernelRpc!, "request");
    const user = userEvent.setup({ document });

    await act(async () => root.render(h(PermissionMode)));
    await act(async () => user.click(within(container).getByRole("radio", { name: "approve all" })));
    expect(sessionRequest).toHaveBeenCalledExactlyOnceWith("policy/set", { policy: "yolo" });
    expect(kernelRequest).not.toHaveBeenCalled();

    await act(async () =>
      runInAction(() => {
        opened.root.permissionMode = "auto";
      }),
    );
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "auto" }).checked).toBe(true);

    await act(async () => root.unmount());
    root = createRoot(container);
    dial.session?.destroy();
    for (const project of dial.projects.values()) project.destroy();
    dial.kernel?.destroy();
    dial = new StoryDial({ kernel: kernel({ wires: [] }) });
    runInAction(() => {
      dial.kernel!.root.defaultPermissionMode = "manual";
    });
    await act(async () => root.render(h(PermissionMode)));
    await act(async () => user.tab());
    await act(async () => user.keyboard("{ArrowRight}"));
    expect(dial.calls).toEqual([{ method: "config/set", params: { defaultPermissionMode: "auto" } }]);
    expect(within(container).getByRole<HTMLInputElement>("radio", { name: "auto" }).checked).toBe(true);
  });
});
