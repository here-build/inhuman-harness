import { z } from "zod";

import { getJson, joinUrl, parseWire, stripTrailingV1 } from "./http.js";
import {
  money,
  snapshotIdentity,
  withFunds,
  type AccountRequest,
  type AccountSnapshot,
  type CurrencyDetail,
} from "./types.js";

const PATH = "/usage/current_balance";

const PTS: CurrencyDetail = { code: "PTS", kind: "points", digits: 0 };

const wireSchema = z.object(
  {
    current_point_balance: z
      .number({ error: "current_point_balance must be a number" })
      .int("current_point_balance must be an integer"),
  },
  { error: "current_balance response must be an object" },
);

export async function getPoeAccount(req: AccountRequest): Promise<AccountSnapshot> {
  // Billing is `{origin}/usage/current_balance`, not under `/v1`.
  const json = await getJson(req, joinUrl(stripTrailingV1(req.baseUrl), PATH), "poe", PATH);
  const body = parseWire(wireSchema, json, "poe", PATH);
  const remaining = money(body.current_point_balance, PTS);
  return withFunds(snapshotIdentity({ kind: "key", apiKey: req.apiKey }), remaining, { remaining });
}
