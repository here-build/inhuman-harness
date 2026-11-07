import { describe, expect, it } from "vitest";

import { reasoningDialectFor, reasoningFlavorFromBaseUrl } from "../reasoning-flavor.js";

describe("reasoning flavor", () => {
  it("keys flavor off host; loopback is none", () => {
    expect({
      grok: reasoningFlavorFromBaseUrl("https://api.x.ai/v1"),
      grokProxy: reasoningFlavorFromBaseUrl("https://cli-chat-proxy.grok.com/v1"),
      openai: reasoningFlavorFromBaseUrl("https://api.openai.com/v1"),
      chatgpt: reasoningFlavorFromBaseUrl("https://chatgpt.com/backend-api/codex"),
      openrouter: reasoningFlavorFromBaseUrl("https://openrouter.ai/api/v1"),
      deepseek: reasoningFlavorFromBaseUrl("https://api.deepseek.com/v1"),
      gemini: reasoningFlavorFromBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
      groq: reasoningFlavorFromBaseUrl("https://api.groq.com/openai/v1"),
      qwen: reasoningFlavorFromBaseUrl("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
      kimi: reasoningFlavorFromBaseUrl("https://api.moonshot.ai/v1"),
      together: reasoningFlavorFromBaseUrl("https://api.together.ai/v1"),
      vercel: reasoningFlavorFromBaseUrl("https://ai-gateway.vercel.sh/v1"),
      local: reasoningFlavorFromBaseUrl("http://127.0.0.1:1234/v1"),
      unknown: reasoningFlavorFromBaseUrl("https://example.invalid/v1"),
    }).toEqual({
      grok: "grok",
      grokProxy: "grok",
      openai: "openai",
      chatgpt: "chatgpt",
      openrouter: "openrouter",
      deepseek: "deepseek",
      gemini: "gemini",
      groq: "groq",
      qwen: "qwen",
      kimi: "kimi",
      together: "together",
      vercel: "openai",
      local: "none",
      unknown: "none",
    });
  });

  it("patches effort, clamps disable, and picks echo", () => {
    const grokHigh = reasoningDialectFor("grok", "high", {
      api: "chat",
      model: "grok-4.6",
      hasTools: true,
    });
    const grokNone = reasoningDialectFor("grok", "none", {
      api: "chat",
      model: "grok-4.6",
      hasTools: true,
    });
    const deepseekTools = reasoningDialectFor("deepseek", "medium", {
      api: "chat",
      model: "deepseek-v4-pro",
      hasTools: true,
    });
    const deepseekOff = reasoningDialectFor("deepseek", "none", {
      api: "chat",
      model: "deepseek-v4-pro",
      hasTools: false,
    });
    const openaiResponses = reasoningDialectFor("openai", "high", {
      api: "responses",
      model: "gpt-5.6",
      hasTools: true,
    });
    const gpt6None = reasoningDialectFor("openai", "none", {
      api: "chat",
      model: "gpt-6-astra",
      hasTools: false,
    });
    const local = reasoningDialectFor("none", "high", {
      api: "chat",
      model: "m1",
      hasTools: true,
    });
    const openrouter = reasoningDialectFor("openrouter", "low", {
      api: "chat",
      model: "openai/o3-mini",
      hasTools: false,
    });
    const openrouterDefault = reasoningDialectFor("openrouter", "", {
      api: "chat",
      model: "openai/o3-mini",
      hasTools: false,
    });
    const groqDefault = reasoningDialectFor("groq", "", {
      api: "chat",
      model: "openai/gpt-oss-20b",
      hasTools: false,
    });
    const geminiDefault = reasoningDialectFor("gemini", "", {
      api: "chat",
      model: "gemini-3.8-flash",
      hasTools: false,
    });
    const responsesDefault = reasoningDialectFor("openai", "", {
      api: "responses",
      model: "gpt-5.6",
      hasTools: true,
    });
    expect({
      grokHigh: { body: grokHigh.body, echo: grokHigh.echo },
      grokNone: grokNone.body,
      deepseekTools: { body: deepseekTools.body, echo: deepseekTools.echo },
      deepseekOff: { body: deepseekOff.body, echo: deepseekOff.echo },
      openaiResponses: openaiResponses.body,
      gpt6None: gpt6None.body,
      local: local.body,
      openrouter: openrouter.body,
      openrouterDefault: openrouterDefault.body,
      groqDefault: groqDefault.body,
      geminiDefault: geminiDefault.body,
      responsesDefault: responsesDefault.body,
    }).toEqual({
      grokHigh: { body: { reasoning_effort: "high" }, echo: "omit-empty" },
      grokNone: { reasoning_effort: "low" },
      deepseekTools: {
        body: { thinking: { type: "enabled" }, reasoning_effort: "high" },
        echo: "always",
      },
      deepseekOff: {
        body: { thinking: { type: "disabled" } },
        echo: "omit-empty",
      },
      openaiResponses: { reasoning: { summary: "auto", effort: "high" } },
      gpt6None: { reasoning_effort: "low" },
      local: {},
      openrouter: { reasoning: { effort: "low", exclude: false } },
      openrouterDefault: { reasoning: { exclude: false } },
      groqDefault: { include_reasoning: true },
      geminiDefault: {
        extra_body: { google: { thinking_config: { include_thoughts: true } } },
      },
      responsesDefault: { reasoning: { summary: "auto" } },
    });
  });

  it("clamps Qwen 3.8 high/max to xhigh and minimal to low", () => {
    expect(
      reasoningDialectFor("qwen", "high", {
        api: "chat",
        model: "qwen3.8-27b",
        hasTools: false,
      }).body,
    ).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
    expect(
      reasoningDialectFor("qwen", "minimal", {
        api: "chat",
        model: "qwen-3.8-plus",
        hasTools: false,
      }).body,
    ).toEqual({ enable_thinking: true, reasoning_effort: "low" });
    expect(
      reasoningDialectFor("openrouter", "high", {
        api: "chat",
        model: "qwen/qwen3.8-27b",
        hasTools: false,
      }).body,
    ).toEqual({ reasoning: { effort: "xhigh", exclude: false } });
    expect(
      reasoningDialectFor("qwen", "none", {
        api: "chat",
        model: "qwen3.8-27b",
        hasTools: false,
      }).body,
    ).toEqual({ enable_thinking: false });
  });

  it("applies model-origin cannotDisable and echoFor across gateways", () => {
    expect(
      reasoningDialectFor("openrouter", "none", {
        api: "chat",
        model: "x-ai/grok-4.6",
        hasTools: false,
      }).body,
    ).toEqual({ reasoning: { effort: "low", exclude: false } });
    expect(
      reasoningDialectFor("openrouter", "none", {
        api: "chat",
        model: "openai/gpt-6-astra",
        hasTools: false,
      }).body,
    ).toEqual({ reasoning: { effort: "low", exclude: false } });
    expect(
      reasoningDialectFor("openrouter", "none", {
        api: "chat",
        model: "moonshotai/kimi-k3",
        hasTools: false,
      }).body,
    ).toEqual({ reasoning: { effort: "low", exclude: false } });
    expect(
      reasoningDialectFor("openrouter", "none", {
        api: "chat",
        model: "z-ai/glm-5.3",
        hasTools: false,
      }).body,
    ).toEqual({ reasoning: { effort: "low", exclude: false } });

    expect(
      reasoningDialectFor("openrouter", "medium", {
        api: "chat",
        model: "deepseek/deepseek-v4-pro",
        hasTools: true,
      }).echo,
    ).toBe("always");
    expect(
      reasoningDialectFor("openrouter", "medium", {
        api: "chat",
        model: "qwen/qwen3.8-27b",
        hasTools: false,
      }).echo,
    ).toBe("always");
    expect(
      reasoningDialectFor("openrouter", "medium", {
        api: "chat",
        model: "z-ai/glm-5.3",
        hasTools: false,
      }),
    ).toMatchObject({
      echo: "always",
      body: { reasoning: { effort: "high", exclude: false } },
    });
  });
});
