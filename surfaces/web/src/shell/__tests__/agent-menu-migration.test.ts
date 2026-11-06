// @vitest-environment happy-dom

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { peekSession, resetNewSessions, stageOf, type AgentFace } from "../new-session.js";
import { StageComposer } from "../stage-composer.js";

const request = vi.hoisted(() => vi.fn(async (_method: string, _params: unknown) => ({ ok: true })));
const navigate = vi.hoisted(() => vi.fn(async (_target: { href: string }) => undefined));
const state = vi.hoisted(() => ({ dial: null as unknown }));
vi.mock("../../client/context.js", () => ({ useDial: () => state.dial }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));

const path = "/work/agent-migration";
function makeDial() {
  return {
    attaching: false,
    link: null as { kind: "reconnecting" } | null,
    look: vi.fn(),
    prepareMint: vi.fn<(id: string) => void>(),
    projects: new Map(),
    project: null,
    kernelRpc: { request } as { request: typeof request } | null,
    sessionRpc: null,
    kernel: {
      root: {
        connections: {},
        drivers: {},
        bots: {
          reviewer: { name: "Code Reviewer" },
          release: { name: "Release Engineer" },
          broken: { name: "Broken Agent", error: "invalid" },
        } as Record<string, AgentFace>,
        kvs: { connection: "seed-wire", model: "seed-model" },
        defaultPermissionMode: "manual",
      },
    },
  };
}

let dial: ReturnType<typeof makeDial>;
let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear();
  navigate.mockClear();
  resetNewSessions();
  dial = makeDial();
  state.dial = dial;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetNewSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(h(StageComposer, { path })));
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function trigger(name = "Default") {
  return within(container).getByRole<HTMLButtonElement>("button", { name: `Agent: ${name}` });
}

function menu() {
  return within(container).getByRole("menu", { name: /^Agent:/ });
}

function item(name: string) {
  return within(menu()).getByRole("menuitemradio", { name });
}

function selected(name: string) {
  expect(
    within(menu())
      .getAllByRole("menuitemradio")
      .filter((row) => row.getAttribute("aria-checked") === "true")
      .map((row) => row.textContent),
  ).toEqual([name]);
}

function closed() {
  expect(within(container).queryByRole("menu")).toBeNull();
  expect(container.querySelector(".gp-native-popover")).toBeNull();
}

describe("staged agent menu migration", () => {
  it("uses RAC selection, unique native anchors, and content typography for configured names", async () => {
    await render();
    const button = trigger();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-haspopup")).toBe("true");
    expect(button.firstElementChild?.classList.contains("label")).toBe(true);
    closed();

    await interact(() => user.click(button));
    const popover = container.querySelector<HTMLElement>(".gp-native-popover")!;
    expect(popover.getAttribute("popover")).toBe("auto");
    const anchor = button.style.getPropertyValue("anchor-name");
    expect(anchor).toMatch(/^--gp-anchor-/);
    expect(popover.style.getPropertyValue("position-anchor")).toBe(anchor);
    expect(popover.style.getPropertyValue("position-area")).toBe("top span-left");
    expect(container.querySelector(".agent-menu, .permission-row")).toBeNull();
    expect(
      within(menu())
        .getAllByRole("menuitemradio")
        .map((row) => row.textContent),
    ).toEqual(["Default", "Code Reviewer", "Release Engineer"]);
    selected("Default");
    const named = item("Code Reviewer");
    expect(named.classList.contains("gp-anchored-item")).toBe(true);
    expect(named.firstElementChild?.classList.contains("[font-variant-caps:normal]")).toBe(true);
    expect(named.firstElementChild?.classList.contains("tracking-normal")).toBe(true);

    await interact(() => user.click(named));
    expect(stageOf(path).agent).toBe("Code Reviewer");
    expect(trigger("Code Reviewer")).toBe(button);
    expect(button.firstElementChild?.classList.contains("label")).toBe(false);
    expect(button.firstElementChild?.classList.contains("[font-variant-caps:normal]")).toBe(true);
    closed();
    expect(button.style.getPropertyValue("anchor-name")).toBe("");
    await settleFocus();
    expect(document.activeElement).toBe(button);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([null, { connection: "picked-wire", model: "picked-model", reasoningEffort: "high" }] as const)(
    "stages a choice and Default without changing model, draft, pictures, or permissions (%j)",
    async (model) => {
      const stage = stageOf(path);
      stage.model = model;
      stage.draft = "Keep the exact draft";
      stage.permission = "yolo";
      stage.pictures = [
        { key: "picture", mime: "image/png", bytesBase64: "AA==", width: 1, height: 1, sourcePath: "kept.png" },
      ];
      stage.revision = 7;
      stage.status = "old status";
      const pictures = stage.pictures;
      await render();
      const before = { ...stage };
      for (const [label, agent, revision] of [
        ["Release Engineer", "Release Engineer", 8],
        ["Default", "", 9],
      ] as const) {
        await interact(() => user.click(trigger(stage.agent || "Default")));
        await interact(() => user.click(item(label)));
        expect(stage).toEqual({ ...before, agent, revision, status: "" });
        expect(stage.model).toBe(model);
        expect(stage.pictures).toBe(pictures);
        closed();
        await settleFocus();
      }
      expect(request).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("shows a selected fallback for an absent or subsequently removed agent without resetting it", async () => {
    const stage = stageOf(path);
    stage.agent = "Missing Specialist";
    await render();
    await interact(() => user.click(trigger("Missing Specialist")));
    selected("Missing Specialist");
    expect(item("Missing Specialist").firstElementChild?.classList.contains("[font-variant-caps:normal]")).toBe(true);
    await interact(() => user.click(item("Code Reviewer")));
    delete dial.kernel.root.bots.reviewer;
    await render();
    await interact(() => user.click(trigger("Code Reviewer")));
    selected("Code Reviewer");
    expect(
      within(menu())
        .getAllByRole("menuitemradio")
        .filter((row) => row.textContent === "Code Reviewer"),
    ).toHaveLength(1);
    await interact(() => user.keyboard("{Escape}"));
    expect(stage.agent).toBe("Code Reviewer");
    await settleFocus();
    await interact(() => user.click(trigger("Code Reviewer")));
    await interact(() => user.click(item("Default")));
    expect(stage.agent).toBe("");
    closed();
    expect(request).not.toHaveBeenCalled();
  });

  it("opens on ArrowDown/ArrowUp, moves focus without committing, chooses Enter/Space, and cancels Escape", async () => {
    await render();
    const button = trigger();
    await interact(() => button.focus());
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(item("Default"));
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(item("Code Reviewer"));
    selected("Default");
    expect(stageOf(path).revision).toBe(0);
    await interact(() => user.keyboard("{Escape}"));
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
    expect(stageOf(path).agent).toBe("");

    await interact(() => user.keyboard("{ArrowUp}"));
    await interact(() => user.keyboard("{ArrowDown}{Enter}"));
    expect(stageOf(path).agent).toBe("Code Reviewer");
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
    await interact(() => user.keyboard("{ArrowDown}"));
    selected("Code Reviewer");
    await interact(() => user.keyboard("{ArrowUp} "));
    expect(stageOf(path).agent).toBe("");
    closed();
    await settleFocus();
    expect(document.activeElement).toBe(button);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps local agent staging enabled while disconnected with no request port, but cannot send", async () => {
    dial.link = { kind: "reconnecting" };
    dial.kernelRpc = null;
    const stage = stageOf(path);
    stage.draft = "Do not send offline";
    await render();
    expect(trigger().disabled).toBe(false);
    const send = within(container).getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send.disabled).toBe(true);
    await interact(() => user.click(trigger()));
    await interact(() => user.click(item("Code Reviewer")));
    expect(stage.agent).toBe("Code Reviewer");
    closed();
    await interact(() => user.click(send));
    expect(navigate).not.toHaveBeenCalled();
    expect(dial.prepareMint).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps Default available with an empty agent catalog and carries a chosen name into session mint", async () => {
    dial.kernel.root.bots = {};
    const stage = stageOf(path);
    stage.agent = "Removed Specialist";
    stage.draft = "Start with this agent";
    stage.model = { connection: "chosen", model: "chosen-model" };
    stage.permission = "auto";
    await render();
    expect(trigger("Removed Specialist").disabled).toBe(false);
    await interact(() => user.click(trigger("Removed Specialist")));
    selected("Removed Specialist");
    await interact(() => user.keyboard("{Escape}"));
    await interact(() => user.click(within(container).getByRole("button", { name: "Send" })));
    const id = dial.prepareMint.mock.calls[0]?.[0];
    expect(id).toBeDefined();
    expect(peekSession(id!)).toEqual({
      prompt: "Start with this agent",
      pictures: [],
      model: { connection: "chosen", model: "chosen-model" },
      agent: "Removed Specialist",
      permission: "auto",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
