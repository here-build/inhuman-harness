/**
 * Usage reads from a completion payload or SSE chunk. Consumed tokens and
 * billed `$` stamp onto the CompletionExpectation. The ledger is always the
 * same seven fields; a missing quantity is null, never fabricated 0.
 * Cache-read is included in input; reasoning is a subset of output. `costUsd`
 * is provider-billed (LiteLLM / OpenRouter USD, xAI ticks÷10^10), not list-price.
 */
import { z } from "zod";

export type UsageLedger = {
  /** Native tokenizer count for this round, or null if the payload has no usage. */
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /**
   * Prefix-cache hit size. Chat: `usage.prompt_tokens_details.cached_tokens`.
   * Responses: `usage.input_tokens_details.cached_tokens`. 0 is a miss, not absent.
   */
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly costUsd: number | null;
};

/** xAI: 1 USD = 10^10 ticks. */
const USD_TICKS = 10_000_000_000;

const token = z
  .preprocess(
    (value) => (value == null ? undefined : value),
    z.coerce
      .number()
      .finite()
      .nonnegative()
      .transform((n) => Math.trunc(n))
      .optional(),
  )
  .catch(undefined);

const usd = z
  .preprocess((value) => (value == null ? undefined : value), z.coerce.number().finite().nonnegative().optional())
  .catch(undefined);

const details = z
  .looseObject({
    cached_tokens: token,
    cache_creation_tokens: token,
    cache_write_tokens: token,
    reasoning_tokens: token,
    thinking_tokens: token,
  })
  .optional()
  .catch(undefined);

const usageSchema = z.looseObject({
  prompt_tokens: token,
  input_tokens: token,
  completion_tokens: token,
  output_tokens: token,
  total_tokens: token,
  cached_tokens: token,
  cache_read_input_tokens: token,
  cache_creation_input_tokens: token,
  cache_write_input_tokens: token,
  reasoning_tokens: token,
  thinking_tokens: token,
  prompt_tokens_details: details,
  input_tokens_details: details,
  completion_tokens_details: details,
  output_tokens_details: details,
  response_cost: usd,
  cost_usd: usd,
  total_cost: usd,
  cost: usd,
  cost_in_usd_ticks: token,
});

const envelopeSchema = z.looseObject({
  usage: usageSchema.optional().catch(undefined),
  response: z
    .looseObject({ usage: usageSchema.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  _hidden_params: z.looseObject({ response_cost: usd }).optional().catch(undefined),
});

export function usageLedger(raw: unknown): UsageLedger {
  const parsed = envelopeSchema.safeParse(raw);
  const data = parsed.success ? parsed.data : {};
  const usage = data.usage ?? data.response?.usage ?? {};
  const input = usage.prompt_tokens ?? usage.input_tokens ?? null;
  const output = usage.completion_tokens ?? usage.output_tokens ?? null;
  const outputDetails = usage.completion_tokens_details ?? usage.output_tokens_details;
  return {
    totalTokens: usage.total_tokens ?? (input != null && output != null ? input + output : (input ?? output)),
    inputTokens: input,
    outputTokens: output,
    cachedTokens:
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      null,
    cacheWriteTokens:
      usage.cache_creation_input_tokens ??
      usage.cache_write_input_tokens ??
      usage.prompt_tokens_details?.cache_creation_tokens ??
      usage.prompt_tokens_details?.cache_write_tokens ??
      usage.input_tokens_details?.cache_creation_tokens ??
      null,
    reasoningTokens:
      outputDetails?.reasoning_tokens ??
      outputDetails?.thinking_tokens ??
      usage.reasoning_tokens ??
      usage.thinking_tokens ??
      null,
    costUsd:
      usage.response_cost ??
      usage.cost_usd ??
      usage.total_cost ??
      usage.cost ??
      data._hidden_params?.response_cost ??
      (usage.cost_in_usd_ticks === undefined ? null : usage.cost_in_usd_ticks / USD_TICKS),
  };
}
