// @vitest-environment happy-dom

import { act, createElement as h, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  computeFloatingPosition,
  normalizePlacement,
  useFloatingPosition,
  type FloatingPositionInput,
} from "../positioning/floating.js";

describe("normalizePlacement", () => {
  it.each([
    ["bottom start", "bottom-start"],
    ["top end", "top-end"],
    ["end top", "right-start"],
    ["start bottom", "left-end"],
    ["unknown-side", "bottom-start"],
    [undefined, "bottom-start"],
  ] as const)("maps %j -> %s", (input, expected) => {
    expect(normalizePlacement(input)).toBe(expected);
  });
});

describe("computeFloatingPosition", () => {
  it.each<{
    name: string;
    input: FloatingPositionInput;
    expected: Partial<ReturnType<typeof computeFloatingPosition>>;
  }>([
    {
      name: "places bottom-start below the trigger when space permits",
      input: {
        triggerRect: { left: 100, top: 80, right: 260, bottom: 112, width: 160, height: 32 },
        floatingSize: { width: 200, height: 140 },
        viewport: { width: 1200, height: 800 },
        placement: "bottom-start",
        offset: 4,
      },
      expected: { resolvedPlacement: "bottom-start", x: 100, y: 116, triggerWidth: 160, transformOrigin: "top left" },
    },
    {
      name: "accepts RAC space-separated placement 'bottom start' and flips cleanly near bottom edge",
      input: {
        triggerRect: { left: 40, top: 690, right: 200, bottom: 722, width: 160, height: 32 },
        floatingSize: { width: 220, height: 180 },
        viewport: { width: 1200, height: 760 },
        placement: "bottom start",
        offset: 4,
      },
      expected: { resolvedPlacement: "top-start", x: 40, y: 690 - 4 - 180, transformOrigin: "bottom left" },
    },
    {
      name: "aligns top-end above the trigger flush with the trigger right edge",
      input: {
        triggerRect: { left: 700, top: 620, right: 820, bottom: 652, width: 120, height: 32 },
        floatingSize: { width: 240, height: 200 },
        viewport: { width: 1200, height: 760 },
        placement: "top-end",
        offset: 4,
      },
      expected: { resolvedPlacement: "top-end", x: 820 - 240, y: 620 - 4 - 200, transformOrigin: "bottom right" },
    },
    {
      name: "flips logical 'end top' submenus to left-start when overflowing right edge",
      input: {
        triggerRect: { left: 940, top: 200, right: 1120, bottom: 232, width: 180, height: 32 },
        floatingSize: { width: 200, height: 160 },
        viewport: { width: 1180, height: 800 },
        placement: "end top",
        offset: 4,
      },
      expected: { resolvedPlacement: "left-start", x: 940 - 4 - 200, y: 200 },
    },
    {
      name: "clamps oversized floating panels within viewport margins",
      input: {
        triggerRect: { left: 4, top: 50, right: 100, bottom: 82, width: 96, height: 32 },
        floatingSize: { width: 420, height: 120 },
        viewport: { width: 320, height: 500 },
        placement: "bottom-end",
        viewportMargin: 8,
      },
      expected: { x: 8, maxWidth: 304 },
    },
  ])("$name", ({ input, expected }) => {
    expect(computeFloatingPosition(input)).toMatchObject(expected);
  });
});

describe("useFloatingPosition", () => {
  it("writes --rt-* custom properties and normalized resolvedPlacement onto floating DOM nodes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Probe() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const floatingRef = useRef<HTMLDivElement>(null);
      useFloatingPosition({ triggerRef, floatingRef, isOpen: true, placement: "bottom start" });
      return h(
        "div",
        null,
        h("button", { ref: triggerRef, type: "button" }, "Open"),
        h("div", { ref: floatingRef, "data-testid": "floating" }, "Panel"),
      );
    }

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "BUTTON") return new DOMRect(40, 80, 140, 32);
      return new DOMRect(0, 0, 200, 120);
    });

    try {
      await act(async () => root.render(h(Probe)));
      const panel = host.querySelector<HTMLElement>("[data-testid='floating']")!;
      expect(panel.style.getPropertyValue("--rt-x")).toBe("40px");
      expect(panel.style.getPropertyValue("--rt-y")).toBe("116px");
      expect(panel.style.getPropertyValue("--rt-trigger-w")).toBe("140px");
      expect(panel.style.getPropertyValue("--rt-origin")).toBe("top left");
      expect(panel.dataset.resolvedPlacement).toBe("bottom-start");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
