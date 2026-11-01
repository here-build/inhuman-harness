// @vitest-environment happy-dom

import { act, createElement as h, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Label, Link } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tokens, Navigation, VirtualizedList } from "../__stories__/graphic-precision-advanced.stories.js";
import {
  TokenField,
  TokenInput,
  Token,
  TokenFieldValue,
  NavigationTree,
  NavigationTreeItem,
  NavigationTreeItemContent,
  NavigationTreeSection,
  NavigationTreeHeader,
  RouterProvider,
  Virtualizer,
  ListLayout,
  GridLayout,
  TableLayout,
  WaterfallLayout,
  Focusable,
  Pressable,
  VisuallyHidden,
  I18nProvider,
  useFilter,
  useListData,
  useAsyncList,
  useTreeData,
} from "../components/ui/advanced.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
  // happy-dom lacks the target ranges and caret geometry used by RAC's
  // contenteditable keyboard handling. An empty range list uses DOM Selection.
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", { configurable: true, value: () => [] });
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(InputEvent.prototype, "getTargetRanges");
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

function select(node: Node, start: number, end = start) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("advanced controls", () => {
  it("preserves token refs, generic values, render props, and persistent classes", async () => {
    const fieldRef = createRef<HTMLDivElement>();
    const inputRef = createRef<HTMLDivElement>();
    const tokenRef = createRef<HTMLSpanElement>();
    const value = new TokenFieldValue([{ type: "token" as const, text: "Maya Chen", value: { id: "maya" } }]);
    const fieldClass = vi.fn(({ isReadOnly }: { isReadOnly: boolean }) =>
      isReadOnly ? "readonly-field" : "editable-field",
    );
    const inputClass = vi.fn(() => "custom-input");
    const tokenClass = vi.fn(() => "custom-token");
    // Explicit generic instantiation is also a compile-time inference/ref check.
    await render(
      h(TokenField<typeof value>, {
        ref: fieldRef,
        value,
        className: fieldClass,
        children: [
          h(Label, { key: "label" }, "Request"),
          h(TokenInput<typeof value>, {
            key: "input",
            ref: inputRef,
            className: inputClass,
            children: (segment) =>
              h(Token, {
                ref: tokenRef,
                className: tokenClass,
                children: ({ isSelected }) => `${segment.text} (${segment.value?.id})${isSelected ? " selected" : ""}`,
              }),
          }),
        ],
      }),
    );
    const input = within(container).getByRole("textbox", { name: "Request" });
    expect(fieldRef.current?.classList.contains("gp-token-field")).toBe(true);
    expect(inputRef.current).toBe(input);
    expect(input.classList.contains("gp-token-input")).toBe(true);
    expect(input.classList.contains("custom-input")).toBe(true);
    expect(tokenRef.current?.tagName).toBe("SPAN");
    expect(tokenRef.current?.classList.contains("gp-token")).toBe(true);
    expect(tokenRef.current?.textContent).toBe("Maya Chen (maya)");
    expect(fieldClass).toHaveBeenCalledWith(expect.objectContaining({ isReadOnly: false }));
    expect(inputClass).toHaveBeenCalledWith(expect.objectContaining({ isFocused: false }));
    expect(tokenClass).toHaveBeenCalledWith(expect.objectContaining({ isSelected: false }));
    expect(tokenRef.current?.className).toContain("var(--selection-marker)");
    expect(input.className).toContain("var(--focus)");
  });

  it("edits text and deletes a whole token with keyboard editing events", async () => {
    const onChange = vi.fn();
    await render(
      h(TokenField, {
        "aria-label": "Request",
        onChange,
        defaultValue: new TokenFieldValue([
          { type: "text", text: "Ask " },
          { type: "token", text: "Maya Chen" },
        ]),
        children: h(TokenInput, { children: (segment) => h(Token, null, segment.text) }),
      }),
    );
    const input = within(container).getByRole("textbox", { name: "Request" });
    await interact(() => user.tab());
    expect(document.activeElement).toBe(input);
    await interact(() => select(input.firstChild!, 0));
    await interact(() => user.keyboard("{End}"));
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(true);
    // Select the token's complete DOM wrapper, as Shift+Arrow would in a browser.
    await interact(() => select(input, 1, 2));
    await interact(() => user.keyboard("{Backspace}"));
    expect(input.textContent).toBe("Ask ");
    expect(onChange.mock.lastCall?.[0].toString()).toBe("Ask ");
    await interact(() => select(input.firstChild!, 4));
    await interact(() => user.keyboard("R"));
    expect(input.textContent).toBe("Ask R");
    expect(onChange.mock.lastCall?.[0].toString()).toBe("Ask R");
    await interact(() => user.keyboard("{Control>}z{/Control}"));
    expect(input.textContent).toBe("Ask ");
  });

  it("keeps read-only tokens focusable but immutable under typing and delete keys", async () => {
    const onChange = vi.fn();
    await render(
      h(TokenField, {
        "aria-label": "Reference copy",
        isReadOnly: true,
        onChange,
        defaultValue: new TokenFieldValue([
          { type: "text", text: "Approved by " },
          { type: "token", text: "Release team" },
        ]),
        children: h(TokenInput, { children: (segment) => h(Token, null, segment.text) }),
      }),
    );
    const input = within(container).getByRole("textbox", { name: "Reference copy" });
    expect(input.getAttribute("contenteditable")).toBe("false");
    expect(input.getAttribute("aria-readonly")).toBe("true");
    await interact(() => user.tab());
    expect(document.activeElement).toBe(input);
    const original = input.textContent;
    await interact(() => user.keyboard("replace{Backspace}{Delete}"));
    expect(input.textContent).toBe(original);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips a disabled token input in keyboard navigation", async () => {
    await render(
      h(
        "div",
        null,
        h(TokenField, {
          "aria-label": "Unavailable",
          isDisabled: true,
          children: h(TokenInput, { children: (segment) => h(Token, null, segment.text) }),
        }),
        h("button", null, "Next"),
      ),
    );
    await interact(() => user.tab());
    expect(document.activeElement).toBe(within(container).getByRole("button", { name: "Next" }));
    expect(within(container).getByRole("textbox").getAttribute("aria-disabled")).toBe("true");
  });

  it("preserves navigation refs, current-route render state, sections, and real link semantics", async () => {
    const treeRef = createRef<HTMLDivElement>();
    const itemRef = createRef<HTMLDivElement>();
    const navigate = vi.fn();
    const itemClass = vi.fn(({ isCurrent }: { isCurrent: boolean }) => (isCurrent ? "current-page" : "other-page"));
    const content = vi.fn(({ isCurrent }: { isCurrent: boolean }) =>
      h(Link, { className: "destination" }, isCurrent ? "Release plan" : "Other page"),
    );
    await render(
      h(RouterProvider, {
        navigate,
        children: h(NavigationTree, {
          ref: treeRef,
          "aria-label": "Pages",
          selectedRoute: "/release",
          className: () => "custom-tree",
          children: h(NavigationTreeSection, {
            className: "custom-section",
            children: [
              h(NavigationTreeHeader, { key: "header", className: "custom-header", children: "Workspace" }),
              h(NavigationTreeItem, {
                key: "release",
                id: "release",
                ref: itemRef,
                href: "/release",
                textValue: "Release plan",
                className: itemClass,
                children: h(NavigationTreeItemContent, { children: content }),
              }),
            ],
          }),
        }),
      }),
    );
    expect(treeRef.current?.className).toContain("gp-navigation-tree");
    expect(itemRef.current?.className).toContain("gp-navigation-tree-item");
    expect(itemRef.current?.className).toContain("current-page");
    expect(itemRef.current?.className).toContain("var(--selection-marker)");
    expect(itemRef.current?.className).toContain("var(--focus)");
    expect(container.querySelector(".gp-navigation-tree-section.custom-section")).not.toBeNull();
    expect(container.querySelector(".gp-navigation-tree-header.custom-header")?.textContent).toBe("Workspace");
    expect(content).toHaveBeenCalledWith(expect.objectContaining({ isCurrent: true }));
    const link = within(container).getByRole("link", { name: "Release plan" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/release");
    expect(link.getAttribute("aria-current")).toBe("page");
    await interact(() => user.tab());
    await interact(() => user.keyboard("{Enter}"));
    expect(navigate).toHaveBeenCalledWith("/release", undefined);
  });

  it("mounts the token story and inserts a reference", async () => {
    await render((Tokens.render as () => ReactNode)());
    const before = container.querySelectorAll(".gp-token").length;
    await interact(() => user.click(within(container).getAllByRole("button", { name: "Insert release team" })[0]!));
    expect(container.querySelectorAll(".gp-token").length).toBe(before + 1);
  });

  it("mounts the navigation story, follows a route, and collapses its branch", async () => {
    await render((Navigation.render as () => ReactNode)());
    await interact(() => user.click(within(container).getAllByRole("link", { name: "Research notes" })[0]!));
    expect(within(container).getAllByRole("link", { name: "Research notes" })[0]?.getAttribute("aria-current")).toBe(
      "page",
    );
    await interact(() => user.click(within(container).getAllByRole("button", { name: /^Collapse projects/ })[0]!));
    expect(within(container).getAllByRole("button", { name: /^Expand projects/ }).length).toBeGreaterThan(0);
  });

  it("exports installed semantic and layout APIs without substituting visual aliases", () => {
    for (const value of [
      Focusable,
      Pressable,
      VisuallyHidden,
      I18nProvider,
      RouterProvider,
      useFilter,
      useListData,
      useAsyncList,
      useTreeData,
      Virtualizer,
      ListLayout,
      GridLayout,
      TableLayout,
      WaterfallLayout,
    ]) {
      expect(value).toBeDefined();
    }
  });

  it("mounts the virtualized ListBox story and keeps its bounded styled scroll surface", async () => {
    await render((VirtualizedList.render as () => ReactNode)());
    const listbox = within(container).getAllByRole("listbox", { name: "Documents" })[0]!;
    expect(listbox.className).toContain("h-64");
    expect(listbox.className).toContain("overflow-auto");
    expect(container.querySelectorAll(".gp-virtualized-listbox-item").length).toBeLessThan(1000);
  });

  it("selects an offscreen document with the virtualized story's keyboard interaction", async () => {
    // DOM emulators have no layout; supply a viewport so RAC can virtualize rows.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(256);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    await render((VirtualizedList.render as () => ReactNode)());
    const listbox = within(container).getAllByRole("listbox", { name: "Documents" })[0]!;
    await interact(() => user.tab());
    await interact(() => user.keyboard("{End}{Enter}"));
    expect(within(container).getAllByRole("status")[0]?.textContent).toBe("Project brief 1000");
    expect(within(listbox).getByRole("option", { selected: true }).textContent).toBe("Project brief 1000");
    expect(within(listbox).getAllByRole("option").length).toBeLessThan(1000);
  });
});
