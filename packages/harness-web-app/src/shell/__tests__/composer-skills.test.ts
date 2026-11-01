// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";
import type { SkillSlashRow } from "../skill-slash.js";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
);
const navigate = vi.hoisted(() => vi.fn(async (_target: { href: string }) => undefined));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

const skills = [
  {
    name: "review",
    invoke: "skill:review",
    description: "Review changes",
    location: "/work/.agents/skills/review/SKILL.md",
  },
  {
    name: "undo",
    invoke: "skill:undo",
    description: "A skill, not a host command",
    location: "/work/.agents/skills/undo/SKILL.md",
  },
];
type Running = { uuid: string; cutOff: boolean; approvalHead: { uuid: string; ackPending: boolean } | null } | null;

class SkillDial {
  attaching = false;
  link = null;
  readonly look = vi.fn();
  project = null;
  requestedTarget = { kind: "project", path: "/work" };
  kernel = {
    root: {
      approvalAskThrottleMs: 0,
      connections: {},
      drivers: {},
      bots: {},
      kvs: {},
      defaultPermissionMode: "manual",
    },
  };
  sessionRpc = { request };
  running: Running = null;
  session = this.room("one", skills);

  room(id: string, rows: readonly SkillSlashRow[]) {
    return {
      root: {
        uuid: `root-${id}`,
        sessionId: id,
        path: "/work",
        head: null,
        tip: null,
        kvs: {},
        agent: { spec: null },
        permissionMode: "manual",
        skills: rows,
        findRunningTurn: () => this.running,
      },
    };
  }

  constructor() {
    makeObservable(this, { session: observable.ref, running: observable.ref });
  }
}

const state: { dial: SkillDial | null } = vi.hoisted(() => ({ dial: null }));
vi.mock("../../client/context.js", () => ({
  useDial: () => {
    if (state.dial == null) throw new Error("dial missing");
    return state.dial;
  },
}));

let container: HTMLDivElement;
let view: Root;
function dial(): SkillDial {
  if (state.dial == null) throw new Error("dial missing");
  return state.dial;
}
function field(): HTMLTextAreaElement {
  const node = container.querySelector('textarea[aria-label="Message draft"]');
  if (!(node instanceof HTMLTextAreaElement)) throw new TypeError("draft missing");
  return node;
}
const menu = () => container.querySelector('[role="listbox"][aria-label="Skills"]');
const options = () => [...container.querySelectorAll('[role="listbox"] [role="option"]')];
const selected = () => container.querySelector('[role="option"][aria-selected="true"]');

async function type(value: string): Promise<void> {
  await act(async () => {
    const node = field();
    node.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter == null) throw new Error("textarea setter missing");
    setter.call(node, value);
    node.setSelectionRange(value.length, value.length);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    field().dispatchEvent(event);
  });
  return event;
}
async function change(update: () => void): Promise<void> {
  await act(async () => {
    runInAction(update);
  });
}

// Composer is the public wrapper; an attached session renders its SessionComposer.
describe("session composer skill interactions", () => {
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    request.mockReset().mockResolvedValue({ ok: true });
    navigate.mockClear();
    state.dial = new SkillDial();
    container = document.createElement("div");
    document.body.append(container);
    view = createRoot(container);
    await act(async () => {
      view.render(createElement(Composer));
    });
  });
  afterEach(async () => {
    await act(async () => {
      view.unmount();
    });
    container.remove();
  });

  it.each(["Enter", "Tab"])("uses ArrowDown then %s to complete canonical invoke, not send", async (key) => {
    expect(menu()).toBeNull();
    await type("/");
    expect(options().map((node) => node.firstElementChild?.textContent)).toEqual(["/skill:review", "/skill:undo"]);
    expect(selected()?.textContent).toContain("/skill:review");
    await press("ArrowDown");
    expect(selected()?.textContent).toContain("/skill:undo");
    expect(field().getAttribute("aria-activedescendant")).toBe(selected()?.id);
    const completion = await press(key);
    expect(completion.defaultPrevented).toBe(true);
    expect(field().value).toBe("/skill:undo ");
    expect(field().selectionStart).toBe(field().value.length);
    expect(field().selectionEnd).toBe(field().value.length);
    expect(document.activeElement).toBe(field());
    expect(menu()).toBeNull();
    expect(request).not.toHaveBeenCalled();

    await type("/skill:undo explain the change");
    expect(menu()).toBeNull();
    await press("Enter");
    expect(request.mock.calls).toEqual([["turn", { prompt: "/skill:undo explain the change" }]]);
    expect(field().value).toBe("");
  });

  it.each([false, true])("Escape (shift=%s) dismisses a live menu without sending or cancelling", async (shiftKey) => {
    await change(() => {
      dial().running = { uuid: "turn-one", cutOff: false, approvalHead: null };
    });
    await type("/un");
    expect(menu()).not.toBeNull();
    const escape = await press("Escape", { shiftKey });
    expect(escape.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(field().value).toBe("/un");
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves ShiftEnter available for a newline instead of completing or sending", async () => {
    await type("/un");
    expect(menu()).not.toBeNull();
    const newline = await press("Enter", { shiftKey: true });
    expect(newline.defaultPrevented).toBe(false);
    expect(field().value).toBe("/un");
    expect(menu()).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not consume IME Enter, including legacy keyCode 229, and hides during composition", async () => {
    await type("/un");
    const composing = await press("Enter", { isComposing: true });
    const legacy = await press("Enter", { keyCode: 229 });
    expect(composing.defaultPrevented).toBe(false);
    expect(legacy.defaultPrevented).toBe(false);
    expect(field().value).toBe("/un");
    expect(menu()).not.toBeNull();
    await act(async () => {
      field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    await press("Enter", { isComposing: true });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    expect(field().value).toBe("/un");
  });

  it("hides an open menu when an approval covers the draft", async () => {
    await type("/");
    expect(menu()).not.toBeNull();
    await change(() => {
      dial().running = { uuid: "turn-one", cutOff: false, approvalHead: { uuid: "ask-one", ackPending: false } };
    });
    expect(menu()).toBeNull();
    expect(container.querySelector('textarea[aria-label="Approval comment"]')).not.toBeNull();
    expect(field().closest(".visually-hidden")).not.toBeNull();
    expect(field().value).toBe("/");
    expect(request).not.toHaveBeenCalled();
  });

  it("switches sessions without completing an old selection into the new draft", async () => {
    const first = dial().session;
    await type("/");
    await press("ArrowDown");
    expect(selected()?.textContent).toContain("/skill:undo");
    await change(() => {
      dial().session = dial().room("two", [skills[0]!]);
    });
    expect(menu()).toBeNull();
    expect(field().value).toBe("");
    await type("/");
    expect(options()).toHaveLength(1);
    await press("Tab");
    expect(field().value).toBe("/skill:review ");
    await change(() => {
      dial().session = first;
    });
    expect(field().value).toBe("/");
    expect(options()).toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
  });
});
