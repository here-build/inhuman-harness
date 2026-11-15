import { randomBytes, randomUUID } from "node:crypto";

import { defineTool, InhumanPlugin, type WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";
import { CommitDiffShapeSource } from "@inhuman.tools/scope-plane";
import { pgPoolDriver, PostgresKvStore, PostgresSecretsBackend } from "@inhuman.tools/scope-plane-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import {
  AsyncCachedBlobBucket,
  createPortableHarnessServer,
  EncryptedSecretsVault,
  HostRuntimePluginCatalog,
  MemoryAsyncBlobBucket,
  MultiKernelRegistry,
  type SecretsKeyRing,
} from "../portable-server.js";
import { listenCompat } from "../testkit/compat-server.js";

const POSTGRES_URL =
  process.env.HARNESS_TEST_POSTGRES_URL ??
  process.env.INHUMAN_TEST_POSTGRES_URL ??
  process.env.DATABASE_URL ??
  "postgres://kley:kley@127.0.0.1:5432/postgres";

type RpcWaiter = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

type WsDelta = {
  readonly subscriptionId: string;
  readonly offset: number;
  readonly upserts: ReadonlyArray<Record<string, unknown>>;
  readonly deletes: readonly string[];
};

type JsonRpcClient = {
  readonly deltas: WsDelta[];
  request(method: string, params?: unknown): Promise<unknown>;
  sendFrame(frame: Record<string, unknown>): void;
  close(): Promise<void>;
};

async function openWsClient(url: string, headers: Record<string, string>): Promise<JsonRpcClient> {
  const ws = new WebSocket(url, { headers });
  const pending = new Map<string, RpcWaiter>();
  const deltas: WsDelta[] = [];
  let nextId = 1;

  ws.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : Buffer.from(raw as Buffer).toString("utf8");
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg.kind === "shape/delta" && typeof msg.subscriptionId === "string") {
      deltas.push({
        subscriptionId: msg.subscriptionId,
        offset: Number(msg.offset ?? 0),
        upserts: Array.isArray(msg.upserts) ? (msg.upserts as Array<Record<string, unknown>>) : [],
        deletes: Array.isArray(msg.deletes) ? (msg.deletes as string[]) : [],
      });
      return;
    }
    const id = msg.id;
    if (typeof id === "string" || typeof id === "number") {
      const waiter = pending.get(String(id));
      if (waiter !== undefined) {
        pending.delete(String(id));
        if (msg.error !== undefined && typeof msg.error === "object" && msg.error !== null) {
          const message = (msg.error as Record<string, unknown>).message;
          waiter.reject(new Error(typeof message === "string" ? message : "RPC error"));
        } else {
          waiter.resolve(msg.result);
        }
      }
    }
  });

  ws.once("close", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`WebSocket closed (${code})`));
    }
    pending.clear();
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`Unexpected HTTP status ${res.statusCode ?? 0}`));
    });
  });

  return {
    deltas,
    request(method: string, params?: unknown) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    sendFrame(frame: Record<string, unknown>) {
      ws.send(JSON.stringify(frame));
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function httpJson(
  url: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  } = {},
): Promise<{ readonly status: number; readonly json: unknown }> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown) };
}

function createVfsPlugin(): InhumanPlugin {
  const vfsConfigSchema = z.object({
    rootLabel: z.string().min(1),
    files: z.record(z.string(), z.string()),
  });

  return new InhumanPlugin({
    projectConfigSchema: vfsConfigSchema,
    activateProject(ctx, rawConfig) {
      const cfg = vfsConfigSchema.parse(rawConfig);
      const env: WorkspaceEnvPort = {
        logicalRoot: ctx.workspacePath,
        resolveCanonicalPathSync: (target) => target,
        probeWriteTarget: (target) => {
          const rel = target.startsWith(`${ctx.workspacePath}/`) ? target.slice(ctx.workspacePath.length + 1) : target;
          const hit = cfg.files[rel];
          return hit !== undefined
            ? { exists: true, isDirectory: false, canonicalPath: target, textContent: hit }
            : { exists: false };
        },
      };
      const vfsRead = defineTool({
        name: "vfs_read",
        description: "Read a file from the tenant's virtual project workspace.",
        class: "read",
        representation: "tool",
        input: z.object({ path: z.string().min(1) }),
        output: z.object({ label: z.string(), content: z.string() }),
        run: (args) => {
          const content = cfg.files[args.path];
          if (content === undefined) {
            throw new Error(`missing virtual file ${args.path}`);
          }
          return { label: cfg.rootLabel, content };
        },
      });
      return { workspaceEnv: env, tools: [vfsRead] };
    },
  });
}

describe("Portable Harness Server over PostgreSQL 18", () => {
  const sharedPool = new Pool({ connectionString: POSTGRES_URL, max: 6 });

  afterAll(async () => {
    await sharedPool.end();
  });

  it("persists kernels, sessions, nodes, and encrypted secrets in PostgreSQL and survives cold stateless restart", async () => {
    const tag = randomUUID().slice(0, 12).replaceAll("-", "_");
    const harnessSchema = `harness_e2e_${tag}`;
    const vaultSchema = `vault_e2e_${tag}`;
    onTestFinished(async () => {
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${harnessSchema}" CASCADE`);
      await sharedPool.query(`DROP SCHEMA IF EXISTS "${vaultSchema}" CASCADE`);
    });

    const masterKey = randomBytes(32);
    const keyRing: SecretsKeyRing = { activeKid: "k1", keys: { k1: masterKey } };
    const remoteBlobs = new MemoryAsyncBlobBucket();
    const allowedOrigin = "https://pg-e2e.example.com";
    const workspaceA = "/virtual/tenant-a/ws";
    const workspaceB = "/virtual/tenant-b/ws";
    const liveSecret = "sk-pg-live-secret-987654321";

    const tenantByKernel = new Map<string, string>([
      ["kernel-a", "tenant-a"],
      ["kernel-b", "tenant-b"],
    ]);

    const catalog = await new HostRuntimePluginCatalog({
      runtimePlugins: { "vfs-plugin": createVfsPlugin() },
    }).warm();

    let postCount = 0;
    const compat = await listenCompat({
      models: [{ id: "m1" }],
      reply: () => {
        postCount += 1;
        if (postCount === 1) {
          return {
            content: "Reading virtual file.",
            finish_reason: "tool_calls",
            tool_calls: [
              {
                id: "call_pg_1",
                type: "function",
                function: {
                  name: "vfs_read",
                  arguments: JSON.stringify({ path: "notes/secret.txt" }),
                },
              },
            ],
          };
        }
        if (postCount === 2) {
          return { content: "TENANT_A_PG_ROUND_1", finish_reason: "stop" };
        }
        return { content: "COLD_POD2_DONE", finish_reason: "stop" };
      },
    });
    onTestFinished(() => compat.close());

    const startPod = async () => {
      const driver = pgPoolDriver(sharedPool);
      const db = new PostgresKvStore(driver, { schema: harnessSchema });
      await db.bootstrap();
      const secretsBackend = new PostgresSecretsBackend(driver, { schema: vaultSchema });
      await secretsBackend.bootstrap();
      const blobBuckets: AsyncCachedBlobBucket[] = [];
      const laneHub = new CommitDiffShapeSource(db);

      const registry = new MultiKernelRegistry({
        db,
        ownsDb: true,
        laneHub,
        ownsLaneHub: true,
        idleEvictMs: 0,
        ...catalog.kernelOptions(),
        createSecretsVault: (kernelId) =>
          new EncryptedSecretsVault({
            backend: secretsBackend,
            keyRing,
            tenantId: tenantByKernel.get(kernelId) ?? kernelId,
            kernelId,
            ownsBackend: false,
          }),
        createBlobBucket: () => {
          const cache = new AsyncCachedBlobBucket({ remote: remoteBlobs, maxCacheBytes: 1024 });
          blobBuckets.push(cache);
          return cache;
        },
      });

      const server = createPortableHarnessServer({
        registry,
        ownsRegistry: true,
        allowedOrigins: [allowedOrigin],
        authenticate(req) {
          const auth = req.headers.authorization;
          if (auth === "Bearer token-a") {
            return { tenantId: "tenant-a", kernelId: "kernel-a", subjectId: "user-a" };
          }
          if (auth === "Bearer token-b") {
            return { tenantId: "tenant-b", kernelId: "kernel-b", subjectId: "user-b" };
          }
          return null;
        },
      });
      const addr = await server.listen(0, "127.0.0.1");

      let closed = false;
      const dispose = async () => {
        if (closed) return;
        closed = true;
        await server[Symbol.asyncDispose]();
        await Promise.allSettled(blobBuckets.map((bucket) => bucket[Symbol.asyncDispose]()));
        await secretsBackend.close();
      };

      return { addr, dispose };
    };

    // --- Pod 1: initial provisioning, secret encryption, virtual workspace turn, tenant isolation ---
    const pod1 = await startPod();
    onTestFinished(() => pod1.dispose());

    const adoptRes = await httpJson(`${pod1.addr.url}/rpc`, {
      method: "POST",
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      body: {
        id: 1,
        method: "connect/adopt",
        params: {
          driver: "openai-compat",
          name: "PG Mock OpenAI",
          settings: { baseUrl: compat.baseUrl },
          secrets: { apiKey: liveSecret },
        },
      },
    });
    expect(adoptRes.status).toBe(200);
    const connId = (adoptRes.json as { result?: { id?: string } }).result?.id;
    expect(typeof connId).toBe("string");

    // Verify encrypted secret envelope in Postgres contains no plaintext secret.
    const secretRows = await sharedPool.query<{ kid: string; ciphertext: Buffer }>(
      `SELECT kid, ciphertext FROM "${vaultSchema}".harness_connection_secrets WHERE tenant_id = $1 AND kernel_id = $2 AND connection_id = $3`,
      ["tenant-a", "kernel-a", connId],
    );
    expect(secretRows.rows).toHaveLength(1);
    expect(secretRows.rows[0]?.kid).toBe("k1");
    expect(secretRows.rows[0]?.ciphertext.toString("utf8")).not.toContain(liveSecret);

    const cfgA = await httpJson(`${pod1.addr.url}/rpc`, {
      method: "POST",
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      body: {
        id: 2,
        method: "project/configure",
        params: {
          projectId: "proj-a",
          workspacePath: workspaceA,
          kind: "virtual",
          enabledPlugins: ["vfs-plugin"],
          pluginConfigs: {
            "vfs-plugin": {
              rootLabel: "tenant-a-vfs",
              files: { "notes/secret.txt": "TENANT_A_VFS_PAYLOAD" },
            },
          },
        },
      },
    });
    expect(cfgA.status).toBe(200);

    const wsAKernel = await openWsClient(`${pod1.addr.wsUrl}/kernel`, {
      origin: allowedOrigin,
      authorization: "Bearer token-a",
    });
    onTestFinished(() => wsAKernel.close());
    wsAKernel.sendFrame({
      kind: "presence/update",
      entries: [[1, { seat: { sessionId: "sess-a" } }, 1]],
    });

    const wsA = await openWsClient(
      `${pod1.addr.wsUrl}/session?path=${encodeURIComponent(workspaceA)}&sessionId=sess-a`,
      { origin: allowedOrigin, authorization: "Bearer token-a" },
    );
    onTestFinished(() => wsA.close());
    wsA.sendFrame({
      kind: "shape/subscribe",
      subscriptionId: "sub-a",
      lane: "session_nodes",
      params: { sessionId: "sess-a" },
    });
    wsA.sendFrame({
      kind: "shape/subscribe",
      subscriptionId: "asks-a",
      lane: "pending_asks",
      params: { sessionId: "sess-a" },
    });
    await waitUntil(() => wsA.deltas.length > 0, 5_000, "pod1 initial session_nodes delta");

    await wsA.request("kv/set", { key: "connection", value: connId });
    await wsA.request("kv/set", { key: "model", value: "m1" });
    await expect(wsA.request("turn", { prompt: "Read notes/secret.txt" })).resolves.toEqual({ ok: true });

    await waitUntil(
      () => wsA.deltas.some((delta) => delta.subscriptionId === "asks-a" && delta.upserts.length > 0),
      10_000,
      "pod1 pending_asks delta",
    );
    const askRow = wsA.deltas.find((delta) => delta.subscriptionId === "asks-a" && delta.upserts.length > 0)
      ?.upserts[0];
    expect(askRow?.kernelId).toBe("kernel-a");
    await expect(
      wsA.request("ask/answer", { sessionId: "sess-a", jobId: String(askRow?.jobId ?? ""), allow: true }),
    ).resolves.toMatchObject({ ok: true });

    await waitUntil(() => compat.posts.length >= 2, 10_000, "pod1 2 compat rounds");
    let sessAState: {
      status: number;
      json: { session?: { sessionId?: string; running?: boolean }; nodes?: unknown[] };
    } = {
      status: 0,
      json: {},
    };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      sessAState = (await httpJson(`${pod1.addr.url}/sessions/sess-a`, {
        headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      })) as typeof sessAState;
      if (sessAState.status === 200 && sessAState.json.session?.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(sessAState.status).toBe(200);
    expect(sessAState.json.session?.sessionId).toBe("sess-a");
    expect(sessAState.json.session?.running).toBe(false);
    expect(JSON.stringify(sessAState.json.nodes)).toContain("TENANT_A_VFS_PAYLOAD");
    expect(JSON.stringify(sessAState.json.nodes)).toContain("TENANT_A_PG_ROUND_1");
    expect(compat.requestHeaders.length).toBeGreaterThanOrEqual(2);
    expect(compat.requestHeaders.every((h) => h.authorization === `Bearer ${liveSecret}`)).toBe(true);

    const listA = await httpJson(`${pod1.addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
    });
    expect(listA.status).toBe(200);
    expect(JSON.stringify(listA.json)).toContain("sess-a");

    // Cross-tenant isolation: Tenant B receives 404 on Tenant A's session and an empty list.
    const cfgB = await httpJson(`${pod1.addr.url}/rpc`, {
      method: "POST",
      headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
      body: {
        id: 3,
        method: "project/configure",
        params: {
          projectId: "proj-b",
          workspacePath: workspaceB,
          kind: "virtual",
          enabledPlugins: ["vfs-plugin"],
          pluginConfigs: { "vfs-plugin": { rootLabel: "tenant-b-vfs", files: { "other.txt": "B" } } },
        },
      },
    });
    expect(cfgB.status).toBe(200);

    const crossGet = await httpJson(`${pod1.addr.url}/sessions/sess-a`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
    });
    expect(crossGet.status).toBe(404);
    const listB = await httpJson(`${pod1.addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
    });
    expect(listB.status).toBe(200);
    expect(JSON.stringify(listB.json)).not.toContain("sess-a");

    await wsA.close();
    await wsAKernel.close();
    await pod1.dispose();

    // --- Pod 2: brand new stateless process against same PostgreSQL schemas with empty RAM ---
    const pod2 = await startPod();
    onTestFinished(() => pod2.dispose());

    const coldGetA = (await httpJson(`${pod2.addr.url}/sessions/sess-a`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
    })) as typeof sessAState;
    expect(coldGetA.status).toBe(200);
    expect(coldGetA.json.session?.sessionId).toBe("sess-a");
    expect(coldGetA.json.session?.running).toBe(false);
    expect(JSON.stringify(coldGetA.json.nodes)).toContain("TENANT_A_VFS_PAYLOAD");
    expect(JSON.stringify(coldGetA.json.nodes)).toContain("TENANT_A_PG_ROUND_1");

    const coldListA = await httpJson(`${pod2.addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
    });
    expect(coldListA.status).toBe(200);
    expect(JSON.stringify(coldListA.json)).toContain("sess-a");

    const wsA2 = await openWsClient(
      `${pod2.addr.wsUrl}/session?path=${encodeURIComponent(workspaceA)}&sessionId=sess-a`,
      { origin: allowedOrigin, authorization: "Bearer token-a" },
    );
    onTestFinished(() => wsA2.close());
    wsA2.sendFrame({
      kind: "shape/subscribe",
      subscriptionId: "sub-a-cold",
      lane: "session_nodes",
      params: { sessionId: "sess-a" },
    });
    await waitUntil(() => wsA2.deltas.length > 0, 5_000, "pod2 cold rehydrated session_nodes delta");

    // Second turn on cold Pod 2 must decrypt the persisted API key via warm() without re-adopting.
    await wsA2.request("turn", { prompt: "Continue on pod 2" });
    await waitUntil(() => compat.posts.length >= 3, 10_000, "pod2 3rd compat round");

    let pod2SessState: typeof sessAState = { status: 0, json: {} };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      pod2SessState = (await httpJson(`${pod2.addr.url}/sessions/sess-a`, {
        headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      })) as typeof sessAState;
      if (
        pod2SessState.status === 200 &&
        pod2SessState.json.session?.running === false &&
        JSON.stringify(pod2SessState.json.nodes).includes("COLD_POD2_DONE")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(pod2SessState.status).toBe(200);
    expect(pod2SessState.json.session?.running).toBe(false);
    expect(JSON.stringify(pod2SessState.json.nodes)).toContain("COLD_POD2_DONE");
    expect(compat.requestHeaders.length).toBeGreaterThanOrEqual(3);
    expect(compat.requestHeaders.every((h) => h.authorization === `Bearer ${liveSecret}`)).toBe(true);
  }, 20_000);
});
