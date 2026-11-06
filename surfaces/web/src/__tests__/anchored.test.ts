// @vitest-environment happy-dom

import { act, createElement as h, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button as AriaButton, Header } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Autocomplete,
  Dialog,
  DropdownSelect,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  NativePopover,
  SubmenuTrigger,
  Tooltip,
  type AnchoredOption,
} from "../components/ui/anchored.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
const options: AnchoredOption[] = [
  { id: "apple", label: "Apple" },
  { id: "banana", label: "Banana" },
  { id: "cherry", label: "Cherry", isDisabled: true },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}
function popup() {
  return container.querySelector<HTMLElement>(".gp-native-popover");
}
function description(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

describe("DropdownSelect", () => {
  it("opens with ArrowDown, selects with Enter, and restores trigger focus", async () => {
    const changed = vi.fn();
    await render(h(DropdownSelect, { label: "Fruit", name: "fruit", options, onSelectionChange: changed }));
    const trigger = within(container).getByRole("button", { name: /Fruit/ });
    await interact(() => user.tab());
    expect(document.activeElement).toBe(trigger);
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(container).getByRole("listbox")).toBeTruthy();
    await interact(() => user.keyboard("{Enter}"));
    expect(changed).toHaveBeenCalledWith("apple");
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("Apple");
  });

  it("Escape dismisses without changing the selected value", async () => {
    await render(h(DropdownSelect, { label: "Fruit", options, defaultSelectedKey: "banana" }));
    const trigger = within(container).getByRole("button", { name: /Fruit/ });
    await interact(() => user.click(trigger));
    expect(popup()).not.toBeNull();
    await interact(() => user.keyboard("{Escape}"));
    await settleFocus();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("Banana");
  });

  it("supports typeahead and skips disabled options", async () => {
    const changed = vi.fn();
    await render(h(DropdownSelect, { label: "Fruit", options, onSelectionChange: changed }));
    await interact(() => user.tab());
    await interact(() => user.keyboard("{ArrowDown}b{Enter}"));
    expect(changed).toHaveBeenLastCalledWith("banana");
    await interact(() => user.keyboard("{ArrowDown}{ArrowDown}{Enter}"));
    expect(changed).not.toHaveBeenCalledWith("cherry");
  });

  it("keeps hidden native select name, form data, default value, reset, and disabled semantics", async () => {
    await render(
      h(
        "form",
        { id: "fruit-form" },
        h(DropdownSelect, { label: "Fruit", name: "fruit", options, defaultSelectedKey: "apple" }),
      ),
    );
    const form = container.querySelector("form")!;
    const select = container.querySelector("select")!;
    expect(select.name).toBe("fruit");
    expect(new FormData(form).get("fruit")).toBe("apple");
    await interact(() => user.click(within(container).getByRole("button", { name: /Fruit/ })));
    await interact(() => user.click(within(container).getByRole("option", { name: "Banana" })));
    expect(new FormData(form).get("fruit")).toBe("banana");
    await interact(() => form.reset());
    expect(new FormData(form).get("fruit")).toBe("apple");
    await render(
      h(
        "form",
        null,
        h(DropdownSelect, { label: "Fruit", name: "fruit", options, defaultSelectedKey: "apple", isDisabled: true }),
      ),
    );
    expect(container.querySelector("select")?.disabled).toBe(true);
    // happy-dom currently serializes disabled native selects; browsers omit
    // them. Assert the native disabled contract without patching FormData.
    await interact(() => user.click(within(container).getByRole("button", { name: /Fruit/ })));
    expect(popup()).toBeNull();
  });

  it("connects the label, description, required state, and aria validation error", async () => {
    await render(
      h(DropdownSelect, {
        label: "Fruit",
        options,
        isRequired: true,
        isInvalid: true,
        validationBehavior: "aria",
        description: "Choose one fruit.",
        errorMessage: "A fruit is required.",
      }),
    );
    const trigger = within(container).getByRole("button", { name: /Fruit/ });
    expect(description(trigger)).toContain("Choose one fruit.");
    expect(description(trigger)).toContain("A fruit is required.");
    expect(container.querySelector(".gp-anchored-field")?.hasAttribute("data-invalid")).toBe(true);
    // In aria validation mode RAC intentionally disables native required blocking.
    expect(container.querySelector("select")?.required).toBe(false);
  });

  it("participates in native required validation and external form association", async () => {
    await render(
      h(
        "div",
        null,
        h("form", { id: "external" }),
        h(DropdownSelect, { label: "Fruit", name: "fruit", options, form: "external", isRequired: true }),
      ),
    );
    const select = container.querySelector("select")!;
    expect(select.getAttribute("form")).toBe("external");
    expect(select.validity.valueMissing).toBe(true);
    await interact(() => user.click(within(container).getByRole("button", { name: /Fruit/ })));
    await interact(() => user.click(within(container).getByRole("option", { name: "Apple" })));
    expect(select.validity.valueMissing).toBe(false);
  });

  it("synchronizes controlled open state with native toggle dismissal", async () => {
    const changed = vi.fn();
    function Controlled() {
      const [isOpen, setOpen] = useState(true);
      return h(DropdownSelect, {
        label: "Fruit",
        options,
        isOpen,
        onOpenChange: (open) => {
          changed(open);
          setOpen(open);
        },
      });
    }
    await render(h(Controlled));
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: "closed" });
    await interact(() => popup()!.dispatchEvent(event));
    expect(changed).toHaveBeenCalledWith(false);
    expect(popup()).toBeNull();
  });

  it("light dismisses in the local non-native fallback", async () => {
    await render(h("div", null, h(DropdownSelect, { label: "Fruit", options }), h("button", null, "Outside")));
    await interact(() => user.click(within(container).getByRole("button", { name: /Fruit/ })));
    await interact(() => user.click(within(container).getByRole("button", { name: "Outside" })));
    expect(popup()).toBeNull();
  });
});

describe("Autocomplete", () => {
  it("filters while typing, maintains input focus, and commits a keyboard selection", async () => {
    const changed = vi.fn();
    await render(
      h("form", null, h(Autocomplete, { label: "Fruit", name: "fruit", options, onSelectionChange: changed })),
    );
    const input = within(container).getByRole("combobox", { name: "Fruit" });
    await interact(() => user.type(input, "Ban"));
    expect(within(container).getByRole("option", { name: "Banana" })).toBeTruthy();
    expect(within(container).queryByRole("option", { name: "Apple" })).toBeNull();
    expect(document.activeElement).toBe(input);
    await interact(() => user.keyboard("{ArrowDown}{Enter}"));
    expect(changed).toHaveBeenCalledWith("banana");
    expect((input as HTMLInputElement).value).toBe("Banana");
    expect(new FormData(container.querySelector("form")!).get("fruit")).toBe("banana");
    expect(document.activeElement).toBe(input);
    expect(popup()).toBeNull();
  });

  it("opens from its button and Escape closes without stealing input focus", async () => {
    await render(h(Autocomplete, { label: "Fruit", options }));
    await interact(() => user.click(within(container).getByRole("button", { name: /Show suggestions/ })));
    expect(within(container).getAllByRole("option")).toHaveLength(3);
    await interact(() => user.keyboard("{Escape}"));
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(within(container).getByRole("combobox", { name: "Fruit" }));
  });

  it("prevents disabled controls and options from committing a value", async () => {
    const changed = vi.fn();
    await render(h(Autocomplete, { label: "Fruit", options, onSelectionChange: changed }));
    await interact(() => user.click(within(container).getByRole("button", { name: /Show suggestions/ })));
    await interact(() => user.click(within(container).getByRole("option", { name: "Cherry" })));
    expect(changed).not.toHaveBeenCalled();
    await render(h(Autocomplete, { label: "Fruit", options, isDisabled: true }));
    expect((within(container).getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
  });
});

function menu(onAction = vi.fn()) {
  return h(
    MenuTrigger,
    null,
    h(AriaButton, null, "Actions"),
    h(
      NativePopover,
      null,
      h(
        Menu,
        { onAction },
        h(MenuSection, null, h(Header, null, "Project"), h(MenuItem, { id: "rename" }, "Rename")),
        h(
          SubmenuTrigger,
          null,
          h(MenuItem, { id: "share" }, "Share"),
          h(NativePopover, null, h(Menu, { onAction }, h(MenuItem, { id: "copy" }, "Copy link"))),
        ),
        h(MenuItem, { id: "delete", isDisabled: true }, "Delete"),
      ),
    ),
  );
}

describe("Menu", () => {
  it("supports arrow/typeahead navigation, actions, disabled items, and focus return", async () => {
    const action = vi.fn();
    await render(menu(action));
    const trigger = within(container).getByRole("button", { name: "Actions" });
    await interact(() => user.tab());
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(within(container).getByRole("menu")).toBeTruthy();
    expect(within(container).getByRole("menuitem", { name: "Delete" }).getAttribute("aria-disabled")).toBe("true");
    await interact(() => user.keyboard("r{Enter}"));
    expect(action.mock.calls[0]?.[0]).toBe("rename");
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens a submenu with ArrowRight, returns with ArrowLeft, and Escape dismisses", async () => {
    await render(menu());
    await interact(() => user.tab());
    await interact(() => user.keyboard("{ArrowDown}"));
    await interact(() => user.keyboard("s"));
    expect(document.activeElement).toBe(within(container).getByRole("menuitem", { name: "Share" }));
    await interact(() => user.keyboard("{ArrowRight}"));
    expect(within(container).getAllByRole("menu")).toHaveLength(2);
    expect(document.activeElement).toBe(within(container).getByRole("menuitem", { name: "Copy link" }));
    await interact(() => user.keyboard("{ArrowLeft}"));
    expect(within(container).getAllByRole("menu")).toHaveLength(1);
    await interact(() => user.keyboard("{Escape}"));
    expect(popup()).toBeNull();
    await settleFocus();
    expect(document.activeElement).toBe(within(container).getByRole("button", { name: "Actions" }));
  });
});

describe("native overlays", () => {
  it("provides a tooltip description immediately and cancels delayed hover after leaving", async () => {
    vi.useFakeTimers();
    await render(
      h(Tooltip, { content: "Copies a link", delay: 500, closeDelay: 50, children: h("button", null, "Copy") }),
    );
    const trigger = within(container).getByRole("button", { name: "Copy" });
    expect(description(trigger)).toContain("Copies a link");
    await interact(() => trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await interact(() =>
      trigger.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })),
    );
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(popup()).toBeNull();
    await interact(() => trigger.focus());
    expect(popup()).not.toBeNull();
    await interact(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(popup()).toBeNull();
  });

  it("cancels pending hint timers when unmounted", async () => {
    vi.useFakeTimers();
    await render(h(Tooltip, { content: "Copies a link", children: h("button", null, "Copy") }));
    await interact(() =>
      within(container)
        .getByRole("button")
        .dispatchEvent(new PointerEvent("pointerover", { bubbles: true })),
    );
    await render(null);
    await act(async () => {
      vi.runAllTimers();
    });
    expect(popup()).toBeNull();
  });

  it("uses a labelled native dialog and synchronizes cancel with controlled state", async () => {
    const changed = vi.fn();
    function Example() {
      const [isOpen, setOpen] = useState(true);
      return h(Dialog, {
        label: "Delete project?",
        isOpen,
        onOpenChange: (open) => {
          changed(open);
          setOpen(open);
        },
        children: h("button", null, "Cancel"),
      });
    }
    await render(h(Example));
    const dialog = within(container).getByRole("dialog", { name: "Delete project?" }) as HTMLDialogElement;
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.open).toBe(true);
    await interact(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(changed).toHaveBeenCalledWith(false);
    expect(dialog.open).toBe(false);
  });
});
