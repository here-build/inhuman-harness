// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectHref, sessionHref } from "../path.js";
import { ProjectTabs } from "../project-tabs.js";

const state = vi.hoisted(() => ({ dial: null as unknown }));
vi.mock("../../client/context.js", () => ({ useDial: () => state.dial }));

const path = "/work/precision";
let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
  writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
  const project = { root: { path, sessions: { s1: {} }, botsRoster: {} } };
  state.dial = {
    kernel: { root: { projects: { [path]: {} }, sessions: {}, botsRoster: {} } },
    projects: new Map([[path, project]]),
    project,
    session: null,
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(projectSessions?: ReadonlyMap<string, string>) {
  const go = vi.fn();
  const onMint = vi.fn();
  await act(async () => {
    root.render(
      createElement(ProjectTabs, {
        pane: { kind: "project", path },
        projectSessions,
        go,
        onMint,
        onBrowseBots: vi.fn(),
        onAdd: vi.fn(),
      }),
    );
  });
  return { go, onMint };
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

function trigger() {
  return within(container).getByRole("button", { name: "precision menu" });
}
function item(name: string) {
  return within(container).getByRole("menuitem", { name });
}
function popup() {
  return container.querySelector<HTMLElement>(".gp-native-popover");
}
async function open() {
  await interact(() => user.click(trigger()));
}

// happy-dom exercises NativePopover's local fallback. Native top-layer layout
// and CSS anchor positioning remain the shared component's browser contract.
describe("project menu migration", () => {
  it("uses a context-aware trigger, shared menu semantics and no legacy popup positioning", async () => {
    await render();
    expect(trigger().classList.contains("project-tab-chevron")).toBe(true);
    // ARIA true is equivalent to menu; RAC emits the boolean form.
    expect(trigger().getAttribute("aria-haspopup")).toBe("true");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().hasAttribute("popovertarget")).toBe(false);
    expect(popup()).toBeNull();
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(within(container).getByRole("menu", { name: "precision menu" })).toBeTruthy();
    expect(popup()?.getAttribute("popover")).toBe("auto");
    expect(popup()?.style.getPropertyValue("position-anchor")).toMatch(/^--gp-anchor-/);
    expect(trigger().style.getPropertyValue("anchor-name")).toMatch(/^--gp-anchor-/);
    expect(container.querySelector(".project-menu")).toBeNull();
    expect(item("Copy path").classList.contains("gp-anchored-item")).toBe(true);
    const column = trigger().closest(".project-tab-menu")!;
    // Replace the old :has(.project-menu:popover-open) highlight, not its positioning.
    expect(column.classList.contains("[.project-tab:not(:has(.project-tab-main:hover))_&]:bg-hover")).toBe(true);
    await interact(() => user.keyboard("{Escape}"));
    expect(column.className).toBe("project-tab-menu");
  });

  it("supports keyboard navigation and selection, calls onMint once, closes and restores focus", async () => {
    const { go, onMint } = await render();
    await interact(() => trigger().focus());
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(item("Copy path"));
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(item("New session"));
    await interact(() => user.keyboard("{Enter}"));
    expect(onMint).toHaveBeenCalledExactlyOnceWith(path);
    expect(go).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes a pointer-selected New session exactly once", async () => {
    const { onMint } = await render();
    await open();
    await interact(() => user.click(item("New session")));
    expect(onMint).toHaveBeenCalledExactlyOnceWith(path);
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
  });

  it("dismisses with Escape or outside pointer without an action and restores focus", async () => {
    const { onMint } = await render();
    await open();
    await interact(() => user.keyboard("{Escape}"));
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
    await open();
    await interact(() => user.click(document.body));
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger());
    expect(onMint).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps pending clipboard work open, then quietly shows Copied for exactly 600ms", async () => {
    let finish!: () => void;
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await interact(() => trigger().focus());
    await interact(() => user.keyboard("{ArrowDown}{Enter}"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(path);
    expect(item("Copy path").getAttribute("aria-disabled")).toBe("true");
    expect(popup()).not.toBeNull();
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(popup()).not.toBeNull();
    await act(async () => finish());
    expect(item("Copied")).toBeTruthy();
    expect(container.querySelector('[role="alert"], [role="status"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    expect(popup()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(popup()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(40);
    });
    expect(document.activeElement).toBe(trigger());
    vi.useRealTimers();
    await open();
    expect(item("Copy path")).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("announces a useful local copy failure and allows retry", async () => {
    writeText.mockRejectedValueOnce(new Error("Permission denied"));
    await render();
    await open();
    await interact(() => user.click(item("Copy path")));
    const alert = within(container).getByRole("alert");
    expect(alert.textContent).toContain("Could not copy path");
    expect(alert.textContent).toContain(path);
    expect(item("Copy path").getAttribute("aria-describedby")).toBe(alert.id);
    expect(item("Copy path").getAttribute("aria-disabled")).not.toBe("true");
    await interact(() => user.click(item("Copy path")));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(item("Copied")).toBeTruthy();
    expect(within(container).queryByRole("alert")).toBeNull();
  });

  it("ignores clipboard completion after dismiss/reopen and clears the success close timer", async () => {
    let finish!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await open();
    await interact(() => user.click(item("Copy path")));
    await interact(() => user.keyboard("{Escape}"));
    await settleFocus();
    await open();
    await act(async () => finish());
    expect(item("Copy path")).toBeTruthy();
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(popup()).not.toBeNull();
    vi.useRealTimers();
    await interact(() => user.click(item("Copy path")));
    expect(item("Copied")).toBeTruthy();
    await interact(() => user.keyboard("{Escape}"));
    await settleFocus();
    await open();
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(item("Copy path")).toBeTruthy();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "s1", "missing"])(
    "preserves navigation semantics and native links with remembered session %s",
    async (sessionId) => {
      const { go, onMint } = await render(sessionId == null ? undefined : new Map([[path, sessionId]]));
      const href = sessionId === "s1" ? sessionHref(path, "s1") : projectHref(path);
      const link = within(container).getByRole("link", { name: "precision" });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("aria-current")).toBe("page");
      expect(within(container).getByRole("navigation", { name: "Projects" })).toBeTruthy();
      for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
        const click = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
        await interact(() => link.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(false);
      }
      expect(go).not.toHaveBeenCalled();
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      await interact(() => link.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
      expect(go).toHaveBeenCalledExactlyOnceWith(href);
      expect(onMint).not.toHaveBeenCalled();
    },
  );
});
