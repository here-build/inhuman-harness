/**
 * Well-known OpenAI-compat catalogs. Used to name a pasted baseUrl
 * (Fireworks, not fireworks.ai), and the source of the key-only picker rows
 * ({@link REMOTE_OFFERS} in presence.ts: one per name, first baseUrl).
 *
 * Sources: Hermes `plugins/model-providers/` + providers.md,
 * LiteLLM `openai_compatible_endpoints`, vendor OpenAI-compat docs.
 * Only entries with a cited official baseUrl.
 */
export type WellKnownEndpoint = {
  readonly name: string;
  readonly baseUrl: string;
};

export const WELL_KNOWN_ENDPOINTS: readonly WellKnownEndpoint[] = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { name: "Codestral", baseUrl: "https://codestral.mistral.ai/v1" },
  { name: "Together", baseUrl: "https://api.together.ai/v1" },
  { name: "Together", baseUrl: "https://api.together.xyz/v1" },
  { name: "xAI", baseUrl: "https://api.x.ai/v1" },
  { name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Helicone", baseUrl: "https://ai-gateway.helicone.ai/v1" },
  { name: "Helicone", baseUrl: "https://ai-gateway.helicone.ai" },
  { name: "Poe", baseUrl: "https://api.poe.com/v1" },
  { name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1" },
  { name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1" },
  { name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1" },
  { name: "Nous Portal", baseUrl: "https://inference-api.nousresearch.com/v1" },
  { name: "Qwen Portal", baseUrl: "https://portal.qwen.ai/v1" },
  { name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1" },
  { name: "SambaNova", baseUrl: "https://api.sambanova.ai/v1" },
  { name: "Hyperbolic", baseUrl: "https://api.hyperbolic.xyz/v1" },
  { name: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai" },
  { name: "Friendli", baseUrl: "https://api.friendli.ai/serverless/v1" },
  { name: "Friendli", baseUrl: "https://inference.friendli.ai/v1" },
  { name: "Novita", baseUrl: "https://api.novita.ai/openai/v1" },
  { name: "Novita", baseUrl: "https://api.novita.ai/openai" },
  { name: "Novita", baseUrl: "https://api.novita.ai/v3/openai" },
  { name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
  {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  { name: "Perplexity", baseUrl: "https://api.perplexity.ai" },
  { name: "Perplexity", baseUrl: "https://api.perplexity.ai/v1" },
  { name: "Cohere", baseUrl: "https://api.cohere.ai/compatibility/v1" },
  { name: "Ollama Cloud", baseUrl: "https://ollama.com/v1" },
  { name: "v0", baseUrl: "https://api.v0.dev/v1" },
  { name: "Lambda", baseUrl: "https://api.lambda.ai/v1" },
  { name: "Nebius", baseUrl: "https://api.studio.nebius.ai/v1" },
  { name: "Nebius", baseUrl: "https://api.tokenfactory.nebius.com/v1" },
  { name: "Scaleway", baseUrl: "https://api.scaleway.ai/v1" },
  {
    name: "OVHcloud",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
  },
  { name: "GMI Cloud", baseUrl: "https://api.gmi-serving.com/v1" },
  { name: "Arcee", baseUrl: "https://api.arcee.ai/api/v1" },
  { name: "Baseten", baseUrl: "https://inference.baseten.co/v1" },
  { name: "Chutes", baseUrl: "https://llm.chutes.ai/v1" },
  { name: "Clarifai", baseUrl: "https://api.clarifai.com/v2/ext/openai/v1" },
  { name: "Weights & Biases", baseUrl: "https://api.inference.wandb.ai/v1" },
  { name: "DigitalOcean", baseUrl: "https://inference.do-ai.run/v1" },
  { name: "Llama API", baseUrl: "https://api.llama.com/compat/v1" },
  { name: "Inception", baseUrl: "https://api.inceptionlabs.ai/v1" },
  { name: "Venice", baseUrl: "https://api.venice.ai/api/v1" },
  { name: "Morph", baseUrl: "https://api.morphllm.com/v1" },
  { name: "Nscale", baseUrl: "https://inference.api.nscale.com/v1" },
  { name: "Meta", baseUrl: "https://api.meta.ai/v1" },
  { name: "AI/ML API", baseUrl: "https://api.aimlapi.com/v1" },
  { name: "Actual", baseUrl: "https://api.actual.inc/v1" },
  {
    name: "DashScope",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  {
    name: "DashScope China",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    name: "Alibaba Coding Plan",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
  },
  { name: "Moonshot", baseUrl: "https://api.moonshot.ai/v1" },
  { name: "Moonshot China", baseUrl: "https://api.moonshot.cn/v1" },
  { name: "Kimi Code", baseUrl: "https://api.kimi.com/coding/v1" },
  { name: "MiniMax", baseUrl: "https://api.minimax.io/v1" },
  { name: "MiniMax China", baseUrl: "https://api.minimaxi.com/v1" },
  { name: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4" },
  { name: "Z.AI Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  { name: "SiliconFlow", baseUrl: "https://api.siliconflow.com/v1" },
  { name: "SiliconFlow China", baseUrl: "https://api.siliconflow.cn/v1" },
  { name: "StepFun", baseUrl: "https://api.stepfun.ai/v1" },
  { name: "StepFun", baseUrl: "https://api.stepfun.com/v1" },
  { name: "StepFun Plan", baseUrl: "https://api.stepfun.ai/step_plan/v1" },
  { name: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1" },
  { name: "Upstage", baseUrl: "https://api.upstage.ai/v1" },
  { name: "Upstage", baseUrl: "https://api.upstage.ai/v1/solar" },
  { name: "ModelScope", baseUrl: "https://api-inference.modelscope.cn/v1" },
  { name: "Tencent TokenHub", baseUrl: "https://tokenhub.tencentmaas.com/v1" },
];

function normalizePath(path: string): string {
  if (path === "/" || path === "") return "";
  return path.replace(/\/+$/, "");
}

function catalogKey(url: URL): string {
  return `${url.origin}${normalizePath(url.pathname)}`;
}

export function wellKnownFromBaseUrl(baseUrl: string): WellKnownEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const key = catalogKey(url);
  const host = url.hostname.toLowerCase();
  let hostHit: WellKnownEndpoint | undefined;
  for (const endpoint of WELL_KNOWN_ENDPOINTS) {
    let remote: URL;
    try {
      remote = new URL(endpoint.baseUrl);
    } catch {
      continue;
    }
    if (catalogKey(remote) === key) return endpoint;
    if (remote.hostname.toLowerCase() === host) hostHit ??= endpoint;
  }
  return hostHit;
}
