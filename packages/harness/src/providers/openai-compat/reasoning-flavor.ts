/**
 * Reasoning request dialect for openai-compat completions.
 *
 * Effort is a PEW field. Flavor is host identity — same split as
 * {@link cacheFlavorFromBaseUrl}. Local / unknown hosts get an empty bag:
 * extra keys 400 on LM Studio / Ollama.
 *
 * Chat Completions vs Responses is still `completionApi()`. This table is
 * the Completions/Responses *extension*: which keys, which clamp, which echo.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningFlavor =
  "none" | "openai" | "chatgpt" | "grok" | "openrouter" | "deepseek" | "gemini" | "groq" | "qwen" | "kimi" | "together";

export type ReasoningEcho = "omit-empty" | "always";

export type ReasoningChatField = "reasoning_content" | "reasoning";

export type ReasoningApi = "chat" | "responses";

export type ReasoningPatchContext = {
  readonly api: ReasoningApi;
  readonly model: string;
  readonly hasTools: boolean;
};

export type ReasoningDialect = {
  readonly flavor: ReasoningFlavor;
  readonly echo: ReasoningEcho;
  readonly chatField: ReasoningChatField;
  readonly body: Readonly<Record<string, unknown>>;
};

const EMPTY_BODY: Readonly<Record<string, unknown>> = {};

const EFFORTS: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isEffort(value: string): value is ReasoningEffort {
  return EFFORTS.has(value);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function modelId(model: string): string {
  return model.trim().toLowerCase();
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function reasoningFlavorFromBaseUrl(baseUrl: string): ReasoningFlavor {
  const host = hostOf(baseUrl);
  if (host === "") return "none";
  if (isLoopback(host)) return "none";
  if (
    host === "api.x.ai" ||
    host.endsWith(".x.ai") ||
    host === "cli-chat-proxy.grok.com" ||
    host.endsWith(".grok.com")
  ) {
    return "grok";
  }
  if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return "chatgpt";
  if (host === "api.openai.com" || host.endsWith(".openai.com")) return "openai";
  if (host === "ai-gateway.vercel.sh" || host.endsWith(".ai-gateway.vercel.sh")) return "openai";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return "deepseek";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  if (host === "api.groq.com" || host.endsWith(".groq.com")) return "groq";
  if (
    host.includes("dashscope") ||
    host === "portal.qwen.ai" ||
    host.endsWith(".qwen.ai") ||
    host === "api.siliconflow.com" ||
    host === "api.siliconflow.cn" ||
    host.endsWith(".siliconflow.com") ||
    host.endsWith(".siliconflow.cn")
  ) {
    return "qwen";
  }
  if (
    host === "api.moonshot.ai" ||
    host === "api.moonshot.cn" ||
    host.endsWith(".moonshot.ai") ||
    host.endsWith(".moonshot.cn") ||
    host === "api.kimi.com" ||
    host.endsWith(".kimi.com")
  ) {
    return "kimi";
  }
  if (
    host === "api.together.ai" ||
    host === "api.together.xyz" ||
    host.endsWith(".together.ai") ||
    host.endsWith(".together.xyz")
  ) {
    return "together";
  }
  return "none";
}

function cannotDisable(flavor: ReasoningFlavor, model: string): boolean {
  const id = modelId(model);
  switch (flavor) {
    case "grok":
      return true;
    case "chatgpt":
    case "openai":
      return /(?:^|[^a-z0-9])gpt-6/.test(id);
    case "gemini":
      return id.includes("pro") || /gemini-3/.test(id);
    case "groq":
      return id.includes("gpt-oss");
    case "kimi":
      return id.includes("k3") || id.includes("k2.7") || id.includes("k2-7");
    case "together":
      return id.includes("gpt-oss");
    default:
      return false;
  }
}

/** Wire token after clamp. `default` is Groq Qwen's enable-without-tier. */
type WireEffort = ReasoningEffort | "default";

function mapDeepSeekEffort(effort: ReasoningEffort): ReasoningEffort {
  if (effort === "none") return "none";
  if (effort === "max") return "max";
  if (effort === "low") return "low";
  return "high";
}

function mapKimiEffort(effort: ReasoningEffort): "low" | "high" | "max" {
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  if (effort === "max" || effort === "xhigh") return "max";
  return "high";
}

function clampEffort(flavor: ReasoningFlavor, model: string, effort: ReasoningEffort): WireEffort {
  if (effort === "none" && cannotDisable(flavor, model)) return "low";
  if (flavor === "deepseek") return mapDeepSeekEffort(effort);
  if (flavor === "kimi") return mapKimiEffort(effort);
  if (flavor === "grok") {
    if (effort === "minimal") return "low";
    if (effort === "max") return modelId(model).includes("4.6") || modelId(model).includes("4.20") ? "xhigh" : "high";
    if (effort === "xhigh" && !modelId(model).includes("4.6") && !modelId(model).includes("4.20")) return "high";
    return effort;
  }
  if (flavor === "groq") {
    const id = modelId(model);
    if (id.includes("gpt-oss")) {
      if (effort === "none" || effort === "minimal") return "low";
      if (effort === "max" || effort === "xhigh") return "high";
      return effort === "low" || effort === "medium" || effort === "high" ? effort : "medium";
    }
    if (effort === "none") return "none";
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
    return "default";
  }
  return effort;
}

function geminiThinkingLevel(effort: WireEffort): "minimal" | "low" | "medium" | "high" {
  if (effort === "minimal") return "minimal";
  if (effort === "low") return "low";
  if (effort === "medium" || effort === "default") return "medium";
  return "high";
}

function geminiChatBody(effort: WireEffort | null): Record<string, unknown> {
  if (effort === "none") {
    return {
      extra_body: {
        google: {
          thinking_config: { include_thoughts: false, thinking_budget: 0 },
        },
      },
    };
  }
  const thinking_config: Record<string, unknown> = { include_thoughts: true };
  if (effort != null) thinking_config.thinking_level = geminiThinkingLevel(effort);
  return { extra_body: { google: { thinking_config } } };
}

function groqChatBody(effort: WireEffort | null): Record<string, unknown> {
  if (effort === "none") return { reasoning_effort: "none" };
  return effort == null ? { include_reasoning: true } : { reasoning_effort: effort, include_reasoning: true };
}

function openrouterChatBody(effort: WireEffort | null): Record<string, unknown> {
  if (effort === "none") return { reasoning: { effort: "none" } };
  return {
    reasoning: { ...(effort == null ? {} : { effort }), exclude: false },
  };
}

function deepSeekChatBody(effort: WireEffort): Record<string, unknown> {
  if (effort === "none") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

function kimiChatBody(model: string, effort: WireEffort): Record<string, unknown> {
  const id = modelId(model);
  if (id.includes("k3")) return { reasoning_effort: effort };
  if (id.includes("k2.7") || id.includes("k2-7")) return EMPTY_BODY;
  if (effort === "none") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" } };
}

function togetherChatBody(model: string, effort: WireEffort | null): Record<string, unknown> {
  const id = modelId(model);
  if (id.includes("gpt-oss")) return effort == null ? EMPTY_BODY : { reasoning_effort: effort };
  if (effort === "none") return { reasoning: { enabled: false } };
  return {
    reasoning: { enabled: true, ...(effort == null ? {} : { effort }) },
  };
}

function qwenChatBody(effort: WireEffort): Record<string, unknown> {
  if (effort === "none") return { enable_thinking: false };
  return { enable_thinking: true, reasoning_effort: effort };
}

function chatFieldFor(flavor: ReasoningFlavor): ReasoningChatField {
  if (flavor === "openrouter" || flavor === "groq" || flavor === "together") return "reasoning";
  return "reasoning_content";
}

function echoFor(flavor: ReasoningFlavor, hasTools: boolean): ReasoningEcho {
  if (flavor === "deepseek" && hasTools) return "always";
  if (flavor === "kimi" || flavor === "qwen") return "always";
  return "omit-empty";
}

function chatBody(flavor: ReasoningFlavor, model: string, effort: WireEffort | null): Record<string, unknown> {
  switch (flavor) {
    case "none":
    case "chatgpt":
      return EMPTY_BODY;
    case "openai":
    case "grok":
      return effort == null ? EMPTY_BODY : { reasoning_effort: effort };
    case "gemini":
      return geminiChatBody(effort);
    case "groq":
      return groqChatBody(effort);
    case "openrouter":
      return openrouterChatBody(effort);
    case "deepseek":
      return effort == null ? EMPTY_BODY : deepSeekChatBody(effort);
    case "qwen":
      return effort == null ? EMPTY_BODY : qwenChatBody(effort);
    case "kimi":
      return effort == null ? EMPTY_BODY : kimiChatBody(model, effort);
    case "together":
      return togetherChatBody(model, effort);
  }
}

function responsesBody(effort: WireEffort | null): Record<string, unknown> {
  const reasoning: Record<string, unknown> = { summary: "auto" };
  if (effort != null) reasoning.effort = effort;
  return { reasoning };
}

export function reasoningDialectFor(
  flavor: ReasoningFlavor,
  effort: string | null,
  ctx: ReasoningPatchContext,
): ReasoningDialect {
  const requested = effort == null ? null : effort.trim();
  const mapped = requested != null && isEffort(requested) ? clampEffort(flavor, ctx.model, requested) : null;
  const body =
    ctx.api === "responses"
      ? flavor === "none"
        ? EMPTY_BODY
        : responsesBody(mapped)
      : chatBody(flavor, ctx.model, mapped);
  return {
    flavor,
    echo: echoFor(flavor, ctx.hasTools),
    chatField: chatFieldFor(flavor),
    body,
  };
}
