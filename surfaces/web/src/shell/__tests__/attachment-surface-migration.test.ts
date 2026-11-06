// @vitest-environment happy-dom

import { act, createElement, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftPicture } from "../draft-slot.js";
import { PictureChips } from "../picture-chips.js";
import { PictureDrop } from "../picture-drop.js";
import { SwipeRow } from "../swipe-row.js";

const picture: DraftPicture = {
  key: "image-1",
  mime: "image/png",
  bytesBase64: "aGVsbG8=",
  width: 2,
  height: 3,
  sourcePath: "Autumn campaign.png",
};
const label = "Autumn campaign.png · image/png · 2×3";
let container: HTMLDivElement;
let root: Root;

async function render(element: ReactElement) {
  await act(async () => root.render(element));
}
function node<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (found == null) throw new Error(`missing ${selector}`);
  return found;
}
function button(name: string) {
  return node<HTMLButtonElement>(`button[aria-label="${name}"]`);
}
async function key(target: HTMLElement, value: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true, cancelable: true }));
  });
}
async function pointer(target: HTMLElement, type: string, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "touch",
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("attachment shared controls", () => {
  it("keeps batched file picking, resets the input, and opens the MIME-safe preview", async () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    await render(createElement(PictureChips, { pictures: [picture], onPick, onRemove }));
    const input = node<HTMLInputElement>('input[type="file"]');
    expect(input.getAttribute("aria-label")).toBe("Add image");
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(input.multiple).toBe(true);
    expect(input.tabIndex).toBe(-1);
    const files = [
      new File(["a"], "first.png", { type: "image/png" }),
      new File(["b"], "second.gif", { type: "image/gif" }),
    ];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(files);
    expect(input.value).toBe("");

    const preview = button(label);
    expect(preview.type).toBe("button");
    expect(preview.className).toContain("data-[pressed]");
    expect(preview.className).toContain("data-[focus-visible]:-outline-offset-2");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    await act(async () => preview.click());
    const dialog = node<HTMLDialogElement>("dialog.picture-preview");
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe(label);
    expect(dialog.querySelector("img")?.alt).toBe(label);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("names removal, shows shared keyboard focus, and ignores disabled clicks", async () => {
    const onRemove = vi.fn();
    const props = { pictures: [picture], onPick: vi.fn(), onRemove };
    await render(createElement(PictureChips, props));
    const remove = button(`Remove ${label}`);
    expect(remove.type).toBe("button");
    expect(remove.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(remove.className).toContain("data-[focus-visible]:-outline-offset-2");
    await key(document.body, "Tab");
    await act(async () => remove.focus());
    expect(document.activeElement).toBe(remove);
    expect(remove.dataset.focusVisible).toBe("true");
    await key(remove, "Enter");
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(picture.key);

    onRemove.mockClear();
    await render(createElement(PictureChips, { ...props, disabled: true }));
    expect(button(label).disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(node<HTMLInputElement>('input[type="file"]').disabled).toBe(true);
    await act(async () => remove.click());
    await key(remove, "Enter");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("disables missing or remote preview bytes without disabling removal", async () => {
    const onRemove = vi.fn();
    for (const bytesBase64 of ["", "https://example.com/remote.png"]) {
      await render(createElement(PictureChips, { pictures: [{ ...picture, bytesBase64 }], onPick: vi.fn(), onRemove }));
      const preview = button(label);
      expect(preview.disabled).toBe(true);
      expect(preview.querySelector("img")).toBeNull();
      await act(async () => preview.click());
      expect(container.querySelector("dialog")).toBeNull();
      expect(button(`Remove ${label}`).disabled).toBe(false);
    }
    await act(async () => button(`Remove ${label}`).click());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(picture.key);
  });

  it("retains the drop ref, batched files, phase feedback, and disabled cleanup", async () => {
    const fieldRef = createRef<HTMLDivElement>();
    const onDrop = vi.fn();
    const props = { fieldRef, onDrop, children: createElement("span", null, "Draft") };
    await render(createElement(PictureDrop, { ...props, enabled: true }));
    expect(fieldRef.current).toBe(node(".composer-pill"));
    const data = new DataTransfer();
    const first = new File(["a"], "one.png", { type: "image/png" });
    const second = new File(["b"], "two.webp", { type: "image/webp" });
    data.items.add(first);
    data.items.add(second);
    const drag = async (type: string) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: data });
      await act(async () => fieldRef.current?.dispatchEvent(event));
      return event;
    };
    await drag("dragenter");
    expect(fieldRef.current?.dataset.drop).toBe("hot");
    const overlay = node(".composer-drop");
    expect(overlay.textContent).toBe("Drop here");
    expect(overlay.classList.contains("label")).toBe(true);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    const dropped = await drag("drop");
    expect(dropped.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith([first, second]);
    expect(fieldRef.current?.dataset.drop).toBeUndefined();
    await drag("dragenter");
    await render(createElement(PictureDrop, { ...props, enabled: false }));
    expect(fieldRef.current?.dataset.drop).toBeUndefined();
    expect(container.querySelector(".composer-drop")).toBeNull();
    const disabledDrop = await drag("drop");
    expect(disabledDrop.defaultPrevented).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("swipe control boundary", () => {
  function row(disabled = false) {
    const onToggle = vi.fn();
    const onPress = vi.fn();
    const element = createElement(SwipeRow, {
      label: "Enable Autumn campaign",
      title: "Autumn campaign",
      detail: "Ready to use",
      checked: true,
      disabled,
      trailing: { label: "Delete", name: "Delete Autumn campaign", tone: "destructive", onPress },
      onToggle,
    });
    return { element, onToggle, onPress };
  }

  it("keeps the gesture switch and exposes named, symbol-styled actions by arrow key", async () => {
    const { element, onToggle, onPress } = row();
    await render(element);
    const main = node<HTMLButtonElement>('[role="switch"]');
    const action = button("Delete Autumn campaign");
    expect(main.getAttribute("aria-checked")).toBe("true");
    expect(main.className).toContain("focus-visible:outline-[var(--focus)]");
    expect(main.className).toContain("data-[pressed]");
    expect(main.classList.contains("label")).toBe(false);
    expect(main.querySelector(".settings-grow")?.className).not.toContain("mono");
    expect(action.className).toContain("data-[pressed]");
    expect(action.className).toContain("data-[focus-visible]:-outline-offset-2");
    expect(action.querySelector(".label")?.textContent).toBe("Delete");
    expect(action.tabIndex).toBe(-1);
    expect(action.getAttribute("aria-hidden")).toBe("true");
    await key(main, "ArrowLeft");
    expect(action.tabIndex).toBe(0);
    expect(action.hasAttribute("aria-hidden")).toBe(false);
    await key(document.body, "Tab");
    await act(async () => action.focus());
    expect(action.dataset.focusVisible).toBe("true");
    await act(async () => action.click());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(action.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(main);
    await act(async () => main.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on a surviving row while its action is busy without stealing it back", async () => {
    const props = {
      label: "Enable Autumn campaign",
      title: "Autumn campaign",
      detail: "Ready",
      checked: true,
      onToggle: vi.fn(),
      trailing: { label: "Log in", name: "Log in to Autumn campaign", tone: "action" as const, onPress: vi.fn() },
    };
    await render(createElement(SwipeRow, props));
    const main = node<HTMLButtonElement>('[role="switch"]');
    await key(main, "ArrowLeft");
    await act(async () => button("Log in to Autumn campaign").focus());
    await render(createElement(SwipeRow, { ...props, disabled: true }));
    expect(document.activeElement).toBe(node(".swipe-clip"));
    await render(createElement(SwipeRow, props));
    expect(document.activeElement).toBe(main);
    await render(createElement(SwipeRow, { ...props, disabled: true }));
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    await render(createElement(SwipeRow, props));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("does not claim vertical scroll and preserves horizontal capture and click suppression", async () => {
    const { element, onToggle, onPress } = row();
    await render(element);
    const main = node<HTMLButtonElement>('[role="switch"]');
    const capture = vi.fn();
    Object.defineProperty(main, "setPointerCapture", { configurable: true, value: capture });
    await pointer(main, "pointerdown", 100, 100);
    await pointer(main, "pointermove", 94, 150);
    expect(capture).not.toHaveBeenCalled();
    await pointer(main, "pointerup", 94, 150);
    await pointer(main, "pointerdown", 100, 100);
    await pointer(main, "pointermove", 50, 102);
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    expect(node<HTMLElement>(".swipe-clip").dataset.dragging).toBe("true");
    await pointer(main, "pointerup", 50, 102);
    expect(node<HTMLElement>(".swipe-clip").dataset.dragging).toBe("false");
    await act(async () => main.click());
    expect(onToggle).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("keeps disabled switch and action clicks inert", async () => {
    const { element, onToggle, onPress } = row(true);
    await render(element);
    const main = node<HTMLButtonElement>('[role="switch"]');
    const action = button("Delete Autumn campaign");
    expect(main.disabled).toBe(true);
    expect(action.disabled).toBe(true);
    await act(async () => {
      main.click();
      action.click();
    });
    expect(onToggle).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });
});
