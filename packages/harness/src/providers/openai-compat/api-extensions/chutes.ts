import { z } from "zod";

import { getJson, joinUrl, originOf, parseWire } from "./http.js";
import { snapshotIdentity, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/users/me";

const wireSchema = z.object(
  {
    username: z.string({ error: "username must be a string" }),
    user_id: z.string({ error: "user_id must be a string" }),
    logo_id: z.string({ error: "logo_id must be a string" }).nullable().optional(),
    created_at: z.string({ error: "created_at must be a string" }).optional(),
    hotkey: z.string({ error: "hotkey must be a string" }).optional(),
    coldkey: z.string({ error: "coldkey must be a string" }).optional(),
    payment_address: z.string({ error: "payment_address must be a string" }).optional(),
    permissions_bitmask: z.number({ error: "permissions_bitmask must be a number" }).optional(),
    balance: z.number({ error: "balance must be a number" }).nullable().optional(),
    netuids: z
      .array(z.number({ error: "netuid must be a number" }))
      .nullable()
      .optional(),
    quotas: z.array(z.object({}).passthrough(), { error: "quotas must be an array" }).nullable().optional(),
    logo: z.string({ error: "logo must be a string" }).nullable().optional(),
    permissions: z.array(z.string({ error: "permission must be a string" })).optional(),
  },
  { error: "users/me response must be an object" },
);

function managementOrigin(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  // Inference is llm.chutes.ai; account lives on api.chutes.ai with the same key.
  if (host === "llm.chutes.ai") return "https://api.chutes.ai";
  return originOf(baseUrl);
}

export async function getChutesAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(managementOrigin(req.baseUrl), PATH), "chutes", PATH);
  const body = parseWire(wireSchema, json, "chutes", PATH);
  return snapshotIdentity({
    kind: "user",
    id: body.user_id,
    handle: body.username,
    displayName: body.username,
    apiKey: req.apiKey,
  });
}
