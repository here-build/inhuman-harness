import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool, InhumanPlugin, type WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import { pluginDiskReadCount, resetPluginDiskReadCount } from "@/extensions";

import { blobKeyOf } from "../blobs/bucket.js";
import {
  AsyncCachedBlobBucket,
  createPortableHarnessServer,
  EncryptedSecretsVault,
  HostRuntimePluginCatalog,
  KernelDaemon,
  MemoryAsyncBlobBucket,
  MultiKernelRegistry,
  SecretsAuthError,
  type SecretsKeyRing,
  SqliteSecretsBackend,
} from "../portable-server.js";
import { MemorySecretsVault } from "../secrets.js";
import { listenCompat } from "../testkit/compat-server.js";

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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

type JsonRpcClient = {
  readonly ws: WebSocket;
  readonly deltas: Array<{
    readonly subscriptionId: string;
    readonly offset: number;
    readonly upserts: ReadonlyArray<Record<string, unknown>>;
    readonly deletes: readonly string[];
  }>;
  request(method: string, params?: unknown): Promise<unknown>;
  sendFrame(frame: Record<string, unknown>): void;
  waitClose(): Promise<number>;
  close(): Promise<void>;
};

async function openWsClient(url: string, headers: Record<string, string>): Promise<JsonRpcClient> {
  const ws = new WebSocket(url, { headers });
  const pending = new Map<
    string,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  const deltas: Array<{
    readonly subscriptionId: string;
    readonly offset: number;
    readonly upserts: ReadonlyArray<Record<string, unknown>>;
    readonly deletes: readonly string[];
  }> = [];
  let nextId = 1;
  const closed = Promise.withResolvers<number>();

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
          const errMsg = String((msg.error as Record<string, unknown>).message ?? "RPC error");
          waiter.reject(new Error(errMsg));
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
    closed.resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`Unexpected HTTP status ${res.statusCode ?? 0}`));
    });
  });

  return {
    ws,
    deltas,
    request(method: string, params: unknown = {}): Promise<unknown> {
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    sendFrame(frame: Record<string, unknown>): void {
      ws.send(JSON.stringify(frame));
    },
    waitClose(): Promise<number> {
      return closed.promise;
    },
    async close(): Promise<void> {
      if (ws.readyState === WebSocket.CLOSED) return;
      ws.close();
      await closed.promise;
    },
  };
}

async function expectWsRejected(url: string, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error(`Expected WS rejection for ${url}, but connection opened`));
    });
    ws.once("error", () => {
      /* unexpected-response handles handshake failure */
    });
  });
}

describe("Wave 5: EncryptedSecretsVault, HostRuntimePluginCatalog, AsyncCachedBlobBucket, and Portable Server E2E", () => {
  it("encrypts secrets in SQLite with AES-256-GCM, authenticates tenant/kernel AAD, detects tampering, and supports key rotation", () => {
    const dir = tempDir("w5-secrets-");
    const dbPath = join(dir, "secrets.db");
    const backend = new SqliteSecretsBackend(dbPath);
    onTestFinished(() => backend[Symbol.dispose]());

    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const keyRing1: SecretsKeyRing = { activeKid: "k1", keys: { k1 } };
    const vaultA = new EncryptedSecretsVault({
      backend,
      keyRing: keyRing1,
      tenantId: "tenant-a",
      kernelId: "kernel-a",
    });

    const plaintextSecret = "sk-super-secret-alpha-987654321";
    vaultA.writeConnectionSecrets("openai-1", { apiKey: plaintextSecret });
    vaultA.writeConnectionSecrets("openai-2", { token: "tok-rot-2" });

    expect(vaultA.readConnectionSecrets("openai-1")).toEqual({ apiKey: plaintextSecret });
    expect(backend.listConnectionIds("tenant-a", "kernel-a").sort()).toEqual(["openai-1", "openai-2"]);

    // Plaintext secret must never appear in raw SQLite row or on disk.
    const rawRow = backend.sqlite
      .prepare(
        "SELECT tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext FROM encrypted_connection_secrets WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?",
      )
      .get("tenant-a", "kernel-a", "openai-1") as {
      readonly kid: string;
      readonly iv: Buffer;
      readonly auth_tag: Buffer;
      readonly ciphertext: Buffer;
    };
    expect(rawRow.kid).toBe("k1");
    expect(rawRow.ciphertext.toString("utf8")).not.toContain(plaintextSecret);
    expect(readFileSync(dbPath, "utf8")).not.toContain(plaintextSecret);

    // Copy ciphertext envelope to tenant-b on the same kernel_id: canonical AAD must reject it.
    backend.sqlite
      .prepare(
        `INSERT INTO encrypted_connection_secrets (tenant_id, kernel_id, connection_id, kid, iv, auth_tag, ciphertext, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("tenant-b", "kernel-a", "openai-1", rawRow.kid, rawRow.iv, rawRow.auth_tag, rawRow.ciphertext, Date.now());
    const vaultB = new EncryptedSecretsVault({
      backend,
      keyRing: keyRing1,
      tenantId: "tenant-b",
      kernelId: "kernel-a",
    });
    expect(() => vaultB.readConnectionSecrets("openai-1")).toThrow(SecretsAuthError);

    // Tamper 1 byte in Tenant A's ciphertext: GCM auth tag verification must fail.
    const tampered = Buffer.from(rawRow.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    backend.sqlite
      .prepare(
        "UPDATE encrypted_connection_secrets SET ciphertext = ? WHERE tenant_id = ? AND kernel_id = ? AND connection_id = ?",
      )
      .run(tampered, "tenant-a", "kernel-a", "openai-1");
    expect(() => vaultA.readConnectionSecrets("openai-1")).toThrow(SecretsAuthError);

    // Delete tampered row, rotate remaining secrets from k1 -> k2, then drop k1 from keyring.
    vaultA.deleteConnectionSecrets("openai-1");
    expect(vaultA.readConnectionSecrets("openai-1")).toEqual({});

    const rotatingVault = new EncryptedSecretsVault({
      backend,
      keyRing: { activeKid: "k2", keys: { k1, k2 } },
      tenantId: "tenant-a",
      kernelId: "kernel-a",
    });
    expect(rotatingVault.rewrapAll()).toBe(1);

    const k2OnlyVault = new EncryptedSecretsVault({
      backend,
      keyRing: { activeKid: "k2", keys: { k2 } },
      tenantId: "tenant-a",
      kernelId: "kernel-a",
    });
    expect(k2OnlyVault.readConnectionSecrets("openai-2")).toEqual({ token: "tok-rot-2" });
  });

  it("warms HostRuntimePluginCatalog so server kernels boot with zero plugin disk reads and reject plugin/install", async () => {
    const dir = tempDir("w5-plugins-");
    const bundledDir = join(dir, "bundled-plugin");
    mkdirSync(join(bundledDir, "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(bundledDir, "package.json"), JSON.stringify({ name: "@test/w5-bundled", version: "0.1.0" }));
    writeFileSync(
      join(bundledDir, "plugin.json"),
      JSON.stringify({
        name: "w5-bundled",
        version: "0.1.0",
        description: "Wave 5 bundled test plugin",
        extensions: {
          "tools.inhuman": {
            skills: ["./skills/demo-skill"],
          },
        },
      }),
    );
    writeFileSync(join(bundledDir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\nHello\n");

    const catalog = await new HostRuntimePluginCatalog({
      bundledPlugins: [{ npmName: "@test/w5-bundled", rootPath: bundledDir }],
    }).warm();
    expect(catalog.warmed).toBe(true);
    expect(catalog.has("w5-bundled")).toBe(true);

    const db = new SqliteKvStore(join(dir, "harness.db"));
    onTestFinished(() => db.close());

    resetPluginDiskReadCount();
    const k1 = new KernelDaemon({
      contour: "server",
      kernelId: "srv-1",
      db,
      ownsDb: false,
      secrets: new MemorySecretsVault(),
      ...catalog.kernelOptions(),
    });
    onTestFinished(() => k1[Symbol.asyncDispose]());

    const k2 = new KernelDaemon({
      contour: "server",
      kernelId: "srv-2",
      db,
      ownsDb: false,
      secrets: new MemorySecretsVault(),
      ...catalog.kernelOptions(),
    });
    onTestFinished(() => k2[Symbol.asyncDispose]());

    await Promise.all([k1.ready, k2.ready]);
    expect(pluginDiskReadCount()).toBe(0);

    await expect(k1.handleRequest("plugin/install", { spec: bundledDir })).rejects.toThrow(/server contour/);
  });

  it("pins dirty blobs in AsyncCachedBlobBucket, enforces clean LRU maxCacheBytes on flush, and warms cold caches", async () => {
    const remote = new MemoryAsyncBlobBucket();
    const gate = Promise.withResolvers<void>();
    const gatedRemote = {
      async put(bytes: Uint8Array, mime: string) {
        await gate.promise;
        return await remote.put(bytes, mime);
      },
      get: (key: string) => remote.get(key),
      head: (key: string) => remote.head(key),
      delete: (key: string) => remote.delete(key),
      list: (options?: { readonly after?: string; readonly limit?: number }) => remote.list(options),
    };

    const cache = new AsyncCachedBlobBucket({ remote: gatedRemote, maxCacheBytes: 100 });
    onTestFinished(() => cache[Symbol.asyncDispose]());

    const b1 = new Uint8Array(60).fill(1);
    const b2 = new Uint8Array(60).fill(2);
    const b3 = new Uint8Array(60).fill(3);
    const r1 = cache.putSync(b1, "application/octet-stream");
    const b1First = b1[0];
    b1[0] = (b1First ?? 1) ^ 0xff; // Verify defensive copy inside putSync.
    const r2 = cache.putSync(b2, "application/octet-stream");
    const r3 = cache.putSync(b3, "application/octet-stream");

    const k1 = blobKeyOf(r1.sha256);
    const k2 = blobKeyOf(r2.sha256);
    const k3 = blobKeyOf(r3.sha256);

    // Dirty entries stay pinned above maxCacheBytes until remote upload completes.
    expect(cache.dirtyCount).toBe(3);
    expect(cache.cacheBytes).toBe(180);
    expect(cache.getSync(k1)?.[0]).toBe(1);
    expect(cache.getSync(k2)?.[0]).toBe(2);
    expect(cache.getSync(k3)?.[0]).toBe(3);

    gate.resolve();
    await cache.flush();

    expect(cache.dirtyCount).toBe(0);
    expect(cache.cacheBytes).toBe(60);
    expect(remote.size).toBe(3);
    expect(cache.getSync(k1)).toBeNull();
    expect(cache.getSync(k2)).toBeNull();
    expect(cache.getSync(k3)?.[0]).toBe(3);

    // Cold cache misses sync read until warm([k1]) fetches from async remote.
    const cold = new AsyncCachedBlobBucket({ remote, maxCacheBytes: 100 });
    onTestFinished(() => cold[Symbol.dispose]());
    expect(cold.getSync(k1)).toBeNull();
    await cold.warm([k1]);
    expect(cold.getSync(k1)?.[0]).toBe(1);
  });

  it("isolates tenants across HTTP, RPC, WebSocket, and LiveShape while decrypting secrets and supporting eviction/rehydration", async () => {
    const dir = tempDir("w5-e2e-");
    const db = new SqliteKvStore(join(dir, "harness.db"));
    onTestFinished(() => db.close());

    const secretsDbPath = join(dir, "secrets.db");
    const secretsBackend = new SqliteSecretsBackend(secretsDbPath);
    onTestFinished(() => secretsBackend[Symbol.dispose]());

    const masterKey = randomBytes(32);
    const keyRing: SecretsKeyRing = { activeKid: "k1", keys: { k1: masterKey } };
    const remoteBlobs = new MemoryAsyncBlobBucket();
    const blobBuckets: AsyncCachedBlobBucket[] = [];
    onTestFinished(async () => {
      await Promise.allSettled(blobBuckets.map((bucket) => bucket[Symbol.asyncDispose]()));
    });

    const vfsConfigSchema = z.object({
      rootLabel: z.string().min(1),
      files: z.record(z.string(), z.string()),
    });
    const vfsPlugin = new InhumanPlugin({
      projectConfigSchema: vfsConfigSchema,
      activateProject(ctx, rawConfig) {
        const cfg = vfsConfigSchema.parse(rawConfig);
        const env: WorkspaceEnvPort = {
          logicalRoot: ctx.workspacePath,
          resolveCanonicalPathSync: (target) => target,
          probeWriteTarget: (target) => {
            const rel = target.startsWith(`${ctx.workspacePath}/`)
              ? target.slice(ctx.workspacePath.length + 1)
              : target;
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

    const catalog = await new HostRuntimePluginCatalog({
      runtimePlugins: { "vfs-plugin": vfsPlugin },
    }).warm();

    const tenantByKernel = new Map<string, string>([
      ["kernel-a", "tenant-a"],
      ["kernel-b", "tenant-b"],
    ]);

    const registry = new MultiKernelRegistry({
      db,
      ownsDb: false,
      idleEvictMs: 50,
      ...catalog.kernelOptions(),
      createSecretsVault: (kernelId) =>
        new EncryptedSecretsVault({
          backend: secretsBackend,
          keyRing,
          tenantId: tenantByKernel.get(kernelId) ?? kernelId,
          kernelId,
        }),
      createBlobBucket: () => {
        const cache = new AsyncCachedBlobBucket({ remote: remoteBlobs, maxCacheBytes: 1024 * 1024 });
        blobBuckets.push(cache);
        return cache;
      },
    });

    const tokens = new Map<string, { readonly tenantId: string; readonly kernelId: string }>([
      ["token-a", { tenantId: "tenant-a", kernelId: "kernel-a" }],
      ["token-b", { tenantId: "tenant-b", kernelId: "kernel-b" }],
      ["token-impostor", { tenantId: "tenant-c", kernelId: "kernel-a" }],
    ]);

    const server = createPortableHarnessServer({
      registry,
      allowedOrigins: ["https://app.example.com"],
      authenticate: (req) => {
        const auth = req.headers.authorization;
        if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
        return tokens.get(auth.slice("Bearer ".length)) ?? null;
      },
    });
    onTestFinished(() => server[Symbol.asyncDispose]());

    const compat = await listenCompat({
      models: [{ id: "m1" }],
      reply: (post) => {
        const body = post as { messages?: Array<{ role?: string; content?: string }> };
        const toolMsg = (body.messages ?? []).find((msg) => msg.role === "tool");
        if (toolMsg === undefined) {
          return {
            content: "",
            finish_reason: "tool_calls",
            tool_calls: [
              {
                id: "call_vfs_1",
                type: "function",
                function: { name: "vfs_read", arguments: JSON.stringify({ path: "secret.txt" }) },
              },
            ],
          };
        }
        return {
          content: `Verified tool output: ${String(toolMsg.content ?? "")}`,
          finish_reason: "stop",
        };
      },
    });
    onTestFinished(() => compat.close());

    const addr = await server.listen(0, "127.0.0.1");
    const allowedOrigin = "https://app.example.com";

    // 1. Health, Origin, Auth, and kernel-tenant binding checks.
    expect(await httpJson(`${addr.url}/healthz`)).toEqual({ status: 200, json: { ok: true } });
    expect((await httpJson(`${addr.url}/healthz`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await httpJson(`${addr.url}/sessions`, { headers: { origin: allowedOrigin } })).status).toBe(401);
    expect(
      (await httpJson(`${addr.url}/sessions`, { headers: { origin: allowedOrigin, authorization: "Bearer bad" } }))
        .status,
    ).toBe(401);

    // 2. Configure Tenant A connection with secret + virtual VFS project via POST /rpc.
    const liveSecret = "sk-live-tenant-a-secret-42";
    const adoptRes = await httpJson(`${addr.url}/rpc`, {
      method: "POST",
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      body: {
        id: 1,
        method: "connect/adopt",
        params: {
          driver: "openai-compat",
          name: "Work",
          settings: { baseUrl: compat.baseUrl },
          secrets: { apiKey: liveSecret },
        },
      },
    });
    expect(adoptRes.status).toBe(200);
    const adoptedId = String((adoptRes.json as { result: { id: string } }).result.id);
    expect(readFileSync(secretsDbPath, "utf8")).not.toContain(liveSecret);

    // Once kernel-a is bound to tenant-a, another tenant cannot bind to kernel-a.
    const impostorRes = await httpJson(`${addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-impostor" },
    });
    expect(impostorRes.status).toBe(403);

    const workspaceA = "/virtual/tenant-a/ws";
    const cfgRes = await httpJson(`${addr.url}/rpc`, {
      method: "POST",
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      body: {
        id: 2,
        method: "project/configure",
        params: {
          projectId: "proj-a",
          workspacePath: workspaceA,
          kind: "virtual",
          title: "Tenant A Virtual Repo",
          enabledPlugins: ["vfs-plugin"],
          pluginConfigs: {
            "vfs-plugin": {
              rootLabel: "tenant-a-vfs",
              files: { "secret.txt": "TENANT_A_VFS_PAYLOAD" },
            },
          },
        },
      },
    });
    expect(cfgRes.status).toBe(200);

    // 3. Connect Tenant A WebSocket to /kernel (seat presence) + /session, subscribe LiveShape, and run mocked-LLM turn with tool execution.
    const wsAKernel = await openWsClient(`${addr.wsUrl}/kernel`, {
      origin: allowedOrigin,
      authorization: "Bearer token-a",
    });
    onTestFinished(() => wsAKernel.close());
    wsAKernel.sendFrame({
      kind: "presence/update",
      entries: [[1, { seat: { sessionId: "sess-a" } }, 1]],
    });

    const wsA = await openWsClient(`${addr.wsUrl}/session?path=${encodeURIComponent(workspaceA)}&sessionId=sess-a`, {
      origin: allowedOrigin,
      authorization: "Bearer token-a",
    });
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

    await wsA.request("kv/set", { key: "connection", value: adoptedId });
    await wsA.request("kv/set", { key: "model", value: "m1" });
    await expect(wsA.request("turn", { prompt: "read secret.txt" })).resolves.toEqual({ ok: true });

    await waitUntil(
      () => wsA.deltas.some((delta) => delta.subscriptionId === "asks-a" && delta.upserts.length > 0),
      10_000,
      "Tenant A pending_asks delta",
    );
    const askRow = wsA.deltas.find((delta) => delta.subscriptionId === "asks-a" && delta.upserts.length > 0)
      ?.upserts[0];
    expect(askRow?.kernelId).toBe("kernel-a");
    await expect(
      wsA.request("ask/answer", { sessionId: "sess-a", jobId: String(askRow?.jobId ?? ""), allow: true }),
    ).resolves.toMatchObject({ ok: true });

    await waitUntil(
      () => wsA.deltas.some((delta) => JSON.stringify(delta.upserts).includes("Verified tool output")),
      10_000,
      "Tenant A shape/delta assistant response",
    );
    // Ensure session finishes running cleanly before inspecting HTTP & closing socket.
    let sessAState: { status: number; json: { session?: { running?: boolean }; nodes?: unknown[] } } = {
      status: 0,
      json: {},
    };
    await waitUntil(
      () => {
        return compat.posts.length >= 2;
      },
      10_000,
      "2 compat rounds",
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      sessAState = (await httpJson(`${addr.url}/sessions/sess-a`, {
        headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
      })) as typeof sessAState;
      if (sessAState.status === 200 && sessAState.json.session?.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(sessAState.status).toBe(200);
    expect(sessAState.json.session?.running).toBe(false);
    expect(JSON.stringify(sessAState.json.nodes)).toContain("TENANT_A_VFS_PAYLOAD");
    expect(compat.requestHeaders.length).toBeGreaterThanOrEqual(2);
    expect(compat.requestHeaders.every((h) => h.authorization === `Bearer ${liveSecret}`)).toBe(true);

    const listA = await httpJson(`${addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
    });
    expect(listA.status).toBe(200);
    expect(JSON.stringify(listA.json)).toContain("sess-a");

    // 4. Cross-tenant isolation: Tenant B must never see, query, subscribe, or open Tenant A resources.
    const workspaceB = "/virtual/tenant-b/ws";
    const cfgB = await httpJson(`${addr.url}/rpc`, {
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

    const listB = await httpJson(`${addr.url}/sessions`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
    });
    expect(listB).toEqual({ status: 200, json: { kernelId: "kernel-b", sessions: [] } });

    expect(
      (
        await httpJson(`${addr.url}/sessions/sess-a`, {
          headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await httpJson(`${addr.url}/rpc`, {
          method: "POST",
          headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
          body: { id: 4, method: "kv/get", params: { key: "model" }, scope: { kind: "session", sessionId: "sess-a" } },
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await httpJson(`${addr.url}/rpc`, {
          method: "POST",
          headers: { origin: allowedOrigin, authorization: "Bearer token-b" },
          body: { id: 5, method: "project/get", params: {}, scope: { kind: "project", path: workspaceA } },
        })
      ).status,
    ).toBe(404);

    await expect(
      expectWsRejected(`${addr.wsUrl}/session?sessionId=sess-a`, {
        origin: allowedOrigin,
        authorization: "Bearer token-b",
      }),
    ).resolves.toBe(404);

    await expect(
      expectWsRejected(`${addr.wsUrl}/session?path=${encodeURIComponent(workspaceB)}&sessionId=sess-a`, {
        origin: allowedOrigin,
        authorization: "Bearer token-b",
      }),
    ).resolves.toBe(404);

    // Tenant B subscribing without explicit kernelId gets 0 rows for Tenant A's sessionId.
    const wsBKernel = await openWsClient(`${addr.wsUrl}/kernel`, {
      origin: allowedOrigin,
      authorization: "Bearer token-b",
    });
    onTestFinished(() => wsBKernel.close());

    wsBKernel.sendFrame({
      kind: "shape/subscribe",
      subscriptionId: "probe-cross",
      lane: "session_nodes",
      params: { sessionId: "sess-a" },
    });
    await waitUntil(
      () => wsBKernel.deltas.some((d) => d.subscriptionId === "probe-cross"),
      5_000,
      "Tenant B zero-row initial delta",
    );
    const crossDelta = wsBKernel.deltas.find((d) => d.subscriptionId === "probe-cross");
    expect(crossDelta?.upserts).toEqual([]);

    // Tenant B attempting explicit kernelId: "kernel-a" must be closed with 1008 Policy Violation.
    const closePromise = wsBKernel.waitClose();
    wsBKernel.sendFrame({
      kind: "shape/subscribe",
      subscriptionId: "attack-kernel",
      lane: "session_nodes",
      params: { kernelId: "kernel-a", sessionId: "sess-a" },
    });
    await expect(closePromise).resolves.toBe(1008);

    // 5. Idle eviction & cold re-hydration from harness.db (seat disconnect auto-parks sess-a -> idle eviction).
    await wsAKernel.close();
    await wsA.close();
    await waitUntil(
      () => {
        void registry.evictIdleNow();
        return !registry.has("kernel-a");
      },
      2_000,
      "kernel-a idle eviction after last seat/WS disconnect",
    );
    expect(registry.has("kernel-a")).toBe(false);

    const rehydrated = await httpJson(`${addr.url}/sessions/sess-a`, {
      headers: { origin: allowedOrigin, authorization: "Bearer token-a" },
    });
    expect(rehydrated.status).toBe(200);
    expect(JSON.stringify(rehydrated.json)).toContain("TENANT_A_VFS_PAYLOAD");
  }, 30_000);
});
