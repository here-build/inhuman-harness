/**
 * `connect/models` intern-probes completion catalogs without a session.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp } from "fs-extra";
import { expect, test } from "vitest";

import { RpcInvalidParams } from "../../../contract.js";
import { listenCompat } from "../../../testkit/compat-server.js";
import { sequenceReply } from "../../../testkit/sequence-provider.js";
import { KernelDaemon } from "../KernelDaemon.js";

async function thrown(run: () => Promise<unknown>): Promise<{ name: string; message: string }> {
  try {
    await run();
    return { name: "did-not-throw", message: "" };
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

test("connect/models intern-probes live ids and rejects non-completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-connect-models-"));
  using daemon = new KernelDaemon(root);
  await daemon.ready;
  const alpha = await listenCompat({ models: [{ id: "alpha-1" }, { id: "shared" }], reply: sequenceReply });
  const beta = await listenCompat({ models: [{ id: "beta-1" }, { id: "shared" }], reply: sequenceReply });
  try {
    const adopted = {
      alpha: (await daemon.handleRequest("connect/adopt", {
        driver: "openai-compat",
        name: "Alpha",
        settings: { baseUrl: alpha.baseUrl },
      })) as { id: string },
      beta: (await daemon.handleRequest("connect/adopt", {
        driver: "openai-compat",
        name: "Beta",
        settings: { baseUrl: beta.baseUrl },
      })) as { id: string },
      mcp: (await daemon.handleRequest("connect/adopt", {
        driver: "mcp-http",
        name: "Mail",
        settings: { url: "https://mcp.example/mcp" },
      })) as { id: string },
    };
    const one = (await daemon.handleRequest("connect/models", { id: adopted.alpha.id })) as {
      connections: Array<{ id: string; models: string[]; error: string }>;
    };
    const all = (await daemon.handleRequest("connect/models", {})) as {
      connections: Array<{ id: string; models: string[] }>;
    };
    expect({
      adopted: { alpha: adopted.alpha.id, beta: adopted.beta.id, mcp: adopted.mcp.id },
      one,
      all: all.connections.map((row) => ({ id: row.id, models: [...row.models].sort() })),
      mcp: await thrown(() => daemon.handleRequest("connect/models", { id: adopted.mcp.id })),
      unknown: await thrown(() => daemon.handleRequest("connect/models", { id: "nope" })),
    }).toEqual({
      adopted: { alpha: "alpha", beta: "beta", mcp: "mail" },
      one: { connections: [{ id: "alpha", models: ["alpha-1", "shared"], error: "" }] },
      all: [
        { id: "alpha", models: ["alpha-1", "shared"] },
        { id: "beta", models: ["beta-1", "shared"] },
      ],
      mcp: { name: RpcInvalidParams.name, message: expect.stringMatching(/not a completion/) },
      unknown: { name: RpcInvalidParams.name, message: expect.stringMatching(/unknown connection nope/) },
    });
  } finally {
    await alpha.close();
    await beta.close();
  }
}, 20_000);
