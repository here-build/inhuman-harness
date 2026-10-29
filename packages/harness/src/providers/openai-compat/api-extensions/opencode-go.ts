import invariant from "tiny-invariant";
import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import {
  money,
  snapshotIdentity,
  usd,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type UsageWindow,
} from "./types.js";

const PATH = "/usage";

const windowSchema = z
  .object(
    {
      status: z.string({ error: "status must be a string" }),
      resetInSec: z.number({ error: "resetInSec must be a number" }).optional(),
      resetsAt: z.number({ error: "resetsAt must be a number" }).optional(),
      usagePercent: z.number({ error: "usagePercent must be a number" }).optional(),
      percent: z.number({ error: "percent must be a number" }).optional(),
    },
    { error: "usage window must be an object" },
  )
  .refine((row) => row.usagePercent !== undefined || row.percent !== undefined, {
    error: "usagePercent is required",
    path: ["usagePercent"],
  });

const wireSchema = z.object(
  {
    useBalance: z.boolean({ error: "useBalance must be a boolean" }),
    rollingUsage: windowSchema,
    weeklyUsage: windowSchema,
    monthlyUsage: windowSchema,
  },
  { error: "usage response must be an object" },
);

function windowOf(label: string, raw: z.output<typeof windowSchema>, limitUsd: number): UsageWindow {
  const usedPercent = raw.usagePercent ?? raw.percent;
  invariant(usedPercent !== undefined, `opencode-go ${PATH}: ${label} missing usagePercent`);
  const resetInSec = raw.resetInSec ?? raw.resetsAt;
  const remainingPercent = Math.min(100, Math.max(0, 100 - usedPercent));
  const exhausted = raw.status === "exhausted" || remainingPercent <= 0;
  const ok = raw.status === "ok";
  return {
    label,
    remainingPercent,
    limit: money(limitUsd, usd()),
    ...(resetInSec === undefined ? {} : { resetInSec }),
    ...(exhausted ? { status: "exhausted" as const } : ok ? { status: "ok" as const } : {}),
  };
}

export async function getOpenCodeGoAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "opencode-go", PATH);
  const body = parseWire(wireSchema, json, "opencode-go", PATH);
  return withFunds(snapshotIdentity({ kind: "subscription", apiKey: req.apiKey }), undefined, {
    windows: [
      windowOf("rolling", body.rollingUsage, 12),
      windowOf("weekly", body.weeklyUsage, 30),
      windowOf("monthly", body.monthlyUsage, 60),
    ],
  });
}
