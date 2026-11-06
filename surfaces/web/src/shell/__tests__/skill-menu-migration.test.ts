// @vitest-environment happy-dom

import { act, createElement as h, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillSlashMenu } from "../skill-slash-menu.js";
import type { SkillSlashRow } from "../skill-slash.js";
import { useSkillSlash } from "../use-skill-slash.js";

type Slash = ReturnType<typeof useSkillSlash>;
const rows: readonly SkillSlashRow[] = [
  { name: "review", invoke: "skill:review", description: "Review changes, preserving natural Case." },
  { name: "undo", invoke: "skill:undo", description: "A skill, not a host command." },
  { name: "literal", invoke: 'Team:<Review>&"Exact"', description: '<b>Literal</b> & "readable" description.' },
];
let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
let latest: Slash;
const sent = vi.fn();
const escaped = vi.fn();
const changed = vi.fn();
let nativeOpen: Set<HTMLElement>;
let show: ReturnType<typeof vi.fn>;
let hide: ReturnType<typeof vi.fn>;
let originalShow: PropertyDescriptor | undefined;
let originalHide: PropertyDescriptor | undefined;

function Harness({
  scope = "one",
  catalog = rows,
  disabled = false,
}: {
  scope?: string;
  catalog?: readonly SkillSlashRow[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const slash = useSkillSlash({
    scope,
    rows: catalog,
    value,
    disabled,
    fieldRef,
    onChange: (next) => {
      changed(next);
      setValue(next);
    },
  });
  latest = slash;
  return h(
    "div",
    {
      onKeyDown: (event) => {
        if (event.key === "Escape") escaped();
      },
    },
    h(SkillSlashMenu, { menu: slash.menu }),
    h("label", { htmlFor: "draft" }, "Message draft"),
    h("textarea", {
      ...slash.fieldProps,
      id: "draft",
      ref: fieldRef,
      value,
      disabled,
      onChange: (event) => {
        setValue(event.currentTarget.value);
        slash.track(event.currentTarget);
      },
      onKeyDown: (event) => {
        if (slash.onKeyDown(event)) return;
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sent(value);
        }
      },
    }),
    h("button", { type: "button" }, "Outside"),
  );
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await interact(() => root.render(h(Harness, props)));
}
const field = () => within(container).getByRole<HTMLTextAreaElement>("textbox", { name: "Message draft" });
const menu = () => within(container).queryByRole("listbox", { name: "Skills" });
const options = () => within(container).getAllByRole("option");
const selected = () => within(container).getByRole("option", { selected: true });
const popup = () => container.querySelector<HTMLElement>(".skill-slash-popover")!;
const byId = (id: string) => document.querySelector(`#${CSS.escape(id)}`);
async function type(value = "/") {
  await interact(() => user.type(field(), value));
}
async function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await interact(() => field().dispatchEvent(event));
  return event.defaultPrevented;
}
function toggle(node: HTMLElement, newState: "open" | "closed") {
  const event = new Event("toggle");
  Object.defineProperties(event, {
    newState: { value: newState },
    oldState: { value: newState === "open" ? "closed" : "open" },
  });
  node.dispatchEvent(event);
}
function closed() {
  expect(menu()).toBeNull();
  expect(container.querySelector("[popover]")).toBeNull();
  expect(field().hasAttribute("aria-activedescendant")).toBe(false);
  expect(field().hasAttribute("aria-controls")).toBe(false);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent.mockClear();
  escaped.mockClear();
  changed.mockClear();
  nativeOpen = new Set();
  // Local lifecycle stubs only: no global fallback/polyfill or positioning mock.
  originalShow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
  originalHide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");
  show = vi.fn(function (this: HTMLElement) {
    nativeOpen.add(this);
    toggle(this, "open");
  });
  hide = vi.fn(function (this: HTMLElement) {
    nativeOpen.delete(this);
    toggle(this, "closed");
  });
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: show },
    hidePopover: { configurable: true, value: hide },
  });
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: HTMLElement, selector) {
    return selector === ":popover-open" ? nativeOpen.has(this) : matches.call(this, selector);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});
afterEach(async () => {
  await interact(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (originalShow) Object.defineProperty(HTMLElement.prototype, "showPopover", originalShow);
  else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  if (originalHide) Object.defineProperty(HTMLElement.prototype, "hidePopover", originalHide);
  else Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  vi.unstubAllGlobals();
});

describe("skill suggestion migration", () => {
  it("keeps a native multiline textbox controlling live, named and described options without focus theft", async () => {
    await render();
    await type();
    expect(field().tagName).toBe("TEXTAREA");
    expect(field().getAttribute("role")).toBeNull();
    expect(within(container).queryByRole("combobox")).toBeNull();
    expect(within(container).queryByRole("menu")).toBeNull();
    expect(field().getAttribute("aria-autocomplete")).toBe("list");
    expect(byId(field().getAttribute("aria-controls")!)).toBe(menu());
    expect(byId(field().getAttribute("aria-activedescendant")!)).toBe(selected());
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    const first = within(menu()!).getByRole("option", { name: "/skill:review" });
    expect(byId(first.getAttribute("aria-describedby")!)?.textContent).toBe(rows[0]!.description);
    expect(first.className).toContain("border-[var(--selection-marker)]");
    expect(first.className).toContain("bg-selected");
    expect(first.querySelector("code")?.className).toContain("font-mono");
    expect(first.querySelector("[id$='-description']")?.className).toContain("font-sans");
    expect(options().every((option) => option.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(1);
    expect(field().selectionEnd).toBe(1);
  });

  it("opens/closes the shared native CSS-anchored surface and restores the previous anchor, not focus", async () => {
    await render();
    field().style.setProperty("anchor-name", "--previous-anchor");
    await type();
    const surface = popup();
    expect(surface.getAttribute("popover")).toBe("auto");
    expect(Object.hasOwn(surface.dataset, "nativeFallback")).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(nativeOpen.has(surface)).toBe(true);
    const anchor = field().style.getPropertyValue("anchor-name");
    expect(anchor).toMatch(/^--gp-anchor-/);
    expect(surface.style.getPropertyValue("position-anchor")).toBe(anchor);
    await interact(() => user.keyboard("{Escape}"));
    closed();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(nativeOpen.has(surface)).toBe(false);
    expect(field().style.getPropertyValue("anchor-name")).toBe("--previous-anchor");
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("/");
    expect(escaped).not.toHaveBeenCalled();
  });

  it.each(["{Enter}", "{Tab}"])(
    "wraps navigation and completes with %s without sending or moving focus",
    async (key) => {
      await render();
      await type();
      await interact(() => user.keyboard("{ArrowUp}"));
      expect(selected().textContent).toContain(rows[2]!.invoke);
      await interact(() => user.keyboard("{ArrowDown}{ArrowDown}"));
      expect(selected().textContent).toContain("/skill:undo");
      expect(field().getAttribute("aria-activedescendant")).toBe(selected().id);
      await interact(() => user.keyboard(key));
      expect(field().value).toBe("/skill:undo ");
      expect([field().selectionStart, field().selectionEnd]).toEqual([12, 12]);
      expect(document.activeElement).toBe(field());
      closed();
      expect(sent).not.toHaveBeenCalled();
      await interact(() => user.type(field(), "explain the change{Enter}"));
      expect(sent).toHaveBeenCalledWith("/skill:undo explain the change");
    },
  );

  it.each(["{Control>}{Enter}{/Control}", "{Meta>}{Enter}{/Meta}", "{Alt>}{Enter}{/Alt}"])(
    "preserves modified Enter completion: %s",
    async (keys) => {
      await render();
      await type("/un");
      await interact(() => user.keyboard(keys));
      expect(field().value).toBe("/skill:undo ");
      expect(sent).not.toHaveBeenCalled();
      closed();
    },
  );

  it("leaves Shift+Enter/Tab and modified Escape behavior unchanged", async () => {
    await render();
    await type("/un");
    expect(await press("Enter", { shiftKey: true })).toBe(false);
    expect(await press("Tab", { shiftKey: true })).toBe(false);
    expect(field().value).toBe("/un");
    expect(menu()).not.toBeNull();
    expect(await press("Escape", { shiftKey: true })).toBe(true);
    closed();
    expect(escaped).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    await interact(() => user.keyboard("d"));
    expect(menu()).not.toBeNull();
  });

  it("preserves pointer selection and exact escaped technical invocation as text, not markup", async () => {
    await render();
    await type();
    const option = within(menu()!).getByRole("option", { name: '/Team:<Review>&"Exact"' });
    expect(option.querySelector("b, review")).toBeNull();
    expect(byId(option.getAttribute("aria-describedby")!)?.textContent).toBe(rows[2]!.description);
    await interact(() => user.pointer({ target: option, keys: "[MouseLeft>]" }));
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([1, 1]);
    await interact(() => user.pointer({ target: option, keys: "[/MouseLeft]" }));
    expect(field().value).toBe('/Team:<Review>&"Exact" ');
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(field().value.length);
    closed();
  });

  it("does not truncate accessible descriptions or invent missing description relationships", async () => {
    const description = "A long natural description. ".repeat(20);
    await render({ catalog: [{ name: "long", description }, { name: "bare" }] });
    await type();
    const option = within(menu()!).getByRole("option", { name: "/long" });
    expect(byId(option.getAttribute("aria-describedby")!)?.textContent).toBe(description);
    expect(within(menu()!).getByRole("option", { name: "/bare" }).hasAttribute("aria-describedby")).toBe(false);
  });

  it("hides through composition and ignores both native IME Enter and legacy keyCode 229", async () => {
    await render();
    await type("/un");
    expect(await press("Enter", { isComposing: true })).toBe(false);
    expect(await press("Enter", { keyCode: 229 })).toBe(false);
    const stale = latest.menu!;
    await interact(() => field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    closed();
    await interact(() => stale.choose(rows[1]!));
    await press("Enter", { isComposing: true });
    expect(changed).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    await interact(() => field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    expect(menu()).not.toBeNull();
    expect(field().value).toBe("/un");
  });

  it("rejects stale catalog/scope handlers and resets selection to a live option", async () => {
    await render();
    await type();
    await interact(() => user.keyboard("{ArrowDown}"));
    const oldCatalog = latest.menu!;
    const catalog = [{ ...rows[0]!, invoke: "agents:review" }];
    await render({ catalog });
    await interact(() => {
      oldCatalog.choose(rows[1]!);
      oldCatalog.dismiss();
    });
    expect(changed).not.toHaveBeenCalled();
    expect(selected().textContent).toContain("/agents:review");
    expect(byId(field().getAttribute("aria-activedescendant")!)).toBe(selected());
    const oldScope = latest.menu!;
    await render({ scope: "two", catalog });
    await interact(() => {
      oldScope.choose(catalog[0]!);
      oldScope.dismiss();
    });
    expect(changed).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
    await interact(() => user.keyboard("{Tab}"));
    expect(field().value).toBe("/agents:review ");
  });

  it("clears virtual focus on blur, disabled state, and range selections without stealing focus back", async () => {
    await render();
    await type();
    const stale = latest.menu!;
    const outside = within(container).getByRole("button", { name: "Outside" });
    await interact(() => user.click(outside));
    closed();
    await interact(() => stale.choose(rows[0]!));
    expect(changed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    await interact(() => user.click(field()));
    expect(menu()).not.toBeNull();
    await interact(() => {
      field().setSelectionRange(0, 1);
      document.dispatchEvent(new Event("selectionchange"));
    });
    closed();
    await interact(() => {
      field().setSelectionRange(1, 1);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(menu()).not.toBeNull();
    await render({ disabled: true });
    closed();
    expect(field().value).toBe("/");
  });

  it("synchronizes native light dismissal and ignores a delayed closed toggle after reopen", async () => {
    await render();
    await type();
    const surface = popup();
    // Simulate the browser closing the native auto popover without moving DOM focus.
    await interact(() => surface.hidePopover());
    closed();
    expect(field().value).toBe("/");
    expect(document.activeElement).toBe(field());
    await interact(() => user.keyboard("r"));
    const reopened = popup();
    expect(nativeOpen.has(reopened)).toBe(true);
    await interact(() => toggle(reopened, "closed"));
    expect(menu()).not.toBeNull();
    expect(field().getAttribute("aria-activedescendant")).toBe(selected().id);
    await interact(() => root.render(null));
    expect(nativeOpen.size).toBe(0);
  });
});
