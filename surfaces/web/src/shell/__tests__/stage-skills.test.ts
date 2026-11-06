// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { peekSession, resetNewSessions } from "../new-session.js";
import { StageComposer } from "../stage-composer.js";

const request = vi.hoisted(() => vi.fn<(method: string, params: unknown) => Promise<unknown>>());
const navigate = vi.hoisted(() => vi.fn(async (_target: { href: string }) => undefined));
const prepareMint = vi.hoisted(() => vi.fn<(id: string) => void>());
const dial = vi.hoisted(() => ({
  link: null,
  kernelRpc: { request },
  prepareMint,
  projects: new Map(),
  project: null,
  kernel: { root: { connections: {}, drivers: {}, bots: {}, kvs: {}, defaultPermissionMode: "manual" } },
}));
vi.mock("../../client/context.js", () => ({ useDial: () => dial }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
function field(): HTMLTextAreaElement {
  const node = container.querySelector("textarea");
  if (!(node instanceof HTMLTextAreaElement)) throw new TypeError("draft missing");
  return node;
}
async function render(path = "/work/alpha"): Promise<void> {
  await act(async () => root.render(createElement(StageComposer, { path })));
}
async function type(value: string): Promise<void> {
  await act(async () => {
    const node = field();
    node.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(node, value);
    node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string): Promise<void> {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
const skill = {
  name: "undo",
  invoke: "skill:undo",
  description: "A skill, not the host command",
  location: "/work/.agents/skills/undo/SKILL.md",
  scope: "project",
};

describe("stage skill slash menu", () => {
  beforeEach(() => {
    request.mockReset().mockResolvedValue({ skills: [skill] });
    navigate.mockClear();
    prepareMint.mockClear();
    resetNewSessions();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetNewSessions();
  });

  it("loads lazily, completes canonical invoke, then stages literal skill arguments", async () => {
    await render();
    expect(request).not.toHaveBeenCalled();
    await type("/un");
    expect(request).toHaveBeenCalledWith("skill/list", { project: "/work/alpha" });
    expect(container.querySelector('[role="option"]')?.textContent).toContain("/skill:undo");
    await press("Enter");
    expect(field().value).toBe("/skill:undo ");
    expect(navigate).not.toHaveBeenCalled();
    await type("/skill:undo explain the change");
    await press("Enter");
    expect(navigate).toHaveBeenCalledTimes(1);
    const id = prepareMint.mock.calls[0]?.[0];
    expect(id).toBeDefined();
    expect(peekSession(id)?.prompt).toBe("/skill:undo explain the change");
  });

  it("ignores an old project's late catalog response", async () => {
    let finish: (result: unknown) => void = () => undefined;
    request.mockImplementation((_method, params) => {
      if ((params as { project: string }).project === "/work/alpha")
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve({ skills: [{ ...skill, name: "review", invoke: "review" }] });
    });
    await render();
    await type("/");
    await render("/work/beta");
    await type("/");
    await act(async () => finish({ skills: [skill] }));
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("/review");
    expect(container.querySelector('[role="listbox"]')?.textContent).not.toContain("/skill:undo");
  });

  it("withholds old skill mappings while a reopened catalog is loading", async () => {
    await render();
    await type("/");
    expect(container.querySelector('[role="option"]')?.textContent).toContain("/skill:undo");
    await type("ordinary draft");
    let finish: (result: unknown) => void = () => undefined;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await type("/");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => finish({ skills: [{ ...skill, invoke: "agents:undo" }] }));
    expect(container.querySelector('[role="option"]')?.textContent).toContain("/agents:undo");
  });

  it("keeps ordinary message sending usable when catalog loading fails", async () => {
    request.mockRejectedValue(new Error("offline"));
    await render();
    await type("/");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await type("ordinary message");
    await press("Enter");
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
