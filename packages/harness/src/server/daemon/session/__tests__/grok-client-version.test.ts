/**
 * ensure writes the grok client version onto the connection row in config.json.
 * The next process reads that row back as settings.clientVersion.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { mkdtemp, readJsonSync } from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { GROK_CLIENT_VERSION } from "@/providers/grok";

import { parseConfigJson } from "../../../schemas/well-known.js";
import { writeConnectionSecrets } from "../../../secrets.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const originalFetch = globalThis.fetch;

beforeEach(() => resetLocalIDs());

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("grok client version settings", () => {
  it("records the floor on ensure and sends it on the handshake", async () => {
    const versions: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("xai-grok-version/Cargo.toml")) {
        throw new Error(`unexpected crate fetch ${url}`);
      }
      const version = new Headers(init?.headers).get("x-grok-client-version");
      if (version != null) versions.push(version);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const session = await openSession(undefined);
    await session.orchestrator.ensure("grok");

    const config = parseConfigJson(readJsonSync(join(session.kernel.root, "config.json")));
    expect(config.connections.grok.settings.clientVersion).toBe(GROK_CLIENT_VERSION);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((version) => version === GROK_CLIENT_VERSION)).toBe(true);
  });

  it("keeps a newer stored version across ensure", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const version = new Headers(init?.headers).get("x-grok-client-version");
      if (version != null && version !== "9.9.9") {
        throw new Error(`sent ${version}`);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const session = await openSession("9.9.9");
    await session.orchestrator.ensure("grok");
    const config = parseConfigJson(readJsonSync(join(session.kernel.root, "config.json")));
    expect(config.connections.grok.settings.clientVersion).toBe("9.9.9");
  });
});

async function openSession(clientVersion: string | undefined): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-grok-ver-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-grok-ver-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  kernel.adjustConfig((config) => {
    config.connections.grok = {
      driver: "grok",
      name: "Grok",
      annotation: "",
      settings: {
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
        ...(clientVersion === undefined ? {} : { clientVersion }),
      },
    };
  });
  writeConnectionSecrets(kernel.root, "grok", { apiKey: "grok-at" });
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return session;
}
