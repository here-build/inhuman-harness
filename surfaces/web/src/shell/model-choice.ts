import { CompletionJob, isReasoningEffort, SessionTurn, type ReasoningEffort } from "@inhuman.tools/harness-model";

import { wireAccount, type AccountSource, type WireAccount } from "./wire-account.js";

/** A completion wire and one live model id on it. */
export type ModelChoice = {
  readonly connection: string;
  readonly model: string;
};

/** Per-million-token USD rates for a catalog model. */
export type ModelPricing = {
  readonly prompt: number;
  readonly completion: number;
  readonly cacheRead?: number;
};

export type ModelCapabilityHint = {
  readonly supportsReasoning?: boolean;
  readonly reasoningEfforts?: readonly ReasoningEffort[];
};

/** Enough of a kernel connection to list completion models and paint its account. */
export type ModelCatalogSource = AccountSource & {
  readonly id: string;
  /** The connection's own display name, e.g. `ChatGPT`. */
  readonly name?: string;
  readonly driver?: { readonly name?: string; readonly abilityClaim?: readonly string[] } | null;
  readonly settings?: { readonly baseUrl?: unknown } | null;
  readonly live?: {
    readonly models?: unknown;
    readonly catalogName?: unknown;
    readonly modelNames?: unknown;
    readonly modelPricing?: unknown;
    readonly modelCapabilities?: unknown;
  } | null;
};

/** One completion connection, its live catalog, and its account. */
export type ModelWire = {
  readonly connection: string;
  readonly name: string;
  readonly choices: readonly ModelChoice[];
  readonly account: WireAccount;
  readonly baseUrl?: string;
  readonly openrouter?: boolean;
  readonly modelNames?: Readonly<Record<string, string>>;
  readonly modelPricing?: Readonly<Record<string, ModelPricing>>;
  readonly modelCapabilities?: Readonly<Record<string, ModelCapabilityHint>>;
};

export type OpenRouterProvider = {
  readonly key: string;
  readonly label: string;
  readonly icon?: string;
};

const SMALL_CATALOG = 20;

const BADGE_TAGS = new Set(["free", "thinking", "extended", "beta", "preview", "nitro", "online", "floor", "exacto"]);

const NON_CHAT_TOKENS = new Set([
  "batch",
  "realtime",
  "whisper",
  "tts",
  "embedding",
  "embeddings",
  "rerank",
  "reranker",
  "moderation",
  "imagen",
  "sdxl",
  "midjourney",
  "ideogram",
  "recraft",
  "seedream",
]);

const NON_CHAT_PHRASES = [
  "nano-banana",
  "nano banana",
  "dall-e",
  "gpt-image",
  "grok-2-image",
  "flash-image",
  "image-preview",
  "audio-preview",
  "voice-to-voice",
  "speech-to-speech",
  "text-to-speech",
  "speech-to-text",
  "stable-diffusion",
];

const KNOWN_MODEL_TOKENS: Readonly<Record<string, string | undefined>> = {
  gpt: "GPT",
  gpt4: "GPT-4",
  gpt4o: "GPT-4o",
  gpt5: "GPT-5",
  chatgpt: "ChatGPT",
  glm: "GLM",
  glm4: "GLM-4",
  chatglm: "ChatGLM",
  ai: "AI",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  qwen2: "Qwen2",
  "qwen2.5": "Qwen2.5",
  qwen3: "Qwen3",
  "qwen3.5": "Qwen3.5",
  qwen4: "Qwen4",
  qwq: "QwQ",
  qvq: "QvQ",
  minimax: "MiniMax",
  codellama: "CodeLlama",
  starcoder: "StarCoder",
  starcoder2: "StarCoder2",
  deepcoder: "DeepCoder",
  wizardlm: "WizardLM",
  wizardcoder: "WizardCoder",
  internlm: "InternLM",
  internvl: "InternVL",
  olmo: "OLMo",
  olmoe: "OLMoE",
  molmo: "Molmo",
  dbrx: "DBRX",
  rwkv: "RWKV",
  ernie: "ERNIE",
  lfm: "LFM",
  lfm2: "LFM2",
  afm: "AFM",
  nemotron: "Nemotron",
  mixtral: "Mixtral",
  mistral: "Mistral",
  pixtral: "Pixtral",
  codestral: "Codestral",
  ministral: "Ministral",
  magistral: "Magistral",
  devstral: "Devstral",
  claude: "Claude",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
  gemini: "Gemini",
  gemma: "Gemma",
  learnlm: "LearnLM",
  grok: "Grok",
  llama: "Llama",
  hermes: "Hermes",
  nous: "Nous",
  sonar: "Sonar",
  r1: "R1",
  v2: "V2",
  "v2.5": "V2.5",
  v3: "V3",
  "v3.1": "V3.1",
  o1: "o1",
  o3: "o3",
  o4: "o4",
  "4o": "4o",
  vl: "VL",
  moe: "MoE",
  it: "IT",
  fp8: "FP8",
  fp16: "FP16",
  bf16: "BF16",
  int4: "INT4",
  int8: "INT8",
  awq: "AWQ",
  gptq: "GPTQ",
  gguf: "GGUF",
};

const OPENROUTER_DEFAULT_PROVIDER: OpenRouterProvider = {
  key: "openrouter",
  label: "OpenRouter",
  icon: "openrouter",
};

const OPENROUTER_PROVIDERS: Readonly<Record<string, OpenRouterProvider | undefined>> = {
  nvidia: { key: "nvidia", label: "NVIDIA", icon: "nvidia" },
  openai: { key: "openai", label: "OpenAI", icon: "openai" },
  anthropic: { key: "anthropic", label: "Anthropic", icon: "anthropic" },
  google: { key: "google", label: "Google", icon: "google" },
  "x-ai": { key: "xai", label: "xAI", icon: "xai" },
  xai: { key: "xai", label: "xAI", icon: "xai" },
  "meta-llama": { key: "meta", label: "Meta", icon: "meta" },
  meta: { key: "meta", label: "Meta", icon: "meta" },
  mistralai: { key: "mistral", label: "Mistral", icon: "mistral" },
  mistral: { key: "mistral", label: "Mistral", icon: "mistral" },
  deepseek: { key: "deepseek", label: "DeepSeek", icon: "deepseek" },
  qwen: { key: "qwen", label: "Qwen", icon: "qwen" },
  cohere: { key: "cohere", label: "Cohere", icon: "cohere" },
  perplexity: { key: "perplexity", label: "Perplexity", icon: "perplexity" },
  microsoft: { key: "microsoft", label: "Microsoft", icon: "microsoft" },
  amazon: { key: "amazon", label: "Amazon", icon: "amazon" },
  aws: { key: "amazon", label: "Amazon", icon: "amazon" },
  moonshotai: { key: "moonshot", label: "Moonshot", icon: "moonshot" },
  moonshot: { key: "moonshot", label: "Moonshot", icon: "moonshot" },
  minimax: { key: "minimax", label: "MiniMax", icon: "minimax" },
  "z-ai": { key: "zai", label: "Z.AI", icon: "zai" },
  zai: { key: "zai", label: "Z.AI", icon: "zai" },
  zhipu: { key: "zai", label: "Z.AI", icon: "zai" },
  thudm: { key: "zai", label: "Z.AI", icon: "zai" },
  openrouter: { key: "openrouter", label: "OpenRouter", icon: "openrouter" },
  huggingface: { key: "huggingface", label: "Hugging Face", icon: "huggingface" },
  huggingfaceh4: { key: "huggingface", label: "Hugging Face", icon: "huggingface" },
  ai21: { key: "ai21", label: "AI21", icon: "ai21" },
  "01-ai": { key: "zeroone", label: "01.AI", icon: "zeroone" },
  zeroone: { key: "zeroone", label: "01.AI", icon: "zeroone" },
  inflection: { key: "inflection", label: "Inflection", icon: "inflection" },
  liquid: { key: "liquid", label: "Liquid", icon: "liquid" },
  "stepfun-ai": { key: "stepfun", label: "StepFun", icon: "stepfun" },
  stepfun: { key: "stepfun", label: "StepFun", icon: "stepfun" },
  tencent: { key: "tencent", label: "Tencent", icon: "tencent" },
  baidu: { key: "baidu", label: "Baidu", icon: "baidu" },
  bytedance: { key: "bytedance", label: "ByteDance", icon: "bytedance" },
  "bytedance-research": { key: "bytedance", label: "ByteDance", icon: "bytedance" },
  alibaba: { key: "alibaba", label: "Alibaba", icon: "alibaba" },
  upstage: { key: "upstage", label: "Upstage", icon: "upstage" },
  snowflake: { key: "snowflake", label: "Snowflake", icon: "snowflake" },
  nousresearch: { key: "nous", label: "Nous Research" },
  nous: { key: "nous", label: "Nous Research" },
  "arcee-ai": { key: "arcee", label: "Arcee AI" },
  arcee: { key: "arcee", label: "Arcee AI" },
  allenai: { key: "allenai", label: "AllenAI" },
};

/**
 * Completion connections from kernel connection faces, named as `/connect`
 * names them (live catalog name, then the connection's name, then its id).
 * Catalogs with fewer than 20 ids come first, matching `/model`.
 */
export function completionWires(
  connections: Record<string, ModelCatalogSource | undefined> | null | undefined,
): ModelWire[] {
  const small: ModelWire[] = [];
  const large: ModelWire[] = [];
  if (connections == null) return [];
  for (const [key, spec] of Object.entries(connections)) {
    if (spec == null || !completes(spec)) continue;
    const connection = spec.id.trim() === "" ? key : spec.id;
    const name = wireName(spec, connection);
    const account = wireAccount(spec, name);
    const modelNames = parseModelNames(spec.live?.modelNames);
    const modelPricing = parseModelPricing(spec.live?.modelPricing);
    const modelCapabilities = parseModelCapabilities(spec.live?.modelCapabilities);
    const baseUrl =
      typeof spec.settings?.baseUrl === "string" && spec.settings.baseUrl.trim() !== ""
        ? spec.settings.baseUrl.trim()
        : undefined;
    const rawModels = account.needsAuth ? [] : modelIds(spec.live?.models, modelNames);
    if (rawModels.length === 0 && !account.needsAuth) continue;
    const openrouter = isOpenRouter(spec, connection, name);
    const models = openrouter ? groupOpenRouterModelIds(rawModels) : rawModels;
    const wire: ModelWire = {
      connection,
      name,
      choices: models.map((model) => ({ connection, model })),
      account,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(openrouter ? { openrouter: true } : {}),
      ...(modelNames === undefined ? {} : { modelNames }),
      ...(modelPricing === undefined ? {} : { modelPricing }),
      ...(modelCapabilities === undefined ? {} : { modelCapabilities }),
    };
    (models.length < SMALL_CATALOG ? small : large).push(wire);
  }
  return [...small, ...large];
}

/** A connection as `/connect` names it: live catalog name, then its own name, then its id. */
export function wireName(
  spec: Pick<ModelCatalogSource, "name" | "live"> | null | undefined,
  connection: string,
): string {
  const catalogName = spec?.live?.catalogName;
  const name = (typeof catalogName === "string" ? catalogName.trim() : "") || (spec?.name?.trim() ?? "");
  return name === "" ? connection : name;
}

export function modelChoiceValue(choice: ModelChoice): string {
  return JSON.stringify([choice.connection, choice.model]);
}

/**
 * Formats a model identifier into a curated display name, preferring an API
 * display name when available and stripping provider prefixes and badge tags.
 */
export function naturalName(id: string, apiName?: string): string {
  const cleanedApi = apiName === undefined ? "" : stripApiName(apiName);
  if (cleanedApi !== "") return normalizeModelPhrase(cleanedApi);
  const slug = stripBadgesFromSlug(stripVendorPrefix(id.trim()));
  if (slug === "") return id.trim();
  const normalizedSlug = slug
    .replaceAll(/\bcommand-r-plus\b/gi, "Command-R+")
    .replaceAll(/\bcommand-r\+/gi, "Command-R+")
    .replaceAll(/\bcommand-r\b/gi, "Command-R")
    .replaceAll(/\bcommand-a\b/gi, "Command-A");
  return normalizedSlug
    .split(/[\s_]+/)
    .flatMap((chunk) => (/^Command-(?:A|R\+?)$/i.test(chunk) ? [chunk] : chunk.split("-")))
    .filter((part) => part !== "")
    .map(formatModelToken)
    .join(" ");
}

/** Extracts badge tags (`free`, `batch`, `thinking`, etc.) from a model id, API name, or zero pricing. */
export function modelBadges(id: string, apiName?: string, pricing?: ModelPricing): string[] {
  const badges: string[] = [];
  const add = (tag: string): void => {
    const clean = tag.trim().toLowerCase();
    if (clean !== "" && BADGE_TAGS.has(clean) && !badges.includes(clean)) badges.push(clean);
  };
  const colonParts = id.trim().split(":");
  for (const part of colonParts.slice(1)) add(part);
  const baseSlug = stripVendorPrefix(colonParts[0] ?? "");
  const dashParts = baseSlug.split("-").filter((part) => part !== "");
  while (dashParts.length > 1) {
    const tail = dashParts[dashParts.length - 1]!.toLowerCase();
    if (!BADGE_TAGS.has(tail)) break;
    add(tail);
    dashParts.pop();
  }
  if (apiName !== undefined) {
    for (const match of apiName.matchAll(/\(([^()]+)\)/g)) {
      add(match[1]);
    }
  }
  if (pricing?.prompt === 0 && pricing.completion === 0) {
    add("free");
  }
  return badges;
}

/** Formats per-million-token pricing as `$cache/$in/$out`, `$in/$out`, or `free`. */
export function formatModelPricing(pricing: ModelPricing | undefined, badges: readonly string[] = []): string {
  if (badges.includes("free") || (pricing?.prompt === 0 && pricing.completion === 0)) {
    return "free";
  }
  if (pricing === undefined) return "";
  const prompt = formatRate(pricing.prompt);
  const completion = formatRate(pricing.completion);
  if (pricing.cacheRead !== undefined && pricing.cacheRead > 0) {
    return `$${formatRate(pricing.cacheRead)}/$${prompt}/$${completion}`;
  }
  return `$${prompt}/$${completion}`;
}

/** Resolves the internal OpenRouter provider group for a `<vendor>/<model>` id. */
export function openrouterProvider(modelId: string): OpenRouterProvider {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return OPENROUTER_DEFAULT_PROVIDER;
  const rawSlug = modelId.slice(0, slash).trim().toLowerCase();
  const known = OPENROUTER_PROVIDERS[rawSlug];
  if (known !== undefined) return known;
  return { key: rawSlug, label: naturalName(rawSlug) };
}

/**
 * The model the control names. The session kv wins. When it is empty, the
 * last turn that actually ran a model is what the tape is already showing.
 */
export function sessionModel(
  root: { readonly kvs?: Readonly<Record<string, string>> | null; readonly head?: unknown } | null | undefined,
): ModelChoice {
  const kv = root?.kvs;
  const model = (kv?.model ?? "").trim();
  const connection = (kv?.connection ?? "").trim();
  if (model !== "") return { connection, model };
  return lastTurnModel(root?.head) ?? { connection: "", model: "" };
}

function lastTurnModel(head: unknown): ModelChoice | null {
  const seen = new Set<unknown>();
  let turn: unknown = head;
  while (turn instanceof SessionTurn && !seen.has(turn)) {
    seen.add(turn);
    const chunks = [...turn.doneWork, ...turn.queue];
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const chunk = chunks[i];
      if (!(chunk instanceof CompletionJob)) continue;
      const model = chunk.expectation.model.trim();
      if (model === "") continue;
      return { connection: chunk.expectation.connectionId.trim(), model };
    }
    turn = turn.turnTail;
  }
  return null;
}

function completes(spec: ModelCatalogSource): boolean {
  return spec.driver?.abilityClaim?.includes("completion") ?? false;
}

function isOpenRouter(spec: ModelCatalogSource, connection: string, name: string): boolean {
  if (spec.driver?.name === "openrouter") return true;
  if (connection.toLowerCase() === "openrouter" || name.toLowerCase() === "openrouter") return true;
  const baseUrl = spec.settings?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.toLowerCase().includes("openrouter.ai");
}

function groupOpenRouterModelIds(models: readonly string[]): string[] {
  if (!models.some((id) => id.includes("/"))) return [...models];
  const groups = new Map<string, string[]>();
  for (const id of models) {
    const { key } = openrouterProvider(id);
    let bucket = groups.get(key);
    if (bucket === undefined) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(id);
  }
  return [...groups.values()].flat();
}

function parseModelNames(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim() !== "") {
      out[key] = value.trim();
      count += 1;
    }
  }
  return count > 0 ? out : undefined;
}

function parseModelPricing(raw: unknown): Readonly<Record<string, ModelPricing>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, ModelPricing> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const rec = value as Record<string, unknown>;
    if (typeof rec.prompt !== "number" || !Number.isFinite(rec.prompt) || rec.prompt < 0) continue;
    if (typeof rec.completion !== "number" || !Number.isFinite(rec.completion) || rec.completion < 0) continue;
    const cacheRead =
      typeof rec.cacheRead === "number" && Number.isFinite(rec.cacheRead) && rec.cacheRead > 0
        ? rec.cacheRead
        : undefined;
    out[key] = {
      prompt: rec.prompt,
      completion: rec.completion,
      ...(cacheRead === undefined ? {} : { cacheRead }),
    };
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function parseModelCapabilities(raw: unknown): Readonly<Record<string, ModelCapabilityHint>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, ModelCapabilityHint> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const rec = value as Record<string, unknown>;
    const supportsReasoning = typeof rec.supportsReasoning === "boolean" ? rec.supportsReasoning : undefined;
    const reasoningEfforts = Array.isArray(rec.reasoningEfforts)
      ? rec.reasoningEfforts.filter(isReasoningEffort)
      : undefined;
    if (supportsReasoning === undefined && (reasoningEfforts === undefined || reasoningEfforts.length === 0)) continue;
    out[key] = {
      ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
      ...(reasoningEfforts === undefined || reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
    };
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function stripVendorPrefix(id: string): string {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return id;
  return id.slice(slash + 1);
}

function stripBadgesFromSlug(slug: string): string {
  const withoutColon = slug.split(":")[0] ?? slug;
  const parts = withoutColon.split("-").filter((part) => part !== "");
  while (parts.length > 1 && BADGE_TAGS.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
  }
  return parts.join("-");
}

function stripApiName(apiName: string): string {
  let text = apiName.trim();
  const colon = text.indexOf(": ");
  if (colon > 0) text = text.slice(colon + 2).trim();
  text = text
    .replaceAll(/\s*\(([^()]+)\)\s*$/g, (full, inner: string) =>
      BADGE_TAGS.has(inner.trim().toLowerCase()) || inner.trim().toLowerCase() === "self-moderated" ? "" : full,
    )
    .trim();
  return text;
}

function normalizeModelPhrase(phrase: string): string {
  const replaced = phrase
    .replaceAll(/\bcommand[\s-]+r[\s-]+plus\b/gi, "Command-R+")
    .replaceAll(/\bcommand[\s-]+r\+/gi, "Command-R+")
    .replaceAll(/\bcommand[\s-]+r\b/gi, "Command-R")
    .replaceAll(/\bcommand[\s-]+a\b/gi, "Command-A");
  return replaced
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => {
      if (/^Command-(?:A|R\+?)$/i.test(word)) return word;
      if (word.includes("-")) {
        return word
          .split("-")
          .map((sub) => formatModelToken(sub))
          .join("-");
      }
      return formatModelToken(word);
    })
    .join(" ");
}

function formatModelToken(part: string): string {
  if (/^Command-(?:A|R\+?)$/i.test(part)) {
    const suffix = part.slice("Command-".length).toUpperCase();
    return `Command-${suffix}`;
  }
  const lower = part.toLowerCase();
  const known = KNOWN_MODEL_TOKENS[lower];
  if (known !== undefined) return known;
  if (lower.startsWith("a") && lower.endsWith("b") && isNumericToken(lower.slice(1, -1))) {
    return part.toUpperCase();
  }
  if (lower.endsWith("b") || lower.endsWith("m") || lower.endsWith("k")) {
    const unit = lower.slice(-1).toUpperCase();
    const stem = lower.slice(0, -1);
    if (isNumericToken(stem)) return `${stem}${unit}`;
    const xIndex = stem.indexOf("x");
    if (xIndex > 0 && /^\d+$/.test(stem.slice(0, xIndex)) && isNumericToken(stem.slice(xIndex + 1))) {
      return `${stem.slice(0, xIndex)}x${stem.slice(xIndex + 1)}${unit}`;
    }
  }
  return part.charAt(0).toUpperCase() + part.slice(1);
}

function isNumericToken(value: string): boolean {
  if (value === "") return false;
  const parts = value.split(".");
  if (parts.length > 2) return false;
  return parts.every((segment) => segment !== "" && /^\d+$/.test(segment));
}

function formatRate(rate: number): string {
  return Number(rate.toFixed(4)).toString();
}

function modelIds(raw: unknown, modelNames?: Readonly<Record<string, string>>): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (typeof row !== "string") continue;
    const id = row.trim();
    if (id === "" || seen.has(id) || isNonChatModel(id, modelNames?.[id])) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isNonChatModel(id: string, apiName = ""): boolean {
  const lower = `${id} ${apiName}`.toLowerCase().replaceAll("_", "-");
  for (const phrase of NON_CHAT_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  for (const token of lower.split(/[\s:/.()-]+/)) {
    if (token !== "" && NON_CHAT_TOKENS.has(token)) return true;
  }
  return false;
}
