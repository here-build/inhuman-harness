import { describe, expect, it } from "vitest";

import { usageLedger } from "../model-catalog.js";

const empty = {
  totalTokens: null,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costUsd: null,
} as const;

describe("usageLedger", () => {
  it.each([
    {
      name: "chat occupancy + cache read",
      raw: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      },
      want: {
        totalTokens: 14,
        inputTokens: 10,
        outputTokens: 4,
        cachedTokens: 8,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
      },
    },
    {
      name: "responses cache read",
      raw: {
        usage: {
          input_tokens: 64,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 32 },
        },
      },
      want: {
        totalTokens: 72,
        inputTokens: 64,
        outputTokens: 8,
        cachedTokens: 32,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
      },
    },
    {
      name: "Anthropic cache write + read",
      raw: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 50,
        },
      },
      want: {
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 50,
        cacheWriteTokens: 40,
        reasoningTokens: null,
        costUsd: null,
      },
    },
    {
      name: "reasoning is a subset of output",
      raw: {
        usage: {
          prompt_tokens: 12,
          completion_tokens: 80,
          completion_tokens_details: { reasoning_tokens: 60 },
        },
      },
      want: {
        totalTokens: 92,
        inputTokens: 12,
        outputTokens: 80,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: 60,
        costUsd: null,
      },
    },
    {
      name: "OpenRouter billed USD",
      raw: { usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0014 } },
      want: {
        totalTokens: 7,
        inputTokens: 5,
        outputTokens: 2,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0.0014,
      },
    },
    {
      name: "LiteLLM response_cost on usage",
      raw: {
        usage: { prompt_tokens: 1, completion_tokens: 1, response_cost: 0.02 },
      },
      want: {
        totalTokens: 2,
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0.02,
      },
    },
    {
      name: "LiteLLM hidden response_cost",
      raw: { _hidden_params: { response_cost: 0.05 } },
      want: {
        totalTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0.05,
      },
    },
    {
      name: "xAI ticks → USD",
      raw: {
        usage: {
          prompt_tokens: 151,
          completion_tokens: 4,
          cost_in_usd_ticks: 37_756_000,
        },
      },
      want: {
        totalTokens: 155,
        inputTokens: 151,
        outputTokens: 4,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0.0037756,
      },
    },
    {
      name: "USD wins over ticks when both present",
      raw: { usage: { cost: 0.01, cost_in_usd_ticks: 37_756_000 } },
      want: {
        totalTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0.01,
      },
    },
    {
      name: "cache miss 0 is reported, not omitted",
      raw: { usage: { prompt_tokens_details: { cached_tokens: 0 } } },
      want: {
        totalTokens: null,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
      },
    },
    {
      name: "free round is 0, not omitted",
      raw: { usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0 } },
      want: {
        totalTokens: 4,
        inputTokens: 3,
        outputTokens: 1,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: 0,
      },
    },
    {
      name: "absent usage is the empty ledger",
      raw: {},
      want: empty,
    },
    {
      name: "empty usage bag is the empty ledger",
      raw: { usage: {} },
      want: empty,
    },
    {
      name: "cached omitted when only total is present",
      raw: { usage: { total_tokens: 10 } },
      want: {
        totalTokens: 10,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
      },
    },
  ] as const)("$name", ({ raw, want }) => {
    expect(usageLedger(raw)).toEqual(want);
  });
});
