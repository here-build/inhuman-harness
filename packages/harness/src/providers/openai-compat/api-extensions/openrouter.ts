import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import {
  money,
  snapshotIdentity,
  usd,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type BalanceDetail,
} from "./types.js";

const KEY_PATH = "/key";
const CREDITS_PATH = "/credits";

const wireSchema = z.object(
  {
    data: z.object(
      {
        label: z.string({ error: "label must be a string" }),
        limit: z.number({ error: "limit must be a number" }).nullable(),
        limit_reset: z.string({ error: "limit_reset must be a string" }).nullable(),
        limit_remaining: z.number({ error: "limit_remaining must be a number" }).nullable(),
        include_byok_in_limit: z.boolean({
          error: "include_byok_in_limit must be a boolean",
        }),
        usage: z.number({ error: "usage must be a number" }),
        usage_daily: z.number({ error: "usage_daily must be a number" }),
        usage_weekly: z.number({ error: "usage_weekly must be a number" }),
        usage_monthly: z.number({ error: "usage_monthly must be a number" }),
        byok_usage: z.number({ error: "byok_usage must be a number" }),
        byok_usage_daily: z.number({
          error: "byok_usage_daily must be a number",
        }),
        byok_usage_weekly: z.number({
          error: "byok_usage_weekly must be a number",
        }),
        byok_usage_monthly: z.number({
          error: "byok_usage_monthly must be a number",
        }),
        is_free_tier: z.boolean({ error: "is_free_tier must be a boolean" }),
      },
      { error: "data must be an object" },
    ),
  },
  { error: "key response must be an object" },
);

const creditsSchema = z.object(
  {
    data: z.object(
      {
        total_credits: z.number({ error: "total_credits must be a number" }),
        total_usage: z.number({ error: "total_usage must be a number" }),
      },
      { error: "data must be an object" },
    ),
  },
  { error: "credits response must be an object" },
);

export async function getOpenRouterAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, KEY_PATH), "openrouter", KEY_PATH);
  const body = parseWire(wireSchema, json, "openrouter", KEY_PATH);
  const { data } = body;
  const label = data.label.trim();
  const identity = snapshotIdentity({
    kind: "key",
    ...(label === "" ? {} : { handle: label, displayName: label, keyLabel: label }),
    apiKey: req.apiKey,
  });
  const used = money(data.usage, usd());
  const limit = data.limit === null ? null : money(data.limit, usd());
  const credits = await readCredits(req);
  const remaining = credits === undefined ? data.limit_remaining : credits.total_credits - credits.total_usage;
  const detail: BalanceDetail = {
    used: credits === undefined ? used : money(credits.total_usage, usd()),
    limit,
    ...(credits === undefined ? {} : { purchased: money(credits.total_credits, usd()) }),
    ...(remaining === null ? { unlimited: true } : {}),
  };
  if (remaining === null) return withFunds(identity, undefined, detail);
  return withFunds(identity, money(remaining, usd()), detail);
}

async function readCredits(req: AccountRequest): Promise<{ total_credits: number; total_usage: number } | undefined> {
  try {
    const json = await getJson(req, joinUrl(req.baseUrl, CREDITS_PATH), "openrouter", CREDITS_PATH);
    return parseWire(creditsSchema, json, "openrouter", CREDITS_PATH).data;
  } catch {
    return undefined;
  }
}
