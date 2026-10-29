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
    type: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  })
  .passthrough();

const productSchema = z
  .object({
    product: z.string().optional(),
    usagePercent: z.number().optional(),
  })
  .passthrough();

const configSchema = z
  .object({
    creditUsagePercent: z.number().optional(),
    currentPeriod: periodSchema.optional(),
    billingPeriodStart: z.string().optional(),
    billingPeriodEnd: z.string().optional(),
    productUsage: z.array(productSchema).optional(),
  })
  .passthrough();

const wireSchema = z
  .object({
    config: configSchema.optional(),
    creditUsagePercent: z.number().optional(),
    currentPeriod: periodSchema.optional(),
    billingPeriodStart: z.string().optional(),
    billingPeriodEnd: z.string().optional(),
    productUsage: z.array(productSchema).optional(),
  })
  .passthrough();

export function accountFromGrokBilling(raw: unknown, identity: IdentityParts = SUBSCRIPTION): AccountSnapshot {
  const body = parseWire(wireSchema, raw, "grok", GROK_BILLING_PATH);
  const cfg = body.config ?? body;
  const period = cfg.currentPeriod;
  const usedPercent = cfg.creditUsagePercent;
  const end = period?.end ?? cfg.billingPeriodEnd;
  const windows: UsageWindow[] = [];
  if (usedPercent != null && Number.isFinite(usedPercent)) {
    windows.push(windowOf(periodLabel(period?.type), remainingOfUsed(usedPercent), end));
  } else {
    for (const row of cfg.productUsage ?? []) {
      if (row.usagePercent == null || !Number.isFinite(row.usagePercent)) continue;
      const label = productLabel(row.product);
      if (windows.some((window) => window.label === label)) continue;
      windows.push(windowOf(label, remainingOfUsed(row.usagePercent), end));
    }
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

function periodLabel(type: string | undefined): string {
  const raw = (type ?? "").replace(/^USAGE_PERIOD_TYPE_/i, "").toLowerCase();
  if (raw.includes("week")) return "weekly";
  if (raw.includes("month")) return "monthly";
  if (raw.includes("day")) return "daily";
  return raw === "" ? "weekly" : raw;
}

function productLabel(product: string | undefined): string {
  const raw = (product ?? "").trim();
  if (raw === "") return "weekly";
  if (/grok.?build/i.test(raw) || raw.toLowerCase() === "grokbuild") return "weekly";
  return raw;
}

function windowOf(label: string, remainingPercent: number, end: string | undefined): UsageWindow {
  const resetAt = resetAtOf(end);
  const resetInSec = resetAt === undefined ? undefined : Math.max(0, Math.trunc(resetAt - Date.now() / 1000));
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
