// @vitest-environment happy-dom

import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { observable, runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completionWires, type ModelWire } from "../model-choice.js";
import { admitStagedSession, mintedReasoningEffort } from "../new-session.js";
import { ReasoningEffortPicker } from "../reasoning-effort.js";

type TestSession = {
  root: {
    uuid: string;
    sessionId: string;
    head: unknown;
    kvs: {
      connection: string;
      model: string;
      reasoningEffort?: string;
    };
    agent?: {
      spec?: {
        reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
      };
    };
  };
};

const request = vi.hoisted(() => vi.fn(async (_method: string, _params: unknown) => ({ ok: true })));
const state = vi.hoisted(() => ({
  dial: null as {
    session: TestSession | null;
    sessionRpc: { request: typeof request } | null;
    kernelRpc: { request: typeof request } | null;
  } | null,
}));

vi.mock("../../client/context.js", () => ({
  useDial: () => {
    if (state.dial == null) throw new Error("dial missing");
    return state.dial;
  },
}));

const defaultWires: readonly ModelWire[] = completionWires({
  openai: {
    id: "openai",
    driver: { abilityClaim: ["completion"] },
    live: { models: ["gpt-4o", "gpt-5.4"] },
  },
  anthropic: {
    id: "anthropic",
    driver: { abilityClaim: ["completion"] },
    live: { models: ["claude-sonnet-4-6"] },
  },
  deepseek: {
    id: "deepseek",
    driver: { abilityClaim: ["completion"] },
    live: { models: ["deepseek-v4-pro", "deepseek-v3.2"] },
  },
});

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

function makeSession(model: string, connection = "openai", head: unknown = null): TestSession {
  return {
    root: observable({
      uuid: "root:1",
      sessionId: "s-1",
      head,
      kvs: {
        connection,
        model,
      },
      agent: {
        spec: {
          reasoningEffort: null,
        },
      },
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockClear();
  state.dial = {
    session: makeSession("gpt-5.4", "openai"),
    sessionRpc: { request },
    kernelRpc: { request },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function queryTrigger() {
  return within(container).queryByRole<HTMLButtonElement>("button", { name: /^Reasoning effort:/ });
}

function trigger() {
  return within(container).getByRole<HTMLButtonElement>("button", { name: /^Reasoning effort:/ });
}

function menu() {
  return within(container).getByRole("menu", { name: /^Reasoning effort/ });
}

describe("ReasoningEffortPicker", () => {
  it("hides on non-reasoning models (gpt-4o) and renders on reasoning models (gpt-5.4, claude-sonnet-4-6, deepseek-v4-pro)", async () => {
    state.dial!.session = makeSession("gpt-4o", "openai");
    await render(h(ReasoningEffortPicker, { model: { connection: "openai", model: "gpt-4o" }, wires: defaultWires }));
    expect(queryTrigger()).toBeNull();

    for (const [connection, model] of [
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-sonnet-4-6"],
      ["deepseek", "deepseek-v4-pro"],
    ] as const) {
      state.dial!.session = makeSession(model, connection);
      await render(h(ReasoningEffortPicker, { model: { connection, model }, wires: defaultWires }));
      const button = trigger();
      expect(button.textContent).toBe("effort: default");
      expect(button.getAttribute("aria-label")).toBe("Reasoning effort: default");
    }
  });

  it("invokes kv/set with remember: true when selecting an effort and clears to empty string on default", async () => {
    const sess = makeSession("gpt-5.4", "openai");
    state.dial!.session = sess;
    await render(
      h(ReasoningEffortPicker, {
        model: { connection: "openai", model: "gpt-5.4" },
        wires: defaultWires,
        agentEffort: "medium",
      }),
    );

    const button = trigger();
    expect(button.textContent).toBe("effort: medium");

    await interact(() => user.click(button));
    const items = within(menu()).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "default (medium)",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: "high" })));
    expect(request).toHaveBeenCalledExactlyOnceWith("kv/set", {
      key: "reasoningEffort",
      value: "high",
      remember: true,
    });

    await act(async () => {
      runInAction(() => {
        sess.root.kvs.reasoningEffort = "high";
      });
    });
    expect(trigger().textContent).toBe("effort: high");

    await interact(() => user.click(trigger()));
    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: "default (medium)" })));
    expect(request).toHaveBeenLastCalledWith("kv/set", {
      key: "reasoningEffort",
      value: "",
      remember: true,
    });
  });

  it("shows 'drops cache' hint only when switching effort on a warm trajectory that invalidates prefix cache", async () => {
    // 1. Before first turn (head == null) on Anthropic -> no "drops cache"
    const claudeSession = makeSession("claude-sonnet-4-6", "anthropic", null);
    claudeSession.root.kvs.reasoningEffort = "medium";
    state.dial!.session = claudeSession;
    await render(
      h(ReasoningEffortPicker, {
        model: { connection: "anthropic", model: "claude-sonnet-4-6" },
        wires: defaultWires,
      }),
    );
    await interact(() => user.click(trigger()));
    expect(menu().textContent).not.toContain("drops cache");
    await interact(() => user.keyboard("{Escape}"));

    // 2. Warm trajectory (head != null) on Anthropic -> switching effort drops cache
    await act(async () => {
      runInAction(() => {
        claudeSession.root.head = { uuid: "turn-1" };
      });
    });
    await interact(() => user.click(trigger()));
    const highItem = within(menu()).getByRole("menuitemradio", { name: /high/ });
    const mediumItem = within(menu()).getByRole("menuitemradio", { name: /^medium$/ });
    expect(highItem.textContent).toContain("drops cache");
    expect(mediumItem.textContent).not.toContain("drops cache");
    await interact(() => user.keyboard("{Escape}"));

    // 3. Warm trajectory (head != null) on header-injected effort switch (deepseek-v4-pro low -> high) -> drops cache,
    //    whereas suffix-injected toggle (off <-> high) preserves cache
    const v4Session = makeSession("deepseek-v4-pro", "deepseek", { uuid: "turn-1" });
    v4Session.root.kvs.reasoningEffort = "low";
    state.dial!.session = v4Session;
    await render(
      h(ReasoningEffortPicker, {
        model: { connection: "deepseek", model: "deepseek-v4-pro" },
        wires: defaultWires,
      }),
    );
    await interact(() => user.click(trigger()));
    expect(within(menu()).getByRole("menuitemradio", { name: /high/ }).textContent).toContain("drops cache");
    expect(within(menu()).getByRole("menuitemradio", { name: /^off$/ }).textContent).not.toContain("drops cache");
    await interact(() => user.keyboard("{Escape}"));

    // 4. Warm trajectory (head != null) on suffix-injected toggle (deepseek-v4-pro off -> high) -> preserves cache
    await act(async () => {
      runInAction(() => {
        v4Session.root.kvs.reasoningEffort = "none";
      });
    });
    await interact(() => user.click(trigger()));
    expect(menu().textContent).not.toContain("drops cache");
  });

  it("supports stage mode and admits staged reasoningEffort to kv/set", async () => {
    expect(mintedReasoningEffort({ reasoningEffort: "low" }, { reasoningEffort: "high" })).toBe("high");
    expect(mintedReasoningEffort({ reasoningEffort: "low" }, { reasoningEffort: "" })).toBeNull();
    expect(mintedReasoningEffort({ reasoningEffort: "low" }, {})).toBe("low");

    const onStage = vi.fn();
    await render(
      h(ReasoningEffortPicker, {
        model: { connection: "openai", model: "gpt-5.4" },
        wires: defaultWires,
        staged: null,
        seed: "low",
        onStage,
      }),
    );
    expect(trigger().textContent).toBe("effort: low");
    await interact(() => user.click(trigger()));
    await interact(() => user.click(within(menu()).getByRole("menuitemradio", { name: "xhigh" })));
    expect(onStage).toHaveBeenCalledExactlyOnceWith("xhigh");
    expect(request).not.toHaveBeenCalled();

    await admitStagedSession(
      null,
      { request },
      {
        prompt: "hello",
        pictures: [],
        model: null,
        agent: "",
        permission: null,
        reasoningEffort: "xhigh",
      },
      [],
    );
    expect(request.mock.calls).toEqual([
      ["kv/set", { key: "reasoningEffort", value: "xhigh", remember: true }],
      ["turn", { prompt: "hello" }],
    ]);
  });
});
