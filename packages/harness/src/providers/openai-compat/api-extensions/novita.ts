import { z } from "zod";

import { getJson, joinUrl, originOf, parseWire } from "./http.js";
import {
  money,
  snapshotIdentity,
  unscale,
  usd,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
} from "./types.js";

const USER_PATH = "/v3/user";
const BILLING_PATH = "/openapi/v1/billing/balance/detail";

const userSchema = z.object(
  {
    credit_balance: z.union([
      z.string({ error: "credit_balance must be a string" }),
      z.number({ error: "credit_balance must be a number" }),
    ]),
    id: z.string({ error: "id must be a string" }).optional(),
    user_id: z.string({ error: "user_id must be a string" }).optional(),
    username: z.string({ error: "username must be a string" }).optional(),
    name: z.string({ error: "name must be a string" }).optional(),
    email: z.string({ error: "email must be a string" }).optional(),
  },
  { error: "user response must be an object" },
);

const billingSchema = z.object(
  {
    availableBalance: z.string({ error: "availableBalance must be a string" }),
    cashBalance: z.string({ error: "cashBalance must be a string" }).optional(),
    creditLimit: z.string({ error: "creditLimit must be a string" }).optional(),
    pendingCharges: z.string({ error: "pendingCharges must be a string" }).optional(),
    outstandingInvoices: z.string({ error: "outstandingInvoices must be a string" }).optional(),
  },
  { error: "billing balance response must be an object" },
);

function usdFromScaled(raw: string | number) {
  // Novita balances are 1/10000 USD (`10000` = $1.00).
  return money(unscale(raw, 10_000, 2), usd());
}

export async function getNovitaAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const origin = originOf(req.baseUrl);
  const userJson = await getJson(req, joinUrl(origin, USER_PATH), "novita", USER_PATH);
  const user = parseWire(userSchema, userJson, "novita", USER_PATH);
  const billingJson = await getJson(req, joinUrl(origin, BILLING_PATH), "novita", BILLING_PATH);
  const billing = parseWire(billingSchema, billingJson, "novita", BILLING_PATH);
  const remaining = usdFromScaled(billing.availableBalance);
  return withFunds(
    snapshotIdentity({
      kind: "user",
      id: user.user_id ?? user.id,
      handle: user.username,
      displayName: user.name,
      email: user.email,
      apiKey: req.apiKey,
    }),
    remaining,
    {
      remaining,
      ...(billing.cashBalance === undefined ? {} : { cash: usdFromScaled(billing.cashBalance) }),
      ...(billing.creditLimit === undefined ? {} : { limit: usdFromScaled(billing.creditLimit) }),
    },
  );
}
