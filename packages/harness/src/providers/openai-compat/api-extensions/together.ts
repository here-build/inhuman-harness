import { z } from "zod";

import { getJson, joinUrl, parseWire } from "./http.js";
import { snapshotIdentity, type AccountRequest, type AccountSnapshot } from "./types.js";

const PATH = "/whoami";

const wireSchema = z.object(
  {
    api_key_id: z.string({ error: "api_key_id must be a string" }),
    project_id: z.string({ error: "project_id must be a string" }),
    project_name: z.string({ error: "project_name must be a string" }),
    project_slug: z.string({ error: "project_slug must be a string" }),
    organization_id: z.string({ error: "organization_id must be a string" }),
    organization_name: z.string({
      error: "organization_name must be a string",
    }),
    user_id: z.string({ error: "user_id must be a string" }).optional(),
  },
  { error: "whoami response must be an object" },
);

export async function getTogetherAccount(req: AccountRequest): Promise<AccountSnapshot> {
  const json = await getJson(req, joinUrl(req.baseUrl, PATH), "together", PATH);
  const body = parseWire(wireSchema, json, "together", PATH);
  return snapshotIdentity({
    kind: "key",
    id: body.user_id,
    handle: body.project_slug,
    orgName: body.organization_name,
    orgId: body.organization_id,
    projectName: body.project_name,
    projectSlug: body.project_slug,
    projectId: body.project_id,
    apiKey: req.apiKey,
    keyId: body.api_key_id,
  });
}
