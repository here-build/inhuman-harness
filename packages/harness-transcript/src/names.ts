import type { KernelRoot, SessionActivity, SessionRoot } from "@inhuman.tools/harness-model";
import { classifierRoute, configuredCompletionModel } from "@inhuman.tools/harness-model/shared";
import type { SessionStatusBlockProps } from "@inhuman.tools/harness-ui/blocks/session-status-block";

/** Minimal connection fields needed to resolve a wire display name. */
export interface WireNameSource {
  readonly name?: string;
  readonly live?: object | null;
}

/** Stored picture payload returned by `turn/visual`. */
export interface StoredVisual {
  readonly id: string;
  readonly mime: string;
  readonly bytesBase64: string;
  readonly width: number;
  readonly height: number;
  readonly resizedFrom: { readonly width: number; readonly height: number } | null;
  readonly sourcePath: string | null;
}

const BADGE_TAGS = new Set(["free", "thinking", "extended", "beta", "preview", "nitro", "online", "floor", "exacto"]);

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

const ACTIVITY_LABELS: Readonly<Record<Exclude<SessionActivity["kind"], "stopped">, string>> = {
  idle: "Ready",
  stopping: "Stopping",
  approval: "Waiting for your approval",
  tools: "Using tools",
  agents: "Waiting for agents",
  compacting: "Compacting context",
  working: "Working",
  waiting: "Waiting for model",
  thinking: "Thinking",
  responding: "Responding",
  retrying: "Waiting to retry",
  checking: "Checking with judge",
};

/** Each project's shortest distinguishing trailing path segment across open workspaces. */
export function projectNames(paths: readonly string[]): Map<string, string> {
  const segments = new Map(paths.map((path) => [path, path.split(/[\\/]/).filter(Boolean)]));
  const tail = (of: readonly string[], n: number): string => of.slice(-n).join("/");
  const names = new Map<string, string>();
  for (const [path, parts] of segments) {
    let depth = 1;
    while (
      depth < parts.length &&
      [...segments].some(([other, otherParts]) => other !== path && tail(otherParts, depth) === tail(parts, depth))
    ) {
      depth += 1;
    }
    names.set(path, tail(parts, depth) || path);
  }
  return names;
}

/** Resolves a connection's operator-facing display name from its catalog metadata or id. */
export function wireName(spec: WireNameSource | null | undefined, connection: string): string {
  const catalogName = spec?.live != null && "catalogName" in spec.live ? spec.live.catalogName : undefined;
  const name = (typeof catalogName === "string" ? catalogName.trim() : "") || (spec?.name?.trim() ?? "");
  return name === "" ? connection : name;
}

/** Formats a raw model identifier or provider API name into a clean display label. */
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

/** Validates a `turn/visual` response payload and rejects remote HTTP URLs. */
export function readStoredVisual(result: unknown): StoredVisual | null {
  if (!isRecord(result)) return null;
  const id = textField(result, "id");
  const mime = textField(result, "mime");
  const bytesBase64 = textField(result, "bytesBase64");
  const width = countField(result, "width");
  const height = countField(result, "height");
  const resizedFrom = readResized(result);
  const sourcePath = readSource(result);
  if (id == null || mime == null || bytesBase64 == null || width == null || height == null) return null;
  if (resizedFrom === undefined || sourcePath === undefined) return null;
  if (id.trim() === "" || bytesBase64.trim() === "" || !usableMime(mime)) return null;
  if (remote(bytesBase64) || remote(mime)) return null;
  return { id, mime, bytesBase64, width, height, resizedFrom, sourcePath };
}

/** Returns an auto-approval diagnostic string when the configured classifier connection failed. */
export function autoModeProblem(session: SessionRoot | undefined, kernel: KernelRoot | undefined): string | null {
  if (kernel == null || session?.autoModeProblems == null || Object.keys(session.autoModeProblems).length === 0) {
    return null;
  }
  const wire = classifierRoute(session.kvs, {
    fallback: kernel.kvs,
    configuredModel: (id) => configuredCompletionModel(id, session.kvs, kernel.kvs, kernel.connections[id]),
  });
  const problem = session.autoModeProblems[wire.key];
  return problem
    ? `Automatic approvals are unavailable. Check the configured judge connection and model. ${problem}`
    : null;
}

/** Projects a session root's live activity and retry counters into {@link SessionStatusBlockProps}. */
export function projectSessionStatus(
  root: SessionRoot | null,
  kernel: KernelRoot | undefined,
): SessionStatusBlockProps | null {
  if (root == null) return null;
  const activity: SessionActivity = root.activity ?? { kind: "idle" };
  const problem = root.permissionMode === "auto" ? autoModeProblem(root, kernel) : null;
  const completion = "completion" in activity ? activity.completion : null;
  const failures = completion == null ? 0 : completion.foregroundFailures + completion.backgroundFailures;
  const count = completion?.retryForeground ? completion.foregroundFailures : (completion?.backgroundFailures ?? 0);
  const limit = completion?.retryForeground
    ? completion.retryMaxAttempts
    : (completion?.retryBackgroundMaxAttempts ?? 0);
  if (activity.kind === "idle" && problem == null) return null;
  const attemptsText =
    failures === 0
      ? undefined
      : `${count}${limit === 0 ? "" : ` / ${limit}`} unsuccessful ${completion?.retryForeground ? "foreground" : "background"} attempts`;
  return {
    label: activity.kind === "stopped" ? "Turn stopped" : ACTIVITY_LABELS[activity.kind],
    ...(attemptsText === undefined ? {} : { attemptsText }),
    ...(activity.kind === "stopped" ? { stopDetail: activity.detail } : {}),
    ...(completion?.lastAttemptError ? { lastAttemptError: completion.lastAttemptError } : {}),
    problemDetail: problem,
    isProblem: activity.kind === "stopped" || problem != null,
  };
}

function stripVendorPrefix(id: string): string {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return id;
  return id.slice(slash + 1);
}

function stripBadgesFromSlug(slug: string): string {
  const withoutColon = slug.split(":")[0];
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

function readResized(value: object): { width: number; height: number } | null | undefined {
  if (!Object.hasOwn(value, "resizedFrom")) return undefined;
  const found = own(value, "resizedFrom");
  if (found === null) return null;
  if (!isRecord(found)) return undefined;
  const width = countField(found, "width");
  const height = countField(found, "height");
  if (width == null || height == null) return undefined;
  return { width, height };
}

function readSource(value: object): string | null | undefined {
  if (!Object.hasOwn(value, "sourcePath")) return undefined;
  const found = own(value, "sourcePath");
  if (found === null) return null;
  return typeof found === "string" ? found : undefined;
}

function usableMime(mime: string): boolean {
  if (mime.trim() === "" || mime !== mime.trim()) return false;
  return !mime.includes(" ") && !mime.includes(";");
}

function remote(value: string): boolean {
  const head = value.trim().toLowerCase();
  return head.startsWith("http://") || head.startsWith("https://");
}

function textField(value: object, key: string): string | null {
  const found = own(value, key);
  return typeof found === "string" ? found : null;
}

function countField(value: object, key: string): number | null {
  const found = own(value, key);
  return typeof found === "number" && Number.isInteger(found) && found > 0 ? found : null;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor == null || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
