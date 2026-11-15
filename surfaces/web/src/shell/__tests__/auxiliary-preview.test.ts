// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BeatTimeline, Tape } from "@inhuman.tools/harness-transcript";
import { groupBeats } from "@inhuman.tools/harness-transcript/tape-beats";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionStage } from "../../__stories__/story-app.js";
import { read, session, speech, tool, write, type StoryDial } from "../../__stories__/world.js";
import { DialProvider } from "../../client/context.js";
import { FilePreviewProvider, useFilePreview } from "../file-sidebar.js";
import { readTarget } from "../path.js";

function previewIn(container: HTMLElement) {
  return container.querySelector<HTMLElement>(".auxiliary-preview")!;
}

async function hoverIn(container: HTMLElement, enter: boolean, target: HTMLElement = previewIn(container)) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", { bubbles: true }));
  });
}

describe("auxiliary transcript previews", () => {
  let container: HTMLDivElement;
  let root: Root;

  const preview = () => previewIn(container);
  const hover = (enter: boolean, target: HTMLElement = preview()) => hoverIn(container, enter, target);

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(BeatTimeline, {
          beats: groupBeats([
            {
              kind: "speech",
              id: "answer",
              text: "The main answer",
              thought: "Long reasoning with a [link](https://example.com).\n\n".repeat(30),
            },
            { kind: "round", id: "second-round" },
            { kind: "speech", id: "second-answer", text: "Another answer", thought: "Short reasoning" },
          ]),
          onOpen: () => undefined,
        }),
      );
    });
    // happy-dom does not perform layout; model a clamped source explicitly.
    vi.spyOn(preview().querySelector<HTMLElement>(".auxiliary-content")!, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(preview().querySelector<HTMLElement>(".auxiliary-content")!, "scrollHeight", "get").mockReturnValue(300);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("does not render a popup on hover or focus when the full content fits", async () => {
    const content = preview().querySelector<HTMLElement>(".auxiliary-content")!;
    vi.spyOn(content, "scrollHeight", "get").mockReturnValue(100);
    await hover(true);
    expect(preview().querySelector(".auxiliary-popup")).toBeNull();
    await act(async () => preview().focus());
    expect(preview().querySelector(".auxiliary-popup")).toBeNull();
  });

  it("immediately dismisses the previous popup and highlight when entering another note", async () => {
    const first = preview();
    const other = [...container.querySelectorAll<HTMLElement>(".auxiliary-preview")].find((note) => note !== first);
    expect(other).toBeTruthy();
    await act(async () => first.focus());
    expect(first.querySelector(".auxiliary-popup")).not.toBeNull();
    await hover(false, first);
    await hover(true, other!);
    // No timer advancement, even if the previous note retains keyboard focus.
    expect(first.querySelector(".auxiliary-popup")).toBeNull();
    expect(first.dataset.previewOpen).toBeUndefined();
  });

  it("detects a cropped nested label even when the outer region fits", async () => {
    const content = preview().querySelector<HTMLElement>(".auxiliary-content")!;
    vi.spyOn(content, "scrollHeight", "get").mockReturnValue(100);
    const label = content.querySelector<HTMLElement>("p")!;
    vi.spyOn(label, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(label, "scrollWidth", "get").mockReturnValue(200);
    await hover(true);
    expect(preview().querySelector(".auxiliary-popup")).not.toBeNull();
  });

  it("leaves the source untouched and renders a separate anchored popup when hovered", async () => {
    const note = preview();
    const content = note.querySelector(".auxiliary-content");
    expect(note.dataset.previewOpen !== undefined).toBe(false);
    await hover(true);
    expect(note.dataset.previewOpen !== undefined).toBe(true);
    expect(note.style.blockSize).toBe("");
    const popup = note.querySelector<HTMLElement>(".auxiliary-popup")!;
    expect(popup.getAttribute("popover")).toBe("manual");
    expect(popup.dataset.nativeFallback !== undefined).toBe(true);
    expect(popup.style.getPropertyValue("position-anchor")).toBe("");
    expect(popup.style.getPropertyValue("--rt-aux-left")).not.toBe("");
    expect(popup.style.getPropertyValue("--rt-y")).not.toBe("");
    expect(popup.textContent).toBe(content?.textContent);
    expect(note.querySelector(".auxiliary-content")).toBe(content);
    expect(note.querySelectorAll(".tape-thought")).toHaveLength(2);
    expect(container.querySelector(".assistant-body")?.textContent).toBe("The main answer");
    await hover(false);
    await act(async () => vi.advanceTimersByTime(200));
    expect(note.dataset.previewOpen !== undefined).toBe(false);
    expect(note.style.blockSize).toBe("");
    expect(note.querySelector(".auxiliary-popup")).toBeNull();
  });

  it("allows crossing the gutter and entering the popup before dismissing", async () => {
    await hover(true);
    await hover(false);
    await act(async () => vi.advanceTimersByTime(100));
    await hover(true, preview().querySelector<HTMLElement>(".auxiliary-popup")!);
    await act(async () => vi.advanceTimersByTime(200));
    expect(preview().dataset.previewOpen !== undefined).toBe(true);
  });

  it("opens on keyboard focus, keeps focused content open, and dismisses on Escape or blur", async () => {
    const note = preview();
    await act(async () => note.focus());
    expect(note.dataset.previewOpen !== undefined).toBe(true);
    await hover(false);
    await act(async () => vi.advanceTimersByTime(200));
    expect(note.dataset.previewOpen !== undefined).toBe(true);
    const link = note.querySelector<HTMLAnchorElement>("a")!;
    await act(async () => link.focus());
    expect(note.dataset.previewOpen !== undefined).toBe(true);
    await act(async () => {
      link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(note.dataset.previewOpen !== undefined).toBe(false);
    await act(async () => note.focus());
    expect(note.dataset.previewOpen !== undefined).toBe(true);
    await act(async () => note.blur());
    expect(note.dataset.previewOpen !== undefined).toBe(false);
  });

  it("promotes to native manual popover, stops Escape propagation, and dismisses on outside pointerdown", async () => {
    const note = preview();
    const openPopovers = new WeakSet<Element>();
    const popoverNames = ["showPopover", "hidePopover", "matches"] as const;
    const originalDescriptors = popoverNames.map((name) =>
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
    );
    const matchesDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "matches");
    const nativeMatches = matchesDescriptor?.value as ((this: Element, selector: string) => boolean) | undefined;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      if (selector === ":popover-open") return openPopovers.has(this);
      return nativeMatches?.call(this, selector) ?? false;
    });
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value(this: HTMLElement) {
        openPopovers.add(this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", {
      configurable: true,
      value(this: HTMLElement) {
        openPopovers.delete(this);
      },
    });

    const onBodyKeyDown = vi.fn();
    document.body.addEventListener("keydown", onBodyKeyDown);
    try {
      await act(async () => note.focus());
      const popup = note.querySelector<HTMLElement>(".auxiliary-popup")!;
      expect(popup).not.toBeNull();
      expect(popup.getAttribute("popover")).toBe("manual");
      expect(popup.dataset.nativeFallback !== undefined).toBe(false);
      expect(openPopovers.has(popup)).toBe(true);

      await act(async () => {
        note.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(onBodyKeyDown).not.toHaveBeenCalled();
      expect(openPopovers.has(popup)).toBe(false);
      expect(note.querySelector(".auxiliary-popup")).toBeNull();

      await act(async () => note.blur());
      await act(async () => note.focus());
      const reopened = note.querySelector<HTMLElement>(".auxiliary-popup")!;
      expect(openPopovers.has(reopened)).toBe(true);
      await act(async () => {
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
      expect(openPopovers.has(reopened)).toBe(false);
      expect(note.querySelector(".auxiliary-popup")).toBeNull();
    } finally {
      document.body.removeEventListener("keydown", onBodyKeyDown);
      if (note.querySelector(".auxiliary-popup") != null) {
        await act(async () => note.blur());
      }
      for (const [index, name] of popoverNames.entries()) {
        const descriptor = originalDescriptors[index];
        if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
        else Object.defineProperty(HTMLElement.prototype, name, descriptor);
      }
    }
  });
});

describe("specialized transcript controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let user: ReturnType<typeof userEvent.setup>;
  let dial: StoryDial | undefined;
  let openPopovers: WeakSet<Element>;
  let hovered: WeakSet<Element>;
  const popoverNames = ["showPopover", "hidePopover", "matches"] as const;
  let originalDescriptors: readonly (PropertyDescriptor | undefined)[];

  function PreviewReceipt() {
    const { file } = useFilePreview();
    return createElement("output", { "aria-label": "Opened file" }, file == null ? "" : JSON.stringify(file));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    user = userEvent.setup({ document });
    openPopovers = new WeakSet();
    hovered = new WeakSet();
    originalDescriptors = popoverNames.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    const matchesDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "matches");
    const nativeMatches = matchesDescriptor?.value as ((this: Element, selector: string) => boolean) | undefined;
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
      if (selector === ":popover-open") return openPopovers.has(this);
      if (selector === ":hover") return hovered.has(this);
      return nativeMatches?.call(this, selector) ?? false;
    });
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value(this: HTMLElement) {
        openPopovers.add(this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", {
      configurable: true,
      value(this: HTMLElement) {
        openPopovers.delete(this);
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dial?.session?.destroy();
    for (const project of dial?.projects.values() ?? []) project.destroy();
    dial?.kernel?.destroy();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [index, name] of popoverNames.entries()) {
      const descriptor = originalDescriptors[index];
      if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
      else Object.defineProperty(HTMLElement.prototype, name, descriptor);
    }
    vi.unstubAllGlobals();
  });

  async function interact(action: () => unknown) {
    await act(async () => {
      await action();
    });
  }

  async function mountSpecialized() {
    const open = session({
      id: "specialized-controls",
      turns: [
        {
          prompt: "Inspect the files",
          work: [
            read("src/MixedCase.ts", "export const Result = 1;"),
            read("archive.zip", "binary"),
            tool("list_dir", { path: "PendingDirectory" }, { live: true }),
            read("Missing.ts", "Permission denied while reading.", { failed: true }),
            write("Locked.ts", "replacement", { failed: "The file is read-only." }),
            speech("Finished inspecting.", { model: "grok-4.7-build-fast", thought: "Reasoning remains readable." }),
          ],
        },
      ],
    });
    const staged = sessionStage(() => open)();
    const mounted = staged.dial;
    dial = mounted;
    await mounted.follow(readTarget(staged.at));
    await interact(() =>
      root.render(
        createElement(DialProvider, {
          dial: mounted.asDial,
          children: createElement(
            FilePreviewProvider,
            { resetKey: open.root.sessionId },
            createElement(Tape),
            createElement(PreviewReceipt),
          ),
        }),
      ),
    );
    return mounted;
  }

  const button = (name: string | RegExp) => within(container).getByRole<HTMLButtonElement>("button", { name });
  const explanation = (trigger: HTMLElement) =>
    document.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-describedby")}"]`)!;

  async function pointer(node: Element, entering: boolean) {
    if (entering) hovered.add(node);
    else hovered.delete(node);
    await interact(() =>
      node.dispatchEvent(new PointerEvent(entering ? "pointerover" : "pointerout", { bubbles: true })),
    );
  }

  it("opens readable targets, disables binary/pending ones, and owns failure tooltip hover/Escape lifecycles", async () => {
    const mounted = await mountSpecialized();

    await interact(() => user.click(button("src/MixedCase.ts")));
    expect(JSON.parse(within(container).getByLabelText("Opened file").textContent)).toEqual({
      path: "src/MixedCase.ts",
      label: "src/MixedCase.ts",
      text: "export const Result = 1;",
    });
    expect(mounted.calls).toEqual([]);

    expect(button("archive.zip").disabled).toBe(true);
    expect(button("PendingDirectory/").disabled).toBe(true);

    const readFailure = button("Why this failed: Missing.ts");
    const writeFailure = button("Why this failed: write Locked.ts");
    const readTip = explanation(readFailure);
    const writeTip = explanation(writeFailure);
    expect(readFailure.getAttribute("aria-describedby")).not.toBe(writeFailure.getAttribute("aria-describedby"));
    expect(readTip.getAttribute("role")).toBe("tooltip");
    expect(readTip.textContent).toBe("Permission denied while reading.");
    expect(writeTip.textContent).toBe("The file is read-only.");

    await interact(() => readFailure.focus());
    expect(openPopovers.has(readTip)).toBe(true);
    await interact(() => user.keyboard("{Escape}"));
    expect(openPopovers.has(readTip)).toBe(false);
    expect(document.activeElement).toBe(readFailure);

    await interact(() => user.click(button("Locked.ts")));
    expect(JSON.parse(within(container).getByLabelText("Opened file").textContent)).toEqual({
      path: "Locked.ts",
      label: "Locked.ts",
    });

    vi.useFakeTimers();
    await pointer(readFailure, true);
    expect(openPopovers.has(readTip)).toBe(true);
    await pointer(readFailure, false);
    await interact(() => vi.advanceTimersByTime(119));
    expect(openPopovers.has(readTip)).toBe(true);
    await pointer(readTip, true);
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(readTip)).toBe(true);
    await pointer(readTip, false);
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(readTip)).toBe(false);
  });

  it("remembers manual reasoning disclosure choices across ResizeObserver width transitions", async () => {
    const observations: { target: Element; resize: (entries: ResizeObserverEntry[]) => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(readonly resize: (entries: ResizeObserverEntry[]) => void) {}
        observe(target: Element) {
          observations.push({ target, resize: this.resize });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    container.classList.add("tape");
    await mountSpecialized();

    const reasoning = button("Reasoning");
    const panel = document.querySelector<HTMLElement>(`[id="${reasoning.getAttribute("aria-controls")}"]`)!;
    const observer = observations.find((entry) => entry.target === container)!;
    const resize = (width: number) =>
      interact(() => observer.resize([{ contentRect: { width } } as ResizeObserverEntry]));

    const initialExpanded = reasoning.getAttribute("aria-expanded");
    await resize(600);
    const collapsedNarrow = reasoning.getAttribute("aria-expanded");
    await interact(() => {
      reasoning.focus();
      return user.keyboard("{Enter}");
    });
    const pinnedOpenNarrow = reasoning.getAttribute("aria-expanded");
    await resize(1200);
    const widePanelHidden = panel.getAttribute("aria-hidden");
    await resize(600);
    const rememberedOpenNarrow = reasoning.getAttribute("aria-expanded");

    await interact(() => user.keyboard(" "));
    await resize(1200);
    await resize(600);
    const rememberedClosedNarrow = reasoning.getAttribute("aria-expanded");

    expect({
      initialExpanded,
      collapsedNarrow,
      pinnedOpenNarrow,
      widePanelHidden,
      rememberedOpenNarrow,
      rememberedClosedNarrow,
    }).toEqual({
      initialExpanded: "true",
      collapsedNarrow: "false",
      pinnedOpenNarrow: "true",
      widePanelHidden: "false",
      rememberedOpenNarrow: "true",
      rememberedClosedNarrow: "false",
    });
  });
});
