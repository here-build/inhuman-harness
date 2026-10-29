/**
 * Explicit prompt-cache breakpoints (`cache_control`) for Anthropic models.
 *
 * Anthropic caches only at explicit breakpoints (up to 4; 20-block lookback;
 * order tools, system, messages). OpenAI-family models cache the exact prefix
 * automatically and need nothing here.
 *
 * Which routes take `cache_control` on a Chat Completions body:
 * - OpenRouter, model `anthropic/*`: yes (content-part `cache_control`, passed
 *   through to Anthropic).
 * - Any other gateway that forwards it to Anthropic (LiteLLM, a Bedrock/Vertex
 *   proxy): opt in per connection with `cacheControl: "on"`.
 * - api.anthropic.com's own OpenAI-compatibility endpoint: it ignores
 *   `cache_control` (documented as unsupported there), so `auto` does not
 *   emit. A native Messages driver is the way to cache there.
 *
 * Breakpoints, in order, de-duplicated:
 *   1. the last leading system message (closes tools + system);
 *   2. the last compaction card, when one is on the wire (the retention clock
 *      position, once that exists, takes this slot);
 *   3. the previous request's end: the message before the last assistant
 *      message, i.e. where the previous request's own final breakpoint wrote;
 *   4. the current end of the request.
 */
import type { ChatMessage } from "./actor.js";

export type CacheControlMode = "auto" | "on" | "off";
export type CacheControlTtl = "5m" | "1h";

export type CacheControlSettings = {
  readonly cacheControl?: CacheControlMode;
  readonly cacheControlTtl?: CacheControlTtl;
};

/** Whether this connection/model gets `cache_control` breakpoints. */
export function emitsCacheControl(
  settings: CacheControlSettings,
  flavor: string,
  model: string,
): boolean {
  const mode = settings.cacheControl ?? "auto";
  if (mode === "off") return false;
  if (mode === "on") return true;
  return flavor === "openrouter" && /(^|\/)anthropic\//i.test(model.trim());
}

type Part = { readonly type: string; readonly text?: string; readonly cache_control?: unknown };

function carries(message: ChatMessage): boolean {
  if (typeof message.content === "string") return message.content !== "";
  if (Array.isArray(message.content)) {
    const parts = message.content as readonly Part[];
    return parts.length > 0 && parts.at(-1)?.type === "text";
  }
  return false;
}

function withMarker(message: ChatMessage, control: Record<string, unknown>): ChatMessage {
  const parts: Part[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [...((message.content ?? []) as readonly Part[])];
  const last = parts.length - 1;
  parts[last] = { ...parts[last]!, cache_control: control };
  return { ...message, content: parts as ChatMessage["content"] };
}

/** Nearest index at or before `from` whose message can hold a marker. */
function carrierAtOrBefore(messages: readonly ChatMessage[], from: number): number {
  for (let i = from; i >= 0; i -= 1) if (carries(messages[i]!)) return i;
  return -1;
}

export function breakpointIndices(messages: readonly ChatMessage[], cardText: string): number[] {
  if (messages.length === 0) return [];
  const picks: number[] = [];
  // 1. end of system (+ tools, which Anthropic orders before system).
  let headEnd = -1;
  while (headEnd + 1 < messages.length && messages[headEnd + 1]!.role === "system") headEnd += 1;
  if (headEnd >= 0) picks.push(carrierAtOrBefore(messages, headEnd));
  // 2. the last compaction card.
  const card = cardText.trim();
  if (card !== "") {
    const at = messages.findLastIndex(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.trim() === card,
    );
    if (at >= 0) picks.push(at);
  }
  // 3. the previous request's end.
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant > 0) picks.push(carrierAtOrBefore(messages, lastAssistant - 1));
  // 4. the current end.
  picks.push(carrierAtOrBefore(messages, messages.length - 1));
  return [...new Set(picks.filter((i) => i >= 0))].slice(-4);
}

/**
 * Returns `messages` with `cache_control` on up to four content parts. Pure:
 * the input is not mutated, and the same input gives the same bytes.
 */
export function withCacheBreakpoints(
  messages: readonly ChatMessage[],
  cardText: string,
  ttl: CacheControlTtl = "5m",
): ChatMessage[] {
  const indices = breakpointIndices(messages, cardText);
  const out = [...messages];
  for (const [slot, index] of indices.entries()) {
    // The long TTL goes on the stable head only (system, card); the moving
    // breakpoints stay at the default 5 minutes.
    const stable = slot < indices.length - 2 && ttl === "1h";
    const control = stable ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    out[index] = withMarker(out[index]!, control);
  }
  return out;
}
