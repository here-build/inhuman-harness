/**
 * Drive SessionOrchestrator.ensure on the projected intern.
 * Source Nous handshake first; intern still mints if that handshake fails;
 * PEW ticks share one chain; secrets stay on the Nous bag.
 * Source A→B remints intern and rebinds credentials; removed A cannot serve new requests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import { mkdtemp, readJsonSync, writeJson } from "fs-extra";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { projectNousGatewayConnection } from "@/providers/nous";

import { NousGatewayWebSearchConnection } from "../../../drivers/web-search/nous-gateway.js";
import { writeConnectionSecrets } from "../../../secrets.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TOKEN_A = "portal-jwt-a";
const TOKEN_B = "portal-jwt-b";
const FAR_EXPIRY = "2099-01-01T00:00:00.000Z";

beforeEach(() => resetLocalIDs());

describe("SessionOrchestrator.ensure web-nous", () => {
  it("ensures Nous first, aliases the OIDC bag, and shares one chain across ticks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = await listenModels({ gate });
    const session = await openSession({
      baseUrl: models.baseUrl,
      token: TOKEN_A,
    });
    expect(session.kernel.plexus.root.connections["web-nous"]?.driver.name).toBe("web-nous");

    const first = session.orchestrator.ensure("web-nous");
    const second = session.orchestrator.ensure("web-nous");
    expect(first).toBe(second);
    await waitUntil(() => models.hits > 0);
    expect(session.kernel.plexus.root.connections["web-nous"]?.readyState).toBeNull();
    release();
    const intern = await first;
    expect(intern).toBe(await second);
    expect(intern).toBeInstanceOf(NousGatewayWebSearchConnection);
    expect({
      id: intern.connectionId,
      vendor: (intern as NousGatewayWebSearchConnection).vendor,
      apiKey: (intern as NousGatewayWebSearchConnection).apiKey(),
      internReady: intern.readyState,
      nousReady: session.kernel.plexus.root.connections["nous-portal"]?.readyState,
      internSecrets: internSecretsBag(session),
      hits: models.hits,
    }).toEqual({
      id: "web-nous",
      vendor: "firecrawl",
      apiKey: TOKEN_A,
      internReady: "ready",
      nousReady: "ready",
      internSecrets: undefined,
      hits: 1,
    });
  });

  it("mints intern when Nous bootstrap fails", async () => {
    const models = await listenModels({ status: 500 });
    const session = await openSession({
      baseUrl: models.baseUrl,
      token: TOKEN_A,
    });
    const intern = await session.orchestrator.ensure("web-nous");
    expect(intern).toBeInstanceOf(NousGatewayWebSearchConnection);
    expect({
      internReady: intern.readyState,
      nousReady: session.kernel.plexus.root.connections["nous-portal"]?.readyState,
      apiKey: (intern as NousGatewayWebSearchConnection).apiKey(),
    }).toEqual({
      internReady: "ready",
      nousReady: "failed",
      apiKey: TOKEN_A,
    });
  });

  it("source A→B remints intern onto B; same-source token updates are live; no source cannot retain A", async () => {
    const modelsA = await listenModels({});
    const modelsB = await listenModels({});
    const session = await openSession({
      baseUrl: modelsA.baseUrl,
      token: TOKEN_A,
    });
    const internA = await session.orchestrator.ensure("web-nous");
    expect((internA as NousGatewayWebSearchConnection).apiKey()).toBe(TOKEN_A);
    const hitsAfterA = modelsA.hits;

    writeConnectionSecrets(session.kernel.root, "nous-portal", {
      apiKey: "portal-jwt-a-rotated",
      refreshToken: "rt",
      expiresAt: FAR_EXPIRY,
    });
    expect((internA as NousGatewayWebSearchConnection).apiKey()).toBe("portal-jwt-a-rotated");

    const kernel = session.kernel.plexus.root;
    const nousDriver = kernel.drivers.nous;
    expect(nousDriver).toBeDefined();
    const portal = kernel.connections["nous-portal"];
    expect(portal).toBeDefined();
    portal!.configuration = { ...portal!.configuration, enabled: false };
    const next = new ConnectionSpec({ driver: nousDriver!, name: "Nous B" });
    next.configuration = { baseUrl: modelsB.baseUrl };
    kernel.connections["nous-b"] = next;
    writeConnectionSecrets(session.kernel.root, "nous-b", {
      apiKey: TOKEN_B,
      refreshToken: "rt",
      expiresAt: FAR_EXPIRY,
    });
    projectNousGatewayConnection(kernel);

    const internB = await session.orchestrator.ensure("web-nous");
    expect(internB).not.toBe(internA);
    expect((internB as NousGatewayWebSearchConnection).apiKey()).toBe(TOKEN_B);
    expect(modelsA.hits).toBe(hitsAfterA);
    expect(modelsB.hits).toBeGreaterThan(0);

    const b = kernel.connections["nous-b"];
    expect(b).toBeDefined();
    b!.configuration = { ...b!.configuration, enabled: false };
    projectNousGatewayConnection(kernel);
    expect(kernel.connections["web-nous"]).toBeUndefined();
    expect((internB as NousGatewayWebSearchConnection).apiKey()).toBeUndefined();
  });
});

async function openSession(opts: { readonly baseUrl: string; readonly token: string }): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-nous-ensure-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-nous-ensure-p-"));
  await writeJson(join(system, "config.json"), {
    connections: {
      "nous-portal": {
        driver: "nous",
        name: "Nous Portal",
        settings: { baseUrl: opts.baseUrl },
      },
    },
  });
  writeConnectionSecrets(system, "nous-portal", {
    apiKey: opts.token,
    refreshToken: "rt",
    expiresAt: FAR_EXPIRY,
  });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
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

function internSecretsBag(session: SessionDaemon): unknown {
  const file = readJsonSync(join(session.kernel.root, "secrets.json")) as {
    connections?: Record<string, unknown>;
  };
  return file.connections?.["web-nous"];
}

async function listenModels(opts: { gate?: Promise<void>; status?: number }): Promise<{
  readonly baseUrl: string;
  hits: number;
  close(): Promise<void>;
}> {
  const handle = {
    baseUrl: "",
    hits: 0,
    close: async () => {},
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url?.endsWith("/models")) {
        handle.hits += 1;
        if (opts.gate !== undefined) await opts.gate;
        const status = opts.status ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status >= 400 ? { error: "handshake failed" } : { data: [{ id: "m1" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      handle.baseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve();
    });
  });
  handle.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  onTestFinished(() => handle.close());
  return handle;
}

async function waitUntil(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() >= deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
