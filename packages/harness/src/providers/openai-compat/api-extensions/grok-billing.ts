/**
 * Grok Build / SuperGrok subscription windows.
 *
 * GET `{cli-chat-proxy}/v1/billing?format=credits` — the same path grok-build
 * `/usage` reads. `creditUsagePercent` is used, not remaining — remaining is
 * `100 - used`, same as ChatGPT `used_percent`. Older accounts still report
 * a monthly period. No 5h window.
 * https://cli-chat-proxy.grok.com/v1/billing?format=credits
 */
import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import {
  snapshotIdentity,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type IdentityParts,
  type UsageWindow,
} from "./types.js";

export const GROK_BILLING_PATH = "/billing?format=credits";
const SUBSCRIPTION: IdentityParts = { kind: "subscription" };

const periodSchema = z
  .object({
    type: z.string().nullable().optional(),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
  })
  .passthrough();

const productSchema = z
  .object({
    product: z.string().nullable().optional(),
    usagePercent: z.union([z.number(), z.string()]).nullable().optional(),
    usage_percent: z.union([z.number(), z.string()]).nullable().optional(),
  })
  .passthrough();

const configSchema = z
  .object({
    creditUsagePercent: z.union([z.number(), z.string()]).nullable().optional(),
    credit_usage_percent: z.union([z.number(), z.string()]).nullable().optional(),
    currentPeriod: periodSchema.nullable().optional(),
    current_period: periodSchema.nullable().optional(),
    billingPeriodStart: z.string().nullable().optional(),
    billing_period_start: z.string().nullable().optional(),
    billingPeriodEnd: z.string().nullable().optional(),
    billing_period_end: z.string().nullable().optional(),
    productUsage: z.array(productSchema).nullable().optional(),
    product_usage: z.array(productSchema).nullable().optional(),
    isUnifiedBillingUser: z.boolean().nullable().optional(),
    is_unified_billing_user: z.boolean().nullable().optional(),
  })
  .passthrough();

const wireSchema = z
  .object({
    config: configSchema.nullable().optional(),
    creditUsagePercent: z.union([z.number(), z.string()]).nullable().optional(),
    credit_usage_percent: z.union([z.number(), z.string()]).nullable().optional(),
    currentPeriod: periodSchema.nullable().optional(),
    current_period: periodSchema.nullable().optional(),
    billingPeriodStart: z.string().nullable().optional(),
    billing_period_start: z.string().nullable().optional(),
    billingPeriodEnd: z.string().nullable().optional(),
    billing_period_end: z.string().nullable().optional(),
    productUsage: z.array(productSchema).nullable().optional(),
    product_usage: z.array(productSchema).nullable().optional(),
    isUnifiedBillingUser: z.boolean().nullable().optional(),
    is_unified_billing_user: z.boolean().nullable().optional(),
  })
  .passthrough();

export function accountFromGrokBilling(raw: unknown, identity: IdentityParts = SUBSCRIPTION): AccountSnapshot {
  const body = parseWire(wireSchema, raw, "grok", GROK_BILLING_PATH);
  const cfg = body.config ?? body;
  const period = cfg.currentPeriod ?? cfg.current_period ?? undefined;
  const usedPercent = numberOf(cfg.creditUsagePercent ?? cfg.credit_usage_percent);
  const end = period?.end ?? cfg.billingPeriodEnd ?? cfg.billing_period_end ?? undefined;
  const start = period?.start ?? cfg.billingPeriodStart ?? cfg.billing_period_start ?? undefined;
  const products = cfg.productUsage ?? cfg.product_usage ?? undefined;
  const windows: UsageWindow[] = [];
  if (usedPercent !== undefined) {
    windows.push(windowOf(periodLabel(period?.type ?? undefined), remainingOfUsed(usedPercent), end));
  } else if (products != null && products.length > 0) {
    for (const row of products) {
      // Protobuf3 omits scalar 0 fields (`usagePercent: 0`) when 0% has been consumed.
      const rowUsed = numberOf(row.usagePercent ?? row.usage_percent) ?? 0;
      const label = productLabel(row.product ?? undefined);
      if (windows.some((window) => window.label === label)) continue;
      windows.push(windowOf(label, remainingOfUsed(rowUsed), end));
    }
  } else if (
    body.config != null ||
    period != null ||
    end != null ||
    start != null ||
    cfg.isUnifiedBillingUser != null ||
    cfg.is_unified_billing_user != null
  ) {
    // Protobuf3 omits `creditUsagePercent: 0` when 0% of the period's quota has been used.
    windows.push(windowOf(periodLabel(period?.type ?? undefined), 100, end));
  }
  return withFunds(snapshotIdentity({ ...identity, kind: "subscription" }), undefined, {
    ...(windows.length > 0 ? { windows } : {}),
  });
}

export async function getGrokAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, GROK_BILLING_PATH), "grok", GROK_BILLING_PATH);
  return accountFromGrokBilling(json, { kind: "subscription" });
}

function remainingOfUsed(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

function periodLabel(type = ""): string {
  const raw = type.replace(/^USAGE_PERIOD_TYPE_/i, "").toLowerCase();
  if (raw.includes("week")) return "weekly";
  if (raw.includes("month")) return "monthly";
  if (raw.includes("day")) return "daily";
  return raw === "" ? "weekly" : raw;
}

function productLabel(product = ""): string {
  const raw = product.trim();
  if (raw === "") return "weekly";
  if (/grok.?build/i.test(raw) || raw.toLowerCase() === "grokbuild") return "weekly";
  return raw;
}

function windowOf(label: string, remainingPercent: number, end: string | undefined): UsageWindow {
  const nowSec = Date.now() / 1000;
  const parsedResetAt = resetAtOf(end);
  const resetAt = parsedResetAt !== undefined && parsedResetAt > nowSec ? parsedResetAt : undefined;
  const resetInSec = resetAt === undefined ? undefined : Math.max(0, Math.trunc(resetAt - nowSec));
  const exhausted = remainingPercent <= 0;
  return {
    label,
    remainingPercent,
    ...(resetInSec === undefined ? {} : { resetInSec }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(exhausted ? { status: "exhausted" as const } : { status: "ok" as const }),
  };
}

function resetAtOf(end: string | undefined): number | undefined {
  if (end === undefined || end.trim() === "") return undefined;
  const at = Date.parse(end);
  if (!Number.isFinite(at)) return undefined;
  return Math.trunc(at / 1000);
}

function numberOf(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
