import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import { money, snapshotIdentity, usd, withFunds, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/credits";

const wireSchema = z.object(
  {
    balance: z.string({ error: "balance must be a string" }),
    total_used: z.string({ error: "total_used must be a string" }).optional(),
  },
  { error: "credits response must be an object" },
);

export async function getVercelAiGatewayAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "vercel-ai-gateway", PATH);
  const body = parseWire(wireSchema, json, "vercel-ai-gateway", PATH);
  const remaining = money(body.balance, usd());
  return withFunds(snapshotIdentity({ kind: "key", apiKey: req.apiKey }), remaining, {
    remaining,
    ...(body.total_used === undefined ? {} : { used: money(body.total_used, usd()) }),
  });
}
