// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AckBlock } from "../ack-block.js";
import { storeChoices } from "../ack-prompt.js";
import { Composer } from "../composer.js";
import { resetNewSessions, stageOf } from "../new-session.js";
import { StageComposer } from "../stage-composer.js";

const request = vi.hoisted(() => vi.fn(async (_method: string, _params: unknown) => ({ ok: true })));
const navigate = vi.hoisted(() => vi.fn(async (_target: { href: string }) => undefined));
const state = vi.hoisted(() => ({ dial: null as unknown }));
vi.mock("../../client/context.js", () => ({ useDial: () => state.dial }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

const path = "/work/composer-migration";
function makeDial() {
  return {
    attaching: false,
    link: null,
    look: vi.fn(),
    prepareMint: vi.fn(),
    projects: new Map(),
    project: null,
    requestedTarget: { kind: "project", path },
    kernelRpc: { request },
    sessionRpc: { request },
    kernel: {
      root: {
        approvalAskThrottleMs: 0,
        connections: {},
        drivers: {},
        bots: { reviewer: { name: "Code Reviewer" } },
        kvs: {},
        defaultPermissionMode: "manual",
      },
    },
    session: {
      root: {
        uuid: "root-migration",
        sessionId: "migration",
        path,
        head: null,
        tip: null,
        kvs: { model: "gpt-6.1-sol" },
        agent: { spec: null },
        permissionMode: "manual",
        skills: [],
        findRunningTurn: (): { uuid: string; cutOff: boolean; approvalHead: null } | null => null,
      },
    },
  };
}

let dial: ReturnType<typeof makeDial>;
let container: HTMLDivElement;
let root: Root;
function node<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector);
  if (found == null) throw new Error(`missing ${selector}`);
  return found;
}
const draft = () => node<HTMLTextAreaElement>('textarea[aria-label="Message draft"]');
const action = (name: string) => node<HTMLButtonElement>(`button[aria-label="${name}"]`);
async function render(staged = false) {
  await act(async () => {
    root.render(staged ? createElement(StageComposer, { path }) : createElement(Composer));
  });
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), value);
    draft().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    draft().dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  request.mockReset().mockResolvedValue({ ok: true });
  navigate.mockReset().mockResolvedValue(undefined);
  resetNewSessions();
  dial = makeDial();
  state.dial = dial;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetNewSessions();
});

describe("composer shared controls", () => {
  it.each([false, true])(
    "names the input and links local status without consuming IME or newline Enter (staged=%s)",
    async (staged) => {
      await render(staged);
      const field = draft();
      const described = field
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => container.querySelector(`[id="${id}"]`));
      expect({
        name: field.getAttribute("aria-label"),
        redundantLabel: container.querySelector(`label[for="${field.id}"]`),
        statusRole: described[0]?.getAttribute("role"),
        status: described[0]?.textContent,
      }).toEqual({ name: "Message draft", redundantLabel: null, statusRole: "status", status: "" });
      if (staged) expect(document.activeElement).toBe(field);
      await type("keep the draft");
      const enters = [];
      for (const init of [
        { key: "Enter", isComposing: true },
        { key: "Enter", keyCode: 229 },
        { key: "Enter", shiftKey: true },
      ]) {
        const event = await key(init);
        enters.push({ key: init, prevented: event.defaultPrevented });
      }
      expect({
        prevented: enters.filter((event) => event.prevented),
        requests: request.mock.calls,
        navigations: navigate.mock.calls,
        draft: field.value,
      }).toEqual({
        prevented: [],
        requests: [],
        navigations: [],
        draft: "keep the draft",
      });

      const send = action("Send");
      expect({
        type: send.type,
        iconHidden: send.querySelector('svg[aria-hidden="true"]') !== null,
        visibleText: send.textContent,
      }).toEqual({ type: "button", iconHidden: true, visibleText: "" });
      const submit = vi.fn();
      container.querySelector("form")!.addEventListener("submit", submit);
      if (staged) navigate.mockRejectedValueOnce(new Error("Navigation failed"));
      else request.mockResolvedValueOnce({ ok: false });
      await act(async () => send.click());
      expect({
        submissions: submit.mock.calls,
        draft: field.value,
        sameStatus: described[0] === node('[role="status"]'),
        notice: described[0]?.textContent,
        requests: request.mock.calls,
        navigations: navigate.mock.calls.length,
      }).toEqual({
        submissions: [],
        draft: "keep the draft",
        sameStatus: true,
        notice: expect.stringContaining(staged ? "Navigation failed" : "Your draft is saved."),
        requests: staged ? [] : [["turn", { prompt: "keep the draft" }]],
        navigations: staged ? 1 : 0,
      });
    },
  );

  it.each([false, true])("retains plain Enter sending (staged=%s)", async (staged) => {
    await render(staged);
    await type("send once");
    const event = await key({ key: "Enter" });
    expect(event.defaultPrevented).toBe(true);
    expect(draft().value).toBe("");
    if (staged) expect(navigate).toHaveBeenCalledTimes(1);
    else expect(request.mock.calls).toEqual([["turn", { prompt: "send once" }]]);
  });

  it("cancels the run once through the shared symbol button", async () => {
    dial.session.root.findRunningTurn = () => ({ uuid: "turn-live", cutOff: false, approvalHead: null });
    await render();
    const stop = action("Stop");
    expect(stop.type).toBe("button");
    expect(stop.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await act(async () => stop.click());
    expect(request.mock.calls).toEqual([["turn/cancel", { turnId: "turn-live" }]]);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
  });

  it("retains the agent's native anchored popover and natural name", async () => {
    await render(true);
    const trigger = node<HTMLButtonElement>(".agent-trigger");
    const user = userEvent.setup({ document });
    await act(async () => user.click(trigger));
    const menu = within(container).getByRole("menu", { name: /^Agent/ });
    const popover = menu.closest<HTMLElement>(".gp-native-popover");
    expect(popover?.getAttribute("popover")).toBe("auto");
    const reviewer = within(menu).getByRole("menuitemradio", { name: "Code Reviewer" });
    await act(async () => user.click(reviewer));
    expect(stageOf(path).agent).toBe("Code Reviewer");
    expect(trigger.getAttribute("aria-label")).toBe("Agent: Code Reviewer");
    expect(within(container).queryByRole("menu", { name: /^Agent/ })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the native-anchored shared acknowledgement select with its persistent label and fallback", async () => {
    const choices = storeChoices([{ label: "Shell", subject: { kind: "tool", name: "shell" } }], { bot: false });
    const remember = vi.fn();
    const props = {
      flags: [{ label: "Needs acknowledgement", why: "Runs a command" }],
      choices,
      remember: "stale",
      disabled: false,
      onRemember: remember,
    };
    await act(async () => root.render(createElement(AckBlock, props)));
    const select = within(container).getByRole("button", { name: "Just this once Remember" });
    expect(select.getAttribute("aria-haspopup")).toBe("listbox");
    const user = userEvent.setup({ document });
    await act(async () => user.click(select));
    const list = within(container).getByRole("listbox");
    expect(list.closest(".gp-native-popover")?.getAttribute("popover")).toBe("auto");
    await act(async () => user.click(within(list).getByRole("option", { name: choices[0]!.text })));
    expect(remember.mock.calls).toEqual([[choices[0]!.key]]);
    await act(async () => root.render(createElement(AckBlock, { ...props, remember: choices[0]!.key })));
    await act(async () => user.click(select));
    await act(async () => user.click(within(container).getByRole("option", { name: "Just this once" })));
    expect(remember.mock.calls).toEqual([[choices[0]!.key], [""]]);
    await act(async () =>
      root.render(createElement(AckBlock, { ...props, remember: choices[0]!.key, disabled: true })),
    );
    expect(select.textContent).toContain(choices[0]!.text);
    expect((select as HTMLButtonElement).disabled).toBe(true);
    expect(within(container).queryByRole("listbox")).toBeNull();
  });
});
