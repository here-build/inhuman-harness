// @vitest-environment happy-dom

import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ThemedDiffResult } from "@pierre/diffs";
import { expect, it, vi } from "vitest";

import { DiffView, paintTokenColors } from "../diff-view.js";

function themed(text: string, type: string, line: string, light: string, dark: string): ThemedDiffResult {
  return {
    themeStyles: "",
    baseThemeType: "light",
    code: {
      deletionLines: [],
      additionLines: [
        {
          type: "element",
          tagName: "div",
          properties: { "data-line": line, "data-line-type": type },
          children: [
            {
              type: "element",
              tagName: "span",
              properties: { style: `--diffs-token-light:${light};--diffs-token-dark:${dark};font-weight:700` },
              children: [{ type: "text", value: text }],
            },
          ],
        },
      ],
    },
  };
}

it("colors a painted line without moving its text or its box", () => {
  const line = document.createElement("div");
  line.dataset.line = "46";
  line.dataset.lineType = "change-addition";
  line.textContent = "const value = 2";
  const content = document.createElement("div");
  content.dataset.content = "";
  content.append(line);
  paintTokenColors(content, themed("const value = 2", "change-addition", "46", "#112233", "#aabbcc"));
  expect(line.textContent).toBe("const value = 2");
  expect(content.contains(line)).toBe(true);
  expect(content.querySelectorAll("[data-line]")).toHaveLength(1);
  const span = line.querySelector("span");
  expect(span?.getAttribute("style")).toBe("--diffs-token-light:#112233;--diffs-token-dark:#aabbcc");
  expect(span?.getAttribute("style")).not.toContain("font-weight");
});

it("leaves a line alone when the tokens are not that line", () => {
  const line = document.createElement("div");
  line.dataset.line = "46";
  line.dataset.lineType = "change-addition";
  line.textContent = "const value = 2";
  const content = document.createElement("div");
  content.dataset.content = "";
  content.append(line);
  paintTokenColors(content, themed("other", "change-addition", "46", "#112233", "#aabbcc"));
  expect(line.childNodes).toHaveLength(1);
  expect(line.firstChild?.nodeType).toBe(Node.TEXT_NODE);
});

it("mounts Pierre's real shadow DOM with both sides of an edit", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(DiffView, {
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
            path: "src/value.ts",
            lineStart: 46,
          }),
        ),
      );
    });
    await vi.waitFor(() => {
      const shadow = container.querySelector("diffs-container")?.shadowRoot;
      expect(shadow?.querySelector("code")?.textContent).toContain("const value");
      expect(shadow?.textContent).toContain("1");
      expect(shadow?.textContent).toContain("2");
      expect(shadow?.querySelector('[data-line="46"]')).not.toBeNull();
    });
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".diff-path")?.textContent).toBe("src/value.ts");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
