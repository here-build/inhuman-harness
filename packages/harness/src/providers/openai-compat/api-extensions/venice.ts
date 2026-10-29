import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import {
  fiat,
  money,
  snapshotIdentity,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type CurrencyDetail,
  type Money,
} from "./types.js";

const PATH = "/billing/balance";

const wireSchema = z.object(
  {
    canConsume: z.boolean({ error: "canConsume must be a boolean" }),
    consumptionCurrency: z
      .enum(["USD", "VCU", "DIEM", "BUNDLED_CREDITS"], {
        error: "consumptionCurrency is invalid",
      })
      .nullable(),
    balances: z.object(
      {
        diem: z.number({ error: "balances.diem must be a number" }).nullable(),
        usd: z.number({ error: "balances.usd must be a number" }).nullable(),
      },
      { error: "balances must be an object" },
    ),
    diemEpochAllocation: z.number({
      error: "diemEpochAllocation must be a number",
    }),
  },
  { error: "billing balance response must be an object" },
);

function veniceCurrency(code: "USD" | "VCU" | "DIEM" | "BUNDLED_CREDITS"): CurrencyDetail {
  if (code === "USD") return fiat("USD", "$");
  if (code === "DIEM") return { code: "DIEM", kind: "crypto", digits: 2 };
  return { code, kind: "credits", digits: 2 };
}

export async function getVeniceAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "venice", PATH);
  const body = parseWire(wireSchema, json, "venice", PATH);
  const identity = snapshotIdentity({ kind: "key", apiKey: req.apiKey });
  const diem = body.balances.diem === null ? undefined : money(body.balances.diem, veniceCurrency("DIEM"));
  const usdBal = body.balances.usd === null ? undefined : money(body.balances.usd, veniceCurrency("USD"));
  let remaining: Money | undefined;
  if (body.consumptionCurrency === "DIEM") remaining = diem;
  else if (body.consumptionCurrency === "USD") remaining = usdBal;
  const other: Money[] = [];
  if (body.consumptionCurrency !== "DIEM" && diem !== undefined) other.push(diem);
  if (body.consumptionCurrency !== "USD" && usdBal !== undefined) other.push(usdBal);
  return withFunds(identity, remaining, {
    canSpend: body.canConsume,
    ...(other.length === 0 ? {} : { other }),
    ...(body.consumptionCurrency === "DIEM" ? { limit: money(body.diemEpochAllocation, veniceCurrency("DIEM")) } : {}),
  });
}
