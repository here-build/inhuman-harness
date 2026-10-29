// connect — connects one MCP client over a given transport and lists its tools. Takes a
// `Transport` (not a stdio config directly) so this is testable against
// `InMemoryTransport` (see transport.ts for config -> transport step).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** The slice of the SDK `Client` the manifold actually uses. The MCP SDK's `Client`
 *  satisfies this as-is; non-MCP upstreams (atlas-sandbox.ts) implement it directly
 *  instead of faking a JSON-RPC transport.
 *
 *  `request` is the tool-call path, NOT `callTool`: `callTool` performs the SDK's
 *  CLIENT-SIDE output-schema validation and THROWS on a mismatch — discarding the content
 *  blocks that already arrived (sdk/client/index.js: the result is received, the validator
 *  rejects, the payload is dropped). That makes any tool whose own output contradicts its own
 *  declared schema unusable through the manifold, for data sitting right there. We issue the
 *  request ourselves and adjudicate the mismatch ourselves (server.ts's `outputSchemaMismatch`):
 *  the schema is a CLAIM ABOUT the payload, not a licence to delete it. `callTool` stays in the
 *  Pick because tests and non-salvaging callers still use it. */
export type UpstreamClient = Pick<Client, "callTool" | "request" | "listTools" | "setNotificationHandler" | "close">;

export interface ConnectedServer {
  slug: string;
  client: UpstreamClient;
  tools: readonly Tool[];
}

export async function connectServer(slug: string, transport: Transport): Promise<ConnectedServer> {
  const client = new Client({ name: "arrival-manifold", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { slug, client, tools };
}
