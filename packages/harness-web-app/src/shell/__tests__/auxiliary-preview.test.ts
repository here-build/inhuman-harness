// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BeatTimeline } from "@inhuman.tools/harness-transcript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { groupBeats } from "../tape-beats.js";

let container: HTMLDivElement;
let root: Root;

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

function preview() {
  return container.querySelector<HTMLElement>(".auxiliary-preview")!;
}

async function hover(enter: boolean, target: HTMLElement = preview()) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", { bubbles: true }));
  });
}

describe("auxiliary transcript previews", () => {
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
    expect(popup.style.getPropertyValue("position-anchor")).toBe(note.style.getPropertyValue("anchor-name"));
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
});
