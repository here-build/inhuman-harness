/**
 * Prompt-cache routing for openai-compat completions.
 *
 * Caching itself is automatic prefix match (exact head of tools + messages).
 * These fields only pin the request to a replica that still holds that KV.
 * They are completion-only — handshake `/models` does not send them.
 *
 * Local / unknown hosts get an empty bag: extra keys 400 on LM Studio / Ollama.
 *
 * GROK.
 * "The xAI API performs prompt caching automatically. However, we recommend
 * setting the `x-grok-conv-id` HTTP header to maximize your cache hit rate."
 * https://docs.x.ai/developers/advanced-api-usage/prompt-caching
 * Chat Completions: header `x-grok-conv-id` ("routes requests with the same
 * conversation ID to the same server. Since cache entries are stored
 * per-server, this maximizes your cache hit rate.").
 * https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
 * Body `prompt_cache_key` is plumbed to the same affinity (OpenAPI ChatRequest).
 * grok-shell against cli-chat-proxy also stamps `x-grok-session-id` to the
 * same session id (sticky pair) and `x-grok-req-id` per invocation — unique
 * ids belong there, not on conv-id. `x-grok-turn-idx` is 1-based user-turn
 * depth (SessionTurn chain), stable across ReACT rounds of one prompt.
 * Remainder classifier PEWs must not reuse the live-tape id: they send a
 * different prefix (`Reply in prose`, no tools) and evict the tape KV.
 *
 * CHATGPT / CODEX SUBSCRIPTION.
 * Replica stickiness is the `session-id` / `thread-id` headers (Codex
 * `build_session_headers`). Body `prompt_cache_key` is still sent; the
 * backend rewrites it per response and does not route on it. The
 * subscription 400s `store: true` and `prompt_cache_options`.
 * Model names do not establish endpoint capabilities.
 *
 * OPENAI PUBLIC API.
 * "Set `prompt_cache_key` on requests that share long, common prompt prefixes."
 * "Replaces the `user` field." No cache HTTP headers — body only.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * GPT-5.6+: `prompt_cache_options.ttl` `"30m"` (default); `mode` `implicit`
 * places a breakpoint on the latest eligible message. Earlier models:
 * `prompt_cache_retention` `"24h"` when the org is not ZDR. Sending
 * `prompt_cache_options` to pre-5.6 (Azure) is a 400.
 *
 * OPENROUTER.
 * Sticky provider routing: header `x-session-id` or body `session_id`
 * (≤256 chars); falls back to `prompt_cache_key`.
 * https://openrouter.ai/docs/guides/best-practices/prompt-caching
 */

export type CacheFlavor = "grok" | "openai" | "chatgpt" | "openrouter" | "none";
export type CacheAffinity = {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
};

/** Per-attempt grok-shell routing. Omit on handshake. */
export type CacheAffinityRequest = {
  readonly requestId?: string;
  readonly turnIndex?: number;
};

const EMPTY: CacheAffinity = { headers: {}, body: {} };

/** GPT-5.6 / GPT-6+ take `prompt_cache_options`; earlier 5.x 400s on Azure. */
export function usesExplicitPromptCache(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (/gpt-5\.(?:[6-9]|\d{2,})/.test(id)) return true;
  const major = /(?:^|[^a-z0-9])gpt-(\d+)/.exec(id);
  return major != null && Number(major[1]) >= 6;
}

export function cacheFlavorFromBaseUrl(baseUrl: string): CacheFlavor {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "none";
  }
  if (
    host === "api.x.ai" ||
    host.endsWith(".x.ai") ||
    host === "cli-chat-proxy.grok.com" ||
    host.endsWith(".grok.com")
  ) {
    return "grok";
  }
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    return "openai";
  }
  if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return "chatgpt";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  return "none";
}

export function grokCacheAffinity(sessionId: string, request?: CacheAffinityRequest): CacheAffinity {
  const id = sessionId.trim();
  if (id === "") return EMPTY;
  const headers: Record<string, string> = {
    "x-grok-conv-id": id,
    "x-grok-session-id": id,
  };
  const requestId = request?.requestId?.trim() ?? "";
  if (requestId !== "") headers["x-grok-req-id"] = requestId;
  const turnIndex = request?.turnIndex;
  if (turnIndex != null && Number.isFinite(turnIndex) && turnIndex >= 1) {
    headers["x-grok-turn-idx"] = String(Math.floor(turnIndex));
  }
  return {
    headers,
    body: {
      prompt_cache_key: id,
    },
  };
}

export function chatgptCacheAffinity(sessionId: string): CacheAffinity {
  // Codex rejects prompt_cache_key values longer than 64 Unicode code points.
  const id = [...sessionId.trim()].slice(0, 64).join("");
  return id === ""
    ? EMPTY
    : {
        headers: { "session-id": id, "thread-id": id },
        body: { prompt_cache_key: id },
      };
}

export function openaiCacheAffinity(sessionId: string, model: string): CacheAffinity {
  const id = sessionId.trim();
  if (id === "") return EMPTY;
  return {
    headers: {},
    body: usesExplicitPromptCache(model)
      ? {
          prompt_cache_key: id,
          prompt_cache_options: { mode: "implicit", ttl: "30m" },
        }
      : {
          prompt_cache_key: id,
          prompt_cache_retention: "24h",
        },
  };
}

export function openrouterCacheAffinity(sessionId: string): CacheAffinity {
  const id = sessionId.trim().slice(0, 256);
  if (id === "") return EMPTY;
  return {
    headers: {
      "x-session-id": id,
    },
    body: {
      prompt_cache_key: id,
      session_id: id,
    },
  };
}

export function cacheAffinityFor(
  flavor: CacheFlavor,
  sessionId: string,
  model: string,
  request?: CacheAffinityRequest,
): CacheAffinity {
  switch (flavor) {
    case "grok":
      return grokCacheAffinity(sessionId, request);
    case "openai":
      return openaiCacheAffinity(sessionId, model);
    case "chatgpt":
      return chatgptCacheAffinity(sessionId);
    case "openrouter":
      return openrouterCacheAffinity(sessionId);
    case "none":
      return EMPTY;
  }
}

/**
 * Probe whether an unknown remote host actually does prompt caching.
 *
 * Accepting `prompt_cache_key` is not evidence: Atria returns 200 and ignores
 * it. The only honest test is a repeat call with an identical prefix — a real
 * cache reports `cached_tokens > 0` on the second call. Affinity keys are
 * deliberately absent: this tests caching, not replica routing.
 *
 * Loopback is not privileged: an SSH tunnel or litellm proxy on 127.0.0.1
 * forwards to a remote that does cache, and a real local Ollama reports
 * cached_tokens: 0 — the probe answers both correctly. The probe sends no
 * affinity keys, so the "extra keys 400 on LM Studio" risk does not apply.
 *
 * A miss is not cached forever — re-probe on demand. A provider can turn
 * caching on server-side; the failure mode of a stale "none" is a false
 * "cache hit · unexpected" tape mark, not a broken turn.
 */
export async function probeCachePolicy(args: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly model: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}): Promise<CacheFlavor> {
  if (args.model.trim() === "") return "none";

  const prefix = "Probe prefix for prompt cache detection. ".repeat(24);
  const once = async (suffix: string): Promise<number | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 20_000);
    try {
      const response = await args.fetch(args.url, {
        method: "POST",
        headers: { ...args.headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: args.model,
          messages: [{ role: "user", content: prefix + suffix }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: ctrl.signal,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { usage?: unknown };
      return cachedTokensOf(data.usage);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  // First call warms the prefix; the second carries a fresh suffix that still
  // shares the head, so a live cache reports cached_tokens on it.
  await once("warm");
  const second = await once("repeat");
  if (second === null) return "none";
  return second > 0 ? "openai" : "none";
}

/** `usage.prompt_tokens_details.cached_tokens` (Chat) or `input_tokens_details` (Responses). */
function cachedTokensOf(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const rec = usage as {
    prompt_tokens_details?: { cached_tokens?: unknown };
    input_tokens_details?: { cached_tokens?: unknown };
    cached_tokens?: unknown;
  };
  const raw = rec.prompt_tokens_details?.cached_tokens ?? rec.input_tokens_details?.cached_tokens ?? rec.cached_tokens;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}
