import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import { money, snapshotIdentity, usd, withFunds, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/user/info";

const wireSchema = z.object(
  {
    code: z.number({ error: "code must be a number" }),
    message: z.string({ error: "message must be a string" }),
    status: z.boolean({ error: "status must be a boolean" }),
    data: z.object(
      {
        id: z.string({ error: "data.id must be a string" }),
        name: z.string({ error: "data.name must be a string" }).optional(),
        email: z.string({ error: "data.email must be a string" }).optional(),
        isAdmin: z.boolean({ error: "data.isAdmin must be a boolean" }).optional(),
        balance: z.string({ error: "data.balance must be a string" }),
        status: z.string({ error: "data.status must be a string" }),
        chargeBalance: z.string({
          error: "data.chargeBalance must be a string",
        }),
        totalBalance: z.string({ error: "data.totalBalance must be a string" }),
      },
      { error: "data must be an object" },
    ),
  },
  { error: "user info response must be an object" },
);

function accountStatus(value: string): "ok" | "suspended" | "limited" | "unknown" {
  if (value === "normal") return "ok";
  if (value === "suspended") return "suspended";
  if (value === "limited") return "limited";
  return "unknown";
}

export async function getSiliconFlowAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "siliconflow", PATH);
  const body = parseWire(wireSchema, json, "siliconflow", PATH);
  const remaining = money(body.data.totalBalance, usd());
  return withFunds(
    snapshotIdentity({
      kind: "user",
      id: body.data.id,
      displayName: body.data.name,
      email: body.data.email,
      apiKey: req.apiKey,
      status: accountStatus(body.data.status),
    }),
    remaining,
    {
      remaining,
      cash: money(body.data.balance, usd()),
      purchased: money(body.data.chargeBalance, usd()),
    },
  );
}
