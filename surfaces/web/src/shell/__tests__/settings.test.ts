// @vitest-environment happy-dom

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DriverSpec } from "@inhuman.tools/expectations";
import { encodeUiDefinition } from "@inhuman.tools/harness-contract";
import { runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kernel, session, StoryDial, type ConnectScripts, type WireSpec } from "../../__stories__/world.js";
import { SettingsDialog } from "../settings.js";

let dial: StoryDial;
vi.mock("../../client/context.js", () => ({ useDial: () => dial }));

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dial = new StoryDial({ kernel: kernel({ wires: [] }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  dial.kernel?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(name: string) {
  await act(async () => user.click(within(container).getByRole("button", { name })));
}

async function fill(label: string, value: string) {
  const input = within(container).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("SettingsDialog", () => {
  it("writes trimmed Skills fields with multiline body and clears body after save", async () => {
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Skills");

    const scope = within(container).getByLabelText("Where");
    expect(scope.getAttribute("aria-haspopup")).toBe("listbox");
    await act(async () => user.click(scope));
    await act(async () => user.click(within(container).getByRole("option", { name: "Home" })));

    await fill("Name", "  review-new  ");
    await fill("Description", "Verify code changes");
    const body = '  Keep literal values.\n{"case": "MixedCase"}\n';
    const textarea = await fill("Body", body);
    expect(textarea.tagName).toBe("TEXTAREA");

    await click("Save skill");
    expect(dial.calls.find((call) => call.method === "skill/write")?.params).toEqual({
      scope: "home",
      name: "review-new",
      description: "Verify code changes",
      body,
    });
    expect(within(container).getByRole("status").textContent).toBe("Skill saved.");
    expect(within(container).getByLabelText<HTMLTextAreaElement>("Body").value).toBe("");
  });

  it("validates Runtime fields, saves TriggerRange sliders to config/set, and preserves input on RPC failure", async () => {
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Runtime");

    await fill("Turns to keep", "not a number");
    await click("Save");
    expect(dial.calls.some((call) => call.method === "config/set")).toBe(false);
    expect(within(container).getByRole("status").textContent).toContain("need numbers");

    await fill("Turns to keep", "12");
    const soft = within(container).getByLabelText<HTMLInputElement>("Soft trigger");
    await act(async () => {
      soft.focus();
      await user.keyboard("{ArrowLeft}{ArrowLeft}");
    });
    expect(soft.value).toBe("78");

    await click("Save");
    expect(dial.calls.find((call) => call.method === "config/set")?.params).toMatchObject({
      compactKeepTurns: 12,
      compactTriggers: { soft: "78%", hard: "90%" },
    });
    expect(within(container).getByRole("status").textContent).toBe("Runtime settings saved.");

    vi.spyOn(dial.kernelRpc!, "request").mockRejectedValueOnce(new Error("Could not save runtime settings."));
    await fill("Turns to keep", "13");
    expect(within(container).queryByRole("status")).toBeNull();
    await click("Save");
    const failure = within(container).getByRole("status");
    expect(failure.textContent).toBe("Could not save runtime settings.");
    expect(failure.classList.contains("text-danger")).toBe(true);
    expect(within(container).getByLabelText<HTMLInputElement>("Turns to keep").value).toBe("13");
  });
});

const WEB_WIRES: readonly WireSpec[] = [
  { id: "tavily", name: "Tavily", models: [], can: ["web-search", "web-extract"], keyMask: "tvly-…9" },
  { id: "grok", name: "Grok", models: ["grok-4.7"], can: ["completion", "web-search"] },
  { id: "web-keyless", name: "web-keyless", models: [], can: ["web-search", "web-extract"] },
];

/** A world with an open session, so kernel-scope KV writes have a port. */
async function openWebWorld(wires: readonly WireSpec[], connect?: ConnectScripts) {
  dial.kernel?.destroy();
  const opened = session({ id: "web-session", turns: [] });
  dial = new StoryDial({ kernel: kernel({ wires }), sessions: [opened], connect });
  await dial.follow({ kind: "session", sessionId: opened.root.sessionId });
}

async function chooseOption(label: string, option: string) {
  const trigger = within(container).getByLabelText(label);
  await act(async () => user.click(trigger));
  await act(async () => user.click(within(container).getByRole("option", { name: option })));
}

describe("Web section", () => {
  it("pins search and extract independently and returns to Auto", async () => {
    await openWebWorld(WEB_WIRES);
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Web");

    await chooseOption("Search provider", "Tavily");
    expect(dial.calls.find((call) => call.method === "kv/set")?.params).toEqual({
      key: "web-search-connection",
      value: "tavily",
      scope: "kernel",
    });
    expect(dial.kernel!.root.kvs["web-search-connection"]).toBe("tavily");

    // Grok claims completion + web-search: it is a search candidate, never an extract one.
    const extract = within(container).getByLabelText("Extract provider");
    await act(async () => user.click(extract));
    expect(within(container).queryByRole("option", { name: "Grok" })).toBeNull();
    await act(async () => user.click(within(container).getByRole("option", { name: "web-keyless" })));
    expect(dial.kernel!.root.kvs["web-extract-connection"]).toBe("web-keyless");
    expect(dial.kernel!.root.kvs["web-search-connection"]).toBe("tavily");

    await chooseOption("Search provider", "Auto");
    expect(dial.kernel!.root.kvs["web-search-connection"]).toBe("");
  });

  it("toggles the keyless fallback in kernel scope and warns when nothing else serves web", async () => {
    await openWebWorld([WEB_WIRES[2]]);
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Web");

    const toggle = within(container).getByRole("checkbox", { name: "Use as fallback" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => user.click(toggle));
    expect(dial.calls.find((call) => call.method === "kv/set")?.params).toEqual({
      key: "web.keyless_fallback",
      value: "false",
      scope: "kernel",
    });
    expect(within(container).getByRole("status").textContent).toContain("No other web provider is connected");

    await act(async () => user.click(toggle));
    expect(dial.kernel!.root.kvs["web.keyless_fallback"]).toBe("true");
    expect(within(container).queryByRole("status")).toBeNull();
  });

  it("adopts a keyed vendor through the parked API-key step", async () => {
    await openWebWorld(WEB_WIRES, {
      exa: [
        encodeUiDefinition({ kind: "input", name: "Exa API key", secret: true }),
        { done: "exa", wire: { id: "exa", name: "Exa", models: [], can: ["web-search", "web-extract"] } },
      ],
    });
    runInAction(() => {
      dial.kernel!.root.drivers["exa"] = new DriverSpec({
        name: "exa",
        description: "Exa neural search",
        abilityClaim: ["web-search", "web-extract"],
      });
    });
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));
    await click("Web");
    await click("Add API key");
    await act(async () => user.click(within(container).getByRole("button", { name: /Exa neural search/ })));

    expect(dial.calls.find((call) => call.method === "connect/adopt")?.params).toEqual({ driver: "exa" });
    await fill("Exa API key", "exa-key-123");
    await click("Continue");
    expect(dial.calls.find((call) => call.method === "ui/resolve")?.params).toMatchObject({
      kind: "text",
      input: "exa-key-123",
    });
    expect(dial.kernel!.root.connections["exa"]).toBeDefined();
    expect(within(container).getAllByText("Exa").length).toBeGreaterThan(0);
    expect(within(container).queryByLabelText("Exa API key")).toBeNull();
  });

  it("keeps web-only providers out of Connections and Models", async () => {
    await openWebWorld(WEB_WIRES);
    await act(async () => root.render(h(SettingsDialog, { onDismiss: vi.fn() })));

    await click("Connections");
    expect(within(container).queryByText("Tavily")).toBeNull();
    expect(within(container).getByText("Grok")).toBeTruthy();

    await click("Models");
    expect(within(container).queryByText("Tavily")).toBeNull();
    expect(within(container).getByText("Grok")).toBeTruthy();

    await click("Web");
    expect(within(container).getAllByText("Tavily").length).toBeGreaterThan(0);
  });
});
