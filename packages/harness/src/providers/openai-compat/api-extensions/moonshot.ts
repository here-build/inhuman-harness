import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import { money, snapshotIdentity, usd, withFunds, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/users/me/balance";

const wireSchema = z.object(
  {
    code: z.number({ error: "code must be a number" }),
    data: z.object(
      {
        available_balance: z.number({
          error: "available_balance must be a number",
        }),
        voucher_balance: z.number({
          error: "voucher_balance must be a number",
        }),
        cash_balance: z.number({ error: "cash_balance must be a number" }),
      },
      { error: "data must be an object" },
    ),
    scode: z.string({ error: "scode must be a string" }).optional(),
    status: z.boolean({ error: "status must be a boolean" }).optional(),
  },
  { error: "balance response must be an object" },
);

export async function getMoonshotAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "moonshot", PATH);
  const body = parseWire(wireSchema, json, "moonshot", PATH);
  const remaining = money(body.data.available_balance, usd());
  return withFunds(snapshotIdentity({ kind: "key", apiKey: req.apiKey }), remaining, {
    remaining,
    cash: money(body.data.cash_balance, usd()),
    voucher: money(body.data.voucher_balance, usd()),
  });
}
