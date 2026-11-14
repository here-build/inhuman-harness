import { describe, expect, it } from "vitest";

import {
  REASONING_EFFORTS,
  formatReasoningEffortLabel,
  isReasoningEffort,
  parseReasoningEffort,
  reasoningEffortOf,
  reasoningProfileFor,
  willEffortSwitchDropCache,
} from "../reasoning-effort.js";

describe("reasoning-effort vocabulary", () => {
  it("recognizes valid reasoning efforts and rejects invalid ones", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(reasoningEffortOf(effort)).toBe(effort);
      expect(isReasoningEffort(effort)).toBe(true);
      expect(parseReasoningEffort(`  ${effort.toUpperCase()} `)).toBe(effort);
    }

    expect(reasoningEffortOf("")).toBeNull();
    expect(reasoningEffortOf("invalid")).toBeNull();
    expect(reasoningEffortOf(null)).toBeNull();
    expect(reasoningEffortOf(undefined)).toBeNull();
    expect(isReasoningEffort("auto")).toBe(false);
    expect(parseReasoningEffort(123)).toBeNull();
  });

  it("formats reasoning effort labels", () => {
    expect(formatReasoningEffortLabel(null)).toBe("default");
    expect(formatReasoningEffortLabel("")).toBe("default");
    expect(formatReasoningEffortLabel("none")).toBe("off");
    expect(formatReasoningEffortLabel("minimal")).toBe("minimal");
    expect(formatReasoningEffortLabel("low")).toBe("low");
    expect(formatReasoningEffortLabel("medium")).toBe("medium");
    expect(formatReasoningEffortLabel("high")).toBe("high");
    expect(formatReasoningEffortLabel("xhigh")).toBe("xhigh");
    expect(formatReasoningEffortLabel("max")).toBe("max");
  });
});

describe("reasoningProfileFor", () => {
  it("handles empty model with and without hints", () => {
    expect(reasoningProfileFor("")).toEqual({
      supportsReasoning: false,
      canDisable: true,
      supportedEfforts: [],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("   ", { supportsReasoning: true })).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(
      reasoningProfileFor("", {
        supportsReasoning: true,
        reasoningEfforts: ["none", "low", "high"],
      }),
    ).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });
  });

  it("classifies Anthropic Claude models and cache impact", () => {
    for (const model of [
      "claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(reasoningProfileFor(model)).toEqual({
        supportsReasoning: true,
        canDisable: true,
        supportedEfforts: ["none", "low", "medium", "high", "max"],
        effortSwitchCacheImpact: "drops-messages",
        toggleCacheImpact: "drops-messages",
      });
    }

    for (const model of [
      "claude-3-7-sonnet-20250219",
      "claude-3.7-sonnet",
      "claude-sonnet-4-20250514",
      "claude-opus-4-1",
      "claude-haiku-4",
      "claude-4-sonnet",
    ]) {
      expect(reasoningProfileFor(model)).toEqual({
        supportsReasoning: true,
        canDisable: true,
        supportedEfforts: ["none", "low", "medium", "high"],
        effortSwitchCacheImpact: "drops-messages",
        toggleCacheImpact: "drops-messages",
      });
    }

    expect(reasoningProfileFor("claude-3-5-sonnet-20241022").supportsReasoning).toBe(false);
    expect(reasoningProfileFor("claude-3-opus-20240229").supportsReasoning).toBe(false);
    expect(reasoningProfileFor("claude-3-5-sonnet:thinking").supportsReasoning).toBe(true);
  });

  it("classifies OpenAI models", () => {
    expect(reasoningProfileFor("openai/gpt-6")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    for (const model of ["gpt-5-pro", "gpt-5-codex", "o1", "o3-mini", "o4-mini", "gpt-oss-120b"]) {
      expect(reasoningProfileFor(model)).toEqual({
        supportsReasoning: true,
        canDisable: false,
        supportedEfforts: ["low", "medium", "high"],
        effortSwitchCacheImpact: "drops-full",
        toggleCacheImpact: "drops-full",
      });
    }

    for (const model of ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.6", "gpt-5-mini", "gpt-5-nano"]) {
      expect(reasoningProfileFor(model)).toEqual({
        supportsReasoning: true,
        canDisable: true,
        supportedEfforts: ["none", "low", "medium", "high", "xhigh"],
        effortSwitchCacheImpact: "drops-full",
        toggleCacheImpact: "drops-full",
      });
    }

    expect(reasoningProfileFor("gpt-4o").supportsReasoning).toBe(false);
    expect(reasoningProfileFor("gpt-3.5-turbo").supportsReasoning).toBe(false);
    expect(reasoningProfileFor("chatgpt-4o-latest").supportsReasoning).toBe(false);
  });

  it("classifies DeepSeek, Qwen, Kimi, GLM, Grok, Gemini, and other families", () => {
    expect(reasoningProfileFor("deepseek/deepseek-r1")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("deepseek-v4")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("deepseek-v3.2")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("qwen/qwq-32b")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("qwen3.8-max")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("qwen3-235b-a22b")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("moonshotai/kimi-k3")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("kimi-k2.7")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("kimi-k2-thinking")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("z-ai/glm-5.3")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high", "max"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("glm-4.6")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "high"],
      effortSwitchCacheImpact: "preserve",
      toggleCacheImpact: "preserve",
    });

    expect(reasoningProfileFor("x-ai/grok-4.20")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("grok-3-mini")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["low", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("google/gemini-2.5-pro")).toEqual({
      supportsReasoning: true,
      canDisable: false,
      supportedEfforts: ["minimal", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("gemini-2.5-flash")).toEqual({
      supportsReasoning: true,
      canDisable: true,
      supportedEfforts: ["none", "minimal", "low", "medium", "high"],
      effortSwitchCacheImpact: "drops-full",
      toggleCacheImpact: "drops-full",
    });

    expect(reasoningProfileFor("mistralai/magistral-medium").supportsReasoning).toBe(true);
    expect(reasoningProfileFor("minimax/minimax-m2").supportsReasoning).toBe(true);
    expect(reasoningProfileFor("nemotron-super-thinking").supportsReasoning).toBe(true);
  });

  it("respects catalog hints for reasoningEfforts and explicit supportsReasoning=false", () => {
    const overridden = reasoningProfileFor("claude-sonnet-4-6", {
      reasoningEfforts: ["low", "high"],
    });
    expect(overridden.supportedEfforts).toEqual(["none", "low", "high"]);

    const explicitlyDisabled = reasoningProfileFor("claude-sonnet-4-6", {
      supportsReasoning: false,
    });
    expect(explicitlyDisabled.supportsReasoning).toBe(false);
    expect(explicitlyDisabled.supportedEfforts).toEqual([]);
  });
});

describe("willEffortSwitchDropCache", () => {
  it("preserves cache when trajectory is cold or effort is unchanged", () => {
    const claude = reasoningProfileFor("claude-sonnet-4-6");
    expect(willEffortSwitchDropCache(claude, "low", "high", false)).toBe("preserve");
    expect(willEffortSwitchDropCache(claude, "high", "high", true)).toBe("preserve");
  });

  it("reports drops-messages for Anthropic and drops-full for OpenAI on warm sessions", () => {
    const claude = reasoningProfileFor("claude-sonnet-4-6");
    expect(willEffortSwitchDropCache(claude, "low", "high", true)).toBe("drops-messages");
    expect(willEffortSwitchDropCache(claude, "none", "high", true)).toBe("drops-messages");

    const gpt5 = reasoningProfileFor("gpt-5.4");
    expect(willEffortSwitchDropCache(gpt5, "low", "high", true)).toBe("drops-full");
    expect(willEffortSwitchDropCache(gpt5, "none", "high", true)).toBe("drops-full");
  });

  it("distinguishes toggle vs active-tier switch on hybrid models like DeepSeek-V4 and Qwen3", () => {
    const deepseekV4 = reasoningProfileFor("deepseek-v4");
    expect(willEffortSwitchDropCache(deepseekV4, "none", "high", true)).toBe("preserve");
    expect(willEffortSwitchDropCache(deepseekV4, "high", "none", true)).toBe("preserve");
    expect(willEffortSwitchDropCache(deepseekV4, null, "none", true)).toBe("preserve");
    expect(willEffortSwitchDropCache(deepseekV4, "low", "high", true)).toBe("drops-full");
  });
});
