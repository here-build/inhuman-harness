/**
 * ChatGPT / Codex subscription windows.
 *
 * GET `{origin}/backend-api/wham/usage` — the same path Codex CLI `/status` reads.
 * primary/secondary are not fixed roles: when the 5h cap is lifted, weekly sits
 * on primary. Classify by `limit_window_seconds` (≥2d → weekly, else 5h).
 * https://chatgpt.com/backend-api/wham/usage
 */
import { z } from "zod";

import { getJson, parseWire } from "./http.js";
import {
  money,
  snapshotIdentity,
  usd,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type IdentityParts,
  type UsageWindow,
} from "./types.js";

export const CHATGPT_USAGE_PATH = "/backend-api/wham/usage";
const WEEKLY_MIN_SEC = 2 * 24 * 60 * 60;
const SUBSCRIPTION: IdentityParts = { kind: "subscription" };

const windowSchema = z
  .object({
    used_percent: z.number().optional(),
    usedPercent: z.number().optional(),
    limit_window_seconds: z.number().optional(),
    limitWindowSeconds: z.number().optional(),
    reset_after_seconds: z.number().optional(),
    resetAfterSeconds: z.number().optional(),
    reset_at: z.number().optional(),
    resetAt: z.number().optional(),
  })
  .passthrough();

const rateLimitSchema = z
  .object({
    allowed: z.boolean().optional(),
    limit_reached: z.boolean().optional(),
    limitReached: z.boolean().optional(),
    primary_window: windowSchema.nullable().optional(),
    primaryWindow: windowSchema.nullable().optional(),
    secondary_window: windowSchema.nullable().optional(),
    secondaryWindow: windowSchema.nullable().optional(),
  })
  .passthrough();

const creditsSchema = z
  .object({
    has_credits: z.boolean().optional(),
    hasCredits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    balance: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

const wireSchema = z
  .object({
    plan_type: z.string().optional(),
    planType: z.string().optional(),
    rate_limit: rateLimitSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
    credits: creditsSchema.optional(),
  })
  .passthrough();

export function chatgptUsageUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = CHATGPT_USAGE_PATH;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function accountFromChatGptUsage(raw: unknown, identity: IdentityParts = SUBSCRIPTION): AccountSnapshot {
  const body = parseWire(wireSchema, raw, "chatgpt", CHATGPT_USAGE_PATH);
  const rate = body.rate_limit ?? body.rateLimit;
  const credits = body.credits;
  const plan = body.plan_type ?? body.planType ?? identity.plan;
  const windows = windowsOf(rate);
  const hasCredits = credits?.has_credits ?? credits?.hasCredits;
  const unlimited = credits?.unlimited === true;
  const balance = credits?.balance;
  const remaining =
    hasCredits === true && unlimited !== true && balance != null && balance !== "" ? money(balance, usd()) : undefined;
  return withFunds(
    snapshotIdentity({
      ...identity,
      kind: "subscription",
      ...(plan === undefined ? {} : { plan }),
    }),
    remaining,
    {
      ...(unlimited ? { unlimited: true } : {}),
      ...(windows.length > 0 ? { windows } : {}),
    },
  );
}

export async function getChatGptAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, chatgptUsageUrl(req.baseUrl), "chatgpt", CHATGPT_USAGE_PATH);
  return accountFromChatGptUsage(json, { kind: "subscription" });
}

function windowsOf(rate: z.output<typeof rateLimitSchema> | undefined): UsageWindow[] {
  if (rate === undefined) return [];
  const rows = [rate.primary_window ?? rate.primaryWindow, rate.secondary_window ?? rate.secondaryWindow];
  const out: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row == null) continue;
    const window = windowOf(row);
    if (window === undefined || seen.has(window.label)) continue;
    seen.add(window.label);
    out.push(window);
  }
  return out;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

function windowOf(raw: z.output<typeof windowSchema>): UsageWindow | undefined {
  const usedPercent = raw.used_percent ?? raw.usedPercent;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return undefined;
  const remainingPercent = clampPercent(100 - usedPercent);
  const seconds = raw.limit_window_seconds ?? raw.limitWindowSeconds;
  const label = seconds != null && seconds >= WEEKLY_MIN_SEC ? "weekly" : "5h";
  const resetAfter = raw.reset_after_seconds ?? raw.resetAfterSeconds;
  const resetAtRaw = raw.reset_at ?? raw.resetAt;
  const nowSec = Date.now() / 1000;
  const resetAt =
    resetAtRaw != null && Number.isFinite(resetAtRaw)
      ? Math.trunc(resetAtRaw)
      : resetAfter != null && Number.isFinite(resetAfter)
        ? Math.trunc(nowSec + Math.max(0, resetAfter))
        : undefined;
  const resetInSec =
    resetAfter != null && Number.isFinite(resetAfter)
      ? Math.max(0, Math.trunc(resetAfter))
      : resetAt === undefined
        ? undefined
        : Math.max(0, Math.trunc(resetAt - nowSec));
  const exhausted = remainingPercent <= 0;
  return {
    label,
    remainingPercent,
    ...(resetInSec === undefined ? {} : { resetInSec }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(exhausted ? { status: "exhausted" as const } : { status: "ok" as const }),
  };
}
