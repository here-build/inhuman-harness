import { CompletionJob, isReasoningEffort, SessionTurn, type ReasoningEffort } from "@inhuman.tools/harness-model";
import {
  openrouterProvider,
  type ModelChoiceItem,
  type ModelPricingHint,
  type ModelWireItem,
  wireAccount,
  type AccountSource,
} from "@inhuman.tools/harness-ui";

export {
  formatModelPricing,
  modelBadges,
  modelChoiceValue,
  naturalName,
  openrouterProvider,
  type ModelChoiceItem as ModelChoice,
  type ModelPricingHint as ModelPricing,
  type OpenRouterProviderInfo as OpenRouterProvider,
} from "@inhuman.tools/harness-ui";

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
export type ModelWire = Omit<ModelWireItem, "modelCapabilities"> & {
  readonly modelCapabilities?: Readonly<Record<string, ModelCapabilityHint>>;
};

const SMALL_CATALOG = 20;

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

/**
 * The model the control names. The session kv wins. When it is empty, the
 * last turn that actually ran a model is what the tape is already showing.
 */
export function sessionModel(
  root: { readonly kvs?: Readonly<Record<string, string>> | null; readonly head?: unknown } | null | undefined,
): ModelChoiceItem {
  const kv = root?.kvs;
  const model = (kv?.model ?? "").trim();
  const connection = (kv?.connection ?? "").trim();
  if (model !== "") return { connection, model };
  return lastTurnModel(root?.head) ?? { connection: "", model: "" };
}

function lastTurnModel(head: unknown): ModelChoiceItem | null {
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

function parseModelPricing(raw: unknown): Readonly<Record<string, ModelPricingHint>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, ModelPricingHint> = {};
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
