// ASSEMBLED-SERVER TEACHING WIRING — the regression net for the binder→runner wiring.
// Teaching mechanisms are proven here through the REAL `buildManifoldServer(...)` →
// `CallTool` wiring (`server.ts`'s `rebuild()` constructs the `DoorSession`/
// `FutilityTracker`/`AttachmentCollector`, builds the spine lens per world, and threads
// options into `createManifoldTool`) — never by hand-injecting options into a
// directly-constructed `createManifoldTool(env, catalog, { ...options })`. A future
// binder→runner extraction could silently stop supplying one of these through the real
// wire while every hand-injected test stays green, because the hand-injected test
// supplies the option itself.
//
// CONCERNS NAMED:
//   • scope-confusion — genuinely UNCOVERED at the assembled-server boundary before this file
//     (scope-confusion.test.ts's e2e describe block drives `createManifoldTool` directly with
//     hand-passed `{ session, signatureByName, toolParts }`, never `buildManifoldServer`).
//   • type-hint delivery via a SERVER-BUILT `createSpineLens` is already covered by
//     `src/__tests__/type-hints/server-activation.test.ts`, which drives
//     `buildManifoldServer([upstream], { typeHints: { mode }, session })` with NO lens
//     injected — proving server.ts builds the real spine adapter and threads it through.
//     A second, near-duplicate test here would be redundant coverage, not a new
//     regression net, so this file does not add one.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { TOOL_NAME } from "../names.js";
import { buildManifoldServer } from "../server.js";

async function connectToManifold(manifoldServer: Awaited<ReturnType<typeof buildManifoldServer>>) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await manifoldServer.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

type Block = { type: string; text: string };
const textOf = (r: { content: unknown }): string => (r.content as Block[]).map((b) => b.text).join("\n");

describe("assembled-server wiring — scope-confusion door fires through the REAL CallTool path", () => {
  it("a let-bound name in call 1, referenced bare in call 2 — the cross-scope door renders, built entirely by server.ts's own wiring (no hand-injected session/toolParts)", async () => {
    // Zero upstream tools needed — scope-confusion is a pure-Scheme-syntax door. The point is
    // that `server.ts` itself builds the `DoorSession`/`toolParts`/`signatureByName` this door
    // needs and threads them into `createManifoldTool` — nothing is hand-passed here.
    const manifoldServer = await buildManifoldServer([]);
    const client = await connectToManifold(manifoldServer);

    const call = async (expr: string) =>
      (await client.callTool({ name: TOOL_NAME, arguments: { expr } })) as { content: unknown; isError?: boolean };

    const first = await call("(let ((zed 5)) zed)");
    expect(first.isError).toBeFalsy();

    const second = await call("zed");
    expect(second.isError).toBe(true);
    const text = textOf(second);
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `zed'");
    expect(text).toContain("a local scope (a let/lambda body) 1 message ago");
    expect(text).toContain("Re-declare it at top level with (define zed");
  });
});
