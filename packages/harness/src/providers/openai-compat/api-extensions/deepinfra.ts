import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import { money, snapshotIdentity, usd, withFunds, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/me";

const wireSchema = z.object(
  {
    uid: z.string({ error: "uid must be a string" }).optional(),
    email: z.string({ error: "email must be a string" }).nullable().optional(),
    display_name: z.string({ error: "display_name must be a string" }).optional(),
    name: z.string({ error: "name must be a string" }).optional(),
    team_display_name: z.string({ error: "team_display_name must be a string" }).nullable().optional(),
    checklist: z.object(
      {
        stripe_balance: z.number({ error: "stripe_balance must be a number" }),
        recent: z.number({ error: "recent must be a number" }),
        limit: z.number({ error: "limit must be a number" }).nullable(),
        suspend_reason: z.string({ error: "suspend_reason must be a string" }).nullable(),
        overdue_invoices: z.number({ error: "overdue_invoices must be a number" }).optional(),
      },
      { error: "checklist must be an object" },
    ),
  },
  { error: "me response must be an object" },
);

function accountBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  // OpenAI-compat root is `/v1/openai`; account is `/v1/me` on the same host.
  return trimmed.endsWith("/openai") ? trimmed.slice(0, -"/openai".length) : trimmed;
}

export async function getDeepInfraAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(accountBase(req.baseUrl), "me?checklist=true"), "deepinfra", PATH);
  const body = parseWire(wireSchema, json, "deepinfra", PATH);
  const identity = snapshotIdentity({
    kind: "user",
    id: body.uid,
    email: body.email ?? undefined,
    displayName: body.display_name ?? body.name,
    teamName: body.team_display_name ?? undefined,
    apiKey: req.apiKey,
    status: body.checklist.suspend_reason ? "suspended" : "ok",
  });
  // stripe_balance is negative when funds are ready-to-spend; flip sign to remaining.
  const remaining = money(-body.checklist.stripe_balance, usd());
  return withFunds(identity, remaining, {
    remaining,
    used: money(body.checklist.recent, usd()),
    limit: body.checklist.limit === null ? null : money(body.checklist.limit, usd()),
  });
}
