import { expect, test } from "vitest";

import { elementAt, elementAtPath, layout } from "../engine.js";
import type { LayoutNode } from "../types.js";

function frameOf(root: LayoutNode, w = 20, h = 10) {
  return layout(root, { w, h });
}

function keysAt(root: LayoutNode, x: number, y: number, w = 30, h = 12) {
  const frame = layout(root, { w, h });
  const at = elementAt(frame, x, y);
  const path = elementAtPath(frame, x, y);
  return {
    leaf: at?.key ?? null,
    userSelect: at?.meta.userSelect ?? null,
    path: path?.map((c) => c.key) ?? null,
    hittable: frame.hitList.some((m) => m.key === at?.key),
  };
}

test("hit-test law: userSelect gate + ancestor chain", () => {
  const none = frameOf({
    type: "box",
    key: "chrome",
    userSelect: "none",
    style: { width: 20, height: 3 },
  });
  expect({
    hitList: none.hitList.map((m) => m.key),
    at: elementAt(none, 5, 1),
    path: elementAtPath(none, 5, 1),
  }).toEqual({ hitList: [], at: null, path: null });

  expect(
    keysAt({ type: "box", key: "body", userSelect: "text", style: { width: 20, height: 3 } }, 5, 1, 20, 10),
  ).toEqual({
    leaf: "body",
    userSelect: "text",
    path: ["body"],
    hittable: true,
  });

  expect(
    keysAt({ type: "box", key: "block", userSelect: "all", style: { width: 20, height: 3 } }, 5, 1, 20, 10),
  ).toEqual({
    leaf: "block",
    userSelect: "all",
    path: ["block"],
    hittable: true,
  });

  expect(
    keysAt({ type: "box", key: "composer", userSelect: "contain", style: { width: 20, height: 3 } }, 5, 1, 20, 10),
  ).toEqual({
    leaf: "composer",
    userSelect: "contain",
    path: ["composer"],
    hittable: true,
  });

  const chromeFrame = frameOf({
    type: "chrome_frame",
    key: "composer",
    width: 20,
    draft: "hello",
  });
  expect(chromeFrame.byKey.get("composer")?.userSelect).toEqual("contain");

  const inherited = frameOf({
    type: "box",
    key: "outer",
    style: { width: 20, height: 5 },
    children: [{ type: "box", key: "inner", style: { width: 10, height: 2 } }],
  });
  expect(inherited.byKey.get("inner")?.userSelect).toEqual("auto");

  const noneParent = frameOf({
    type: "box",
    key: "chrome",
    userSelect: "none",
    style: { width: 20, height: 5 },
    children: [{ type: "box", key: "chrome-child", style: { width: 10, height: 2 } }],
  });
  expect(noneParent.byKey.get("chrome-child")?.userSelect).toEqual("none");

  const override = frameOf({
    type: "box",
    key: "mixed",
    userSelect: "none",
    style: { width: 20, height: 5 },
    children: [
      {
        type: "box",
        key: "selectable-child",
        userSelect: "text",
        style: { width: 10, height: 2 },
      },
    ],
  });
  expect({
    userSelect: override.byKey.get("selectable-child")?.userSelect,
    hittable: override.hitList.some((m) => m.key === "selectable-child"),
    at: elementAt(override, 1, 1)?.key ?? null,
  }).toEqual({ userSelect: "text", hittable: true, at: "selectable-child" });

  const nested: LayoutNode = {
    type: "box",
    key: "outer",
    userSelect: "text",
    style: { width: 30, height: 8 },
    children: [
      {
        type: "box",
        key: "inner-a",
        userSelect: "text",
        style: { width: 20, height: 4 },
        children: [{ type: "raw", key: "leaf", intent: "none", paint: () => {}, w: 10, h: 2 }],
      },
    ],
  };
  expect(keysAt(nested, 2, 1)).toEqual({
    leaf: "leaf",
    userSelect: "text",
    path: ["outer", "inner-a", "leaf"],
    hittable: true,
  });

  expect(
    keysAt({ type: "box", key: "chrome-only", userSelect: "none", style: { width: 30, height: 6 } }, 5, 1),
  ).toEqual({ leaf: null, userSelect: null, path: null, hittable: false });

  const overlay: LayoutNode = {
    type: "box",
    key: "outer",
    userSelect: "text",
    style: { width: 30, height: 8 },
    children: [
      { type: "box", key: "base", userSelect: "text", style: { width: 20, height: 4 } },
      {
        type: "overlay",
        key: "ovl",
        backdrop: true,
        children: [{ type: "box", key: "modal", userSelect: "text", style: { width: 6, height: 2 } }],
      },
    ],
  };
  expect(keysAt(overlay, 25, 6)).toEqual({
    leaf: "ovl:backdrop",
    userSelect: "auto",
    path: ["outer", "ovl:backdrop"],
    hittable: true,
  });

  const chromeOuter: LayoutNode = {
    type: "box",
    key: "chrome-outer",
    userSelect: "none",
    style: { width: 30, height: 6 },
    children: [{ type: "box", key: "content", userSelect: "text", style: { width: 10, height: 3 } }],
  };
  expect(keysAt(chromeOuter, 1, 1).path).toEqual(["content"]);

  const structural: LayoutNode = {
    type: "box",
    key: "block",
    userSelect: "all",
    style: { width: 30, height: 6 },
    children: [{ type: "box", key: "cell", userSelect: "text", style: { width: 10, height: 3 } }],
  };
  expect(keysAt(structural, 1, 1).path).toEqual(["block", "cell"]);
});
