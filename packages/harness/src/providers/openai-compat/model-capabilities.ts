/** Provider-declared input support. Missing fields remain unknown, not text-only. */
export type ModelCapabilities = {
  inputModalities?: string[];
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  reasoningEfforts?: string[];
};

const VALID_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const REASONING_PARAMETERS: ReadonlySet<string> = new Set([
  "reasoning",
  "reasoning_effort",
  "include_reasoning",
  "thinking",
]);

/** Per-million-token USD rates declared on a `/models` catalog row. */
export type ModelPricing = {
  prompt: number;
  completion: number;
  cacheRead?: number;
};

export function modelCapabilitiesOf(row: object): ModelCapabilities | undefined {
  const rec = row as Record<string, unknown>;
  const architecture = rec.architecture;
  const routed =
    typeof architecture === "object" && architecture !== null
      ? (architecture as Record<string, unknown>).input_modalities
      : undefined;
  const inputModalities = modalitiesOf(rec.input_modalities) ?? modalitiesOf(routed);
  const supportsVision = typeof rec.supports_vision === "boolean" ? rec.supports_vision : undefined;
  const supportsReasoning = supportsReasoningOf(rec);
  const reasoningEfforts = reasoningEffortsOf(rec);
  if (
    inputModalities === undefined &&
    supportsVision === undefined &&
    supportsReasoning === undefined &&
    reasoningEfforts === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
  };
}

function supportsReasoningOf(rec: Record<string, unknown>): boolean | undefined {
  if (typeof rec.supports_reasoning === "boolean") return rec.supports_reasoning;
  if (Array.isArray(rec.supported_parameters)) {
    const hasReasoningParam = rec.supported_parameters.some(
      (param) => typeof param === "string" && REASONING_PARAMETERS.has(param.trim().toLowerCase()),
    );
    if (hasReasoningParam) return true;
  }
  if (typeof rec.reasoning === "boolean") return rec.reasoning;
  if (typeof rec.reasoning === "object" && rec.reasoning !== null) {
    const r = rec.reasoning as Record<string, unknown>;
    if (typeof r.supported === "boolean") return r.supported;
    if (typeof r.enabled === "boolean") return r.enabled;
    return true;
  }
  if (
    (Array.isArray(rec.supported_reasoning_levels) && rec.supported_reasoning_levels.length > 0) ||
    (Array.isArray(rec.reasoning_efforts) && rec.reasoning_efforts.length > 0)
  ) {
    return true;
  }
  return undefined;
}

function reasoningEffortsOf(rec: Record<string, unknown>): string[] | undefined {
  const reasoningObj =
    typeof rec.reasoning === "object" && rec.reasoning !== null
      ? (rec.reasoning as Record<string, unknown>)
      : undefined;
  const raw =
    rec.supported_reasoning_levels ??
    rec.reasoning_efforts ??
    reasoningObj?.supported_efforts ??
    reasoningObj?.efforts;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const item of raw) {
    const val =
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null && typeof (item as { effort?: unknown }).effort === "string"
          ? (item as { effort: string }).effort
          : undefined;
    if (val === undefined) continue;
    const normalized = val.trim().toLowerCase();
    if (VALID_REASONING_EFFORTS.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      efforts.push(normalized);
    }
  }
  return efforts.length > 0 ? efforts : undefined;
}

const NON_CHAT_TYPES = new Set([
  "image",
  "images",
  "image-generation",
  "text-to-image",
  "image-to-image",
  "audio",
  "tts",
  "text-to-speech",
  "stt",
  "asr",
  "speech",
  "speech-to-text",
  "automatic-speech-recognition",
  "voice",
  "voice-to-voice",
  "speech-to-speech",
  "audio-to-audio",
  "realtime",
  "video",
  "text-to-video",
  "image-to-video",
  "embedding",
  "embeddings",
  "feature-extraction",
  "rerank",
  "reranker",
  "moderation",
  "classification",
  "transcribe",
  "transcription",
]);

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

/**
 * Returns true when a `/models` catalog row represents a text-chat completion model
 * (excluding image generators like Nano Banana, voice-to-voice/audio models, embeddings,
 * rerankers, moderation models, and batch-only models).
 */
export function isChatModel(row: object, id: string): boolean {
  const rec = row as Record<string, unknown>;
  if (rec.batch === true) return false;
  const rawName =
    typeof rec.name === "string" ? rec.name : typeof rec.display_name === "string" ? rec.display_name : "";
  if (isNonChatIdentifier(id) || (rawName !== "" && isNonChatIdentifier(rawName))) return false;

  const arch =
    typeof rec.architecture === "object" && rec.architecture !== null
      ? (rec.architecture as Record<string, unknown>)
      : undefined;

  const inputModalities = modalitiesOf(rec.input_modalities) ?? modalitiesOf(arch?.input_modalities);
  if (inputModalities !== undefined && !inputModalities.includes("text")) return false;

  const outputModalities = modalitiesOf(rec.output_modalities) ?? modalitiesOf(arch?.output_modalities);
  if (outputModalities !== undefined && !outputModalities.every((modality) => modality === "text")) {
    return false;
  }

  const modality =
    typeof rec.modality === "string" ? rec.modality : typeof arch?.modality === "string" ? arch.modality : undefined;
  if (modality?.includes("->")) {
    const [inSide = "", outSide = ""] = modality.toLowerCase().split("->", 2);
    const inTokens = inSide.split(/[+,\s/]+/).filter((token) => token !== "");
    const outTokens = outSide.split(/[+,\s/]+/).filter((token) => token !== "");
    if (inTokens.length > 0 && !inTokens.includes("text")) return false;
    if (outTokens.length > 0 && !outTokens.every((token) => token === "text")) return false;
  }

  for (const field of [rec.type, rec.model_type, rec.task, rec.pipeline_tag]) {
    if (typeof field === "string") {
      const normalized = field.trim().toLowerCase();
      if (NON_CHAT_TYPES.has(normalized)) return false;
    }
  }

  const pricing =
    typeof rec.pricing === "object" && rec.pricing !== null ? (rec.pricing as Record<string, unknown>) : undefined;
  if (pricing !== undefined) {
    const prompt = rawRate(pricing.prompt);
    const completion = rawRate(pricing.completion);
    if ((prompt !== undefined && prompt < 0) || (completion !== undefined && completion < 0)) return false;
  }

  return true;
}

function isNonChatIdentifier(text: string): boolean {
  const lower = text.toLowerCase().replaceAll("_", "-");
  for (const phrase of NON_CHAT_PHRASES) {
    if (lower.includes(phrase)) return true;
  }
  for (const token of lower.split(/[\s:/.()-]+/)) {
    if (token !== "" && NON_CHAT_TOKENS.has(token)) return true;
  }
  return false;
}

export function modelNameOf(row: object, id: string): string | undefined {
  const raw = (row as { name?: unknown }).name;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed !== "" && trimmed !== id ? trimmed : undefined;
}

export function modelPricingOf(row: object): ModelPricing | undefined {
  const raw = (row as { pricing?: unknown }).pricing;
  if (typeof raw !== "object" || raw === null) return undefined;
  const pricing = raw as Record<string, unknown>;
  const prompt = perMillionRate(pricing.prompt);
  const completion = perMillionRate(pricing.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  const cacheRead = perMillionRate(pricing.input_cache_read);
  return {
    prompt,
    completion,
    ...(cacheRead !== undefined && cacheRead > 0 ? { cacheRead } : {}),
  };
}

function perMillionRate(value: unknown): number | undefined {
  const n = rawRate(value);
  if (n === undefined || n < 0) return undefined;
  return Number((n * 1_000_000).toPrecision(12));
}

function rawRate(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function modalitiesOf(value: unknown): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === "string" && item.trim() !== "")
  ) {
    return undefined;
  }
  return value.map((item) => item.trim().toLowerCase());
}
