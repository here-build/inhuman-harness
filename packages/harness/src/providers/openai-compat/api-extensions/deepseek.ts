import { z } from "zod";

import { getJson, joinUrl, parseWire, stripTrailingV1 } from "./http.js";
import { fiat, money, snapshotIdentity, withFunds, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/user/balance";

const infoSchema = z.object(
  {
    currency: z.string({ error: "currency must be a string" }).min(1, "currency must be a string"),
    total_balance: z.string({ error: "total_balance must be a string" }),
    granted_balance: z.string({ error: "granted_balance must be a string" }),
    topped_up_balance: z.string({
      error: "topped_up_balance must be a string",
    }),
  },
  { error: "balance_infos[] item must be an object" },
);

const wireSchema = z.object(
  {
    is_available: z.boolean({ error: "is_available must be a boolean" }),
    balance_infos: z.array(infoSchema, {
      error: "balance_infos must be an array",
    }),
  },
  { error: "balance response must be an object" },
);

function currency(code: string) {
  if (code === "USD") return fiat("USD", "$");
  if (code === "CNY") return fiat("CNY", "¥");
  return fiat(code);
}

export async function getDeepSeekAccount(req: AccountRequest): Promise<AccountSnapshot> {
  // Official path is `{origin}/user/balance` — not under `/v1`.
  const json = await getJson(req, joinUrl(stripTrailingV1(req.baseUrl), PATH), "deepseek", PATH);
  const body = parseWire(wireSchema, json, "deepseek", PATH);
  const identity = snapshotIdentity({ kind: "key", apiKey: req.apiKey });
  const [primary, ...rest] = body.balance_infos;
  if (primary === undefined) return identity;
  const remaining = money(primary.total_balance, currency(primary.currency));
  return withFunds(identity, remaining, {
    remaining,
    canSpend: body.is_available,
    granted: money(primary.granted_balance, remaining.currency),
    toppedUp: money(primary.topped_up_balance, remaining.currency),
    ...(rest.length === 0
      ? {}
      : {
          other: rest.map((row) => money(row.total_balance, currency(row.currency))),
        }),
  });
}
