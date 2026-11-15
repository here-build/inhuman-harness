# Portable Multi-Tenant Server Installation Guide

This guide describes how to deploy `@inhuman.tools/harness/server` as a **stateless, horizontally scalable** multi-tenant agent backend backed by **PostgreSQL**, **ElectricSQL**, **Hono**, **Caddy**, and S3-compatible object storage.

---

## 1. Architecture Overview (`"server"` vs `"local"` Contour)

`@inhuman.tools/harness` runs in two symmetric contours sharing the same session runtime, turn loop, LiveShape state plane, and JSON-RPC contract:

| Capability | `"local"` contour (`HarnessDaemon`) | `"server"` contour (`createPortableHarnessServer` / `MultiKernelRegistry`) |
| --- | --- | --- |
| Primary transport | UNIX domain socket + loopback HTTP/WS | Portable HTTP + WebSocket server + `MultiKernelRegistry` |
| Kernel multiplicity | Single host kernel (`kernelId: "local"`) | Pooled stateless in-memory kernels keyed by `kernelId`, bound 1:1 to `tenantId` |
| Persistence backend | `@inhuman.tools/scope-plane-sqlite` (`node:sqlite`, local `.db`) | `@inhuman.tools/scope-plane-postgres` (`pgPoolDriver` + PostgreSQL) |
| Reactive read plane | `CommitDiffShapeSource` (commit diffs over WebSocket) | `CommitDiffShapeSource` (active turn WS) + `@inhuman.tools/scope-plane-electric` (HTTP shapes via ElectricSQL) |
| Filesystem watcher (`KernelReflector`) | Watches local user directory & `.scm` files | **Disabled**; Scheme policy and compaction resources live in `scm_resources` DB rows |
| Local `FS` / `shell` plugin | Enabled by default | **Disabled** unless explicitly enabled per project; `plugin/install` RPC is rejected |
| Host plugins | Loaded per workspace/install | Pre-warmed once in `HostRuntimePluginCatalog` (`0` disk reads per kernel boot) |
| Lifecycle & eviction | Resident daemon process | `KernelLease` ref-counting + `idleEvictMs` + `Symbol.dispose` / `Symbol.asyncDispose` |

---

## 2. Driver-Agnostic Storage & Reactive Stream Contracts

All storage and replication layers are split behind two driver-agnostic contracts exported by `@inhuman.tools/scope-plane`:

1. **Ordered KV + Atomic Batch Contract (`HarnessKvStore`)**
   - Models the 11 harness spaces as an ordered key-value store with atomic cross-table `batch()`, prefix/range scans (`scan()`, `count()`), and `sessions` delete cascading (`SESSION_CASCADE_TABLES`).
   - Mutating operations return a `CommitDiff` describing exact per-table upserts and deletes, decoupling runtime state from SQLite or PostgreSQL specifics.
   - Implementations:
     - **Server (stateless)**: `PostgresKvStore` in `@inhuman.tools/scope-plane-postgres`
     - **Local CLI**: `SqliteKvStore` in `@inhuman.tools/scope-plane-sqlite` (built on Node's built-in `node:sqlite`, zero native C++ addons)
     - **Unit & gateway tests**: `MemoryKvStore` in `@inhuman.tools/scope-plane`
   - Any custom adapter can be verified with `runHarnessKvComplianceSuite` from `@inhuman.tools/scope-plane/testing`.

2. **Reactive Stream Contract (`ShapeSource` & `LiveShape`)**
   - `ShapeSource` abstracts resumable offset-ordered lane subscriptions (`recent_sessions`, `sessions`, `scope_nodes`, `session_nodes`, `pending_asks`) and cold snapshots (`evaluateLane()`).
   - **Active turns over WebSocket**: `CommitDiffShapeSource` turns `HarnessKvStore` commit diffs into filtered `LiveShape` delta frames (`shape/delta`).
   - **Durable UI lists & cold catch-up**: `@inhuman.tools/scope-plane-electric` provides `ElectricShapeSource`, `compileElectricLaneQuery`, and `subscribeElectricLiveShape` backed by PostgreSQL logical replication and ElectricSQL `/v1/shape` HTTP streams.

---

## 3. Three-Database Isolation Model

Production deployments separate product transactional data, high-frequency agent state, and provider credentials:

1. **Product Database (PostgreSQL)**
   - Owned by your host application (`Hono` gateway + domain services).
   - Stores users, tenants/workspaces, roles/memberships, domain records, and external session identifiers.
   - Stores **no** agent prompt history, runtime KV state, or encrypted model credentials.

2. **Dedicated Control / Agent Schema (`harness.*` in PostgreSQL)**
   - Provision a dedicated PostgreSQL schema (or dedicated database host) and apply `HARNESS_POSTGRES_DDL` exported from `@inhuman.tools/harness-contract/schema` (also bootstrapped idempotently by `await db.bootstrap()`).
   - Canonical 11 `kernel_id`-partitioned tables:
     `kernel_state`, `projects`, `scope_nodes`, `sessions`, `pending_asks`, `session_turns`, `session_nodes`, `session_effects`, `session_blobs`, `scm_resources`, and `plugin_state_logs`.
   - All WAL-replicated tables configure `REPLICA IDENTITY FULL` so ElectricSQL `/v1/shape` streams carry complete row values across filtered predicates (`WHERE kernel_id = $1 ...`).
   - Zero local SQLite files or ephemeral disk state are required on agent pods: any pod can evict a kernel or restart cold and rehydrate transparently from PostgreSQL.

3. **Dedicated Secrets Storage (`vault.harness_connection_secrets` in PostgreSQL)**
   - Separate storage schema holding AES-256-GCM encrypted provider API keys and integration tokens, isolated from agent `sessions` / `session_nodes` / `LiveShape` streams.
   - `PostgresSecretsBackend` (`@inhuman.tools/scope-plane-postgres`) implements `AsyncSecretsStoreBackend` over table `"<schema>"."harness_connection_secrets"`:
     - Primary key: `(tenant_id, kernel_id, connection_id)`
     - Envelope columns: `kid TEXT`, `iv BYTEA`, `auth_tag BYTEA`, `ciphertext BYTEA`, `updated_at_ms BIGINT`
   - `EncryptedSecretsVault` binds canonical Additional Authenticated Data (`encodeCanonicalAad(tenantId, kernelId, connectionId)`) to prevent cross-tenant or cross-connection ciphertext transplant attacks, supports key rotation via `SecretsKeyRing`, and stays safe under synchronous runtime access:
     - `KernelDaemon` automatically calls `await secrets.warm()` during kernel acquisition/boot so in-turn `readConnectionSecrets()` calls remain synchronous.
     - Writes enqueue ordered async write-through persistence and drain via `await secrets.flush()` during graceful disposal.
     - Key rotation re-wraps persisted records cleanly via `await vault.rewrapAllAsync()`.

---

## 4. Packages & Runtime Prerequisites

- **Node.js**: `>= 22` (native `AsyncDisposable` / `Symbol.asyncDispose`, `node:crypto`, and built-in `node:sqlite` for local CLI workflows; zero `better-sqlite3` native builds on server pods).

### Server service dependencies

- `@inhuman.tools/harness` (`@inhuman.tools/harness/server` exports `createPortableHarnessServer`, `MultiKernelRegistry`, `HostRuntimePluginCatalog`, `EncryptedSecretsVault`, `MemorySecretsBackend`, `MemorySecretsVault`, `SecretsAuthError`, `encodeCanonicalAad`, `CommitDiffShapeSource`, `MemoryKvStore`, `AsyncCachedBlobBucket`, `MemoryAsyncBlobBucket`, `blobKeyOf`, `sha256OfBlobKey`, `DriverRegistry`, `openDriverRegistry`, `PRODUCT_PROVIDERS`, `viewWire`, `toolsFor`, `completionCatalogOf`, and `liveToolDescriptionOf`)
- `@inhuman.tools/scope-plane` (`HarnessKvStore`, `ShapeSource`, `CommitDiffShapeSource`, `LiveShape`, `MemoryKvStore`)
- `@inhuman.tools/scope-plane-postgres` (`pgPoolDriver`, `PostgresKvStore`, `PostgresSecretsBackend`)
- `@inhuman.tools/scope-plane-electric` (when reading shapes directly from ElectricSQL in backend/worker processes)
- `@inhuman.tools/harness-contract` (`HARNESS_POSTGRES_DDL`, `bootstrapHarnessPostgresSql`)
- `@inhuman.tools/harness-model` (`SessionDocument`)
- `@inhuman.tools/model` (`DocumentContainer`)
- `@inhuman.tools/plugin-sdk` (`InhumanPlugin`, `defineTool`, `WorkspaceEnvPort`)
- `pg` (`>= 8`)

### Browser client dependencies

- `@inhuman.tools/harness-peer` (`RoomConnection`, `SessionDocument`, `bindJsonRpc`, `publishKernelSeat`, `waitForSync`)
- `@inhuman.tools/harness-client`
- `@inhuman.tools/harness-contract`
- `@inhuman.tools/harness-model`
- `@inhuman.tools/scope-plane` & `@electric-sql/client` (with `@inhuman.tools/scope-plane-electric`'s `subscribeElectricLiveShape` if subscribing to Electric `/v1/shape` directly)

> [!NOTE]
> Keep the `@inhuman.tools/harness/server` service decoupled from heavy frontend bundles and unrelated domain schemas. Authenticate requests at the Hono edge gateway against PostgreSQL, forward signed verified headers, and leave tenant business logic in external plugins or gateway services.

---

## 5. Curating Host Plugins & Virtual Workspaces

In the `"server"` contour, tenant users cannot execute arbitrary local disk code or call `plugin/install`. Register curated plugins once at startup via `HostRuntimePluginCatalog`:

1. **Seed packages**: `includeSeedPackages: true` preloads bundled runtime plugins from immutable memory caches (`0` per-kernel disk I/O).
2. **Custom server `InhumanPlugin` extensions**: implement domain capabilities (virtual document collections, cloud storage, SQL query tools, remote APIs, or VM bridges) via `@inhuman.tools/plugin-sdk`.
3. **Virtual workspaces via `WorkspaceEnvPort`**: return `{ workspaceEnv }` from `activateProject(ctx, config)` so path resolution and write-admission policy validate against a logical root without probing the container filesystem.

```ts
import { defineTool, InhumanPlugin, type WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

const virtualDocsConfig = z.object({
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
});

function createVirtualEnv(logicalRoot: string): WorkspaceEnvPort {
  return {
    logicalRoot,
    resolveCanonicalPathSync(rawPath) {
      const normalized = rawPath.replace(/^\/+/, "");
      if (normalized.includes("..")) return null;
      return `${logicalRoot}/${normalized}`;
    },
    probeWriteTarget(rawPath) {
      const canonicalPath = rawPath.includes("..") ? undefined : rawPath;
      return { exists: false, isDirectory: false, canonicalPath };
    },
  };
}

export const virtualDocsPlugin = new InhumanPlugin({
  projectConfigSchema: virtualDocsConfig,
  activateProject(ctx, cfg) {
    return {
      workspaceEnv: createVirtualEnv(ctx.workspacePath),
      tools: [
        defineTool({
          name: "doc_read",
          description: "Read a document from the tenant's virtual workspace.",
          class: "read",
          representation: "tool",
          // Pitfall: avoid naming an argument `file`; OpenAI-compatible normalization aliases `file` -> `path`.
          input: z.object({ path: z.string().min(1) }),
          output: z.object({ content: z.string(), revision: z.number() }),
          async run({ path }) {
            return await loadDocumentFromStore(cfg.tenantId, cfg.workspaceId, path);
          },
        }),
      ],
    };
  },
});
```

---

## 6. Bootstrapping Stateless `createPortableHarnessServer` over PostgreSQL

The entry point below mounts a stateless HTTP + WebSocket server backed by `pg.Pool`, `PostgresKvStore`, `PostgresSecretsBackend`, `CommitDiffShapeSource`, `MultiKernelRegistry`, warmed plugins, and bounded S3 blob caching:

```ts
import {
  AsyncCachedBlobBucket,
  CommitDiffShapeSource,
  createPortableHarnessServer,
  EncryptedSecretsVault,
  HostRuntimePluginCatalog,
  MultiKernelRegistry,
  type SecretsKeyRing,
} from "@inhuman.tools/harness/server";
import { pgPoolDriver, PostgresKvStore, PostgresSecretsBackend } from "@inhuman.tools/scope-plane-postgres";
import { Pool } from "pg";

// 1. PostgreSQL pool shared across the stateless pod (bootstrap DDL idempotently or via migrations)
const pool = new Pool({
  connectionString: process.env.AGENT_DATABASE_URL!,
  max: Number(process.env.AGENT_PG_POOL_MAX ?? 16),
});
const driver = pgPoolDriver(pool);

const agentDb = new PostgresKvStore(driver, { schema: process.env.AGENT_DB_SCHEMA ?? "harness" });
await agentDb.bootstrap();
const laneHub = new CommitDiffShapeSource(agentDb);

// 2. Encrypted PostgreSQL Secrets DB + 32-byte AES-256-GCM keyring loaded from KMS/env
const secretsBackend = new PostgresSecretsBackend(driver, { schema: process.env.AGENT_SECRETS_SCHEMA ?? "vault" });
await secretsBackend.bootstrap();

const keyRing: SecretsKeyRing = {
  activeKid: process.env.AGENT_SECRETS_ACTIVE_KID ?? "k1",
  keys: {
    k1: Buffer.from(process.env.AGENT_SECRETS_KEY_K1_HEX!, "hex"), // exact 32 bytes (64 hex chars)
  },
};

// 3. Warm bundled + host plugins once before accepting traffic
const catalog = await new HostRuntimePluginCatalog({
  includeSeedPackages: true,
  runtimePlugins: {
    "virtual-docs": virtualDocsPlugin,
  },
}).warm();

// 4. Pooled per-kernel registry with idle eviction (stateless: RAM only caches active leases)
const blobBuckets: AsyncCachedBlobBucket[] = [];
const registry = new MultiKernelRegistry({
  db: agentDb,
  ownsDb: true,
  laneHub,
  ownsLaneHub: true,
  idleEvictMs: 10 * 60_000,
  ...catalog.kernelOptions(),
  createSecretsVault(kernelId) {
    const [tenantId] = kernelId.split(":", 1);
    return new EncryptedSecretsVault({
      backend: secretsBackend,
      keyRing,
      tenantId: tenantId!,
      kernelId,
      ownsBackend: false,
    });
  },
  createBlobBucket(kernelId) {
    const [tenantId] = kernelId.split(":", 1);
    const cache = new AsyncCachedBlobBucket({
      // Scope S3 keys strictly by tenantId (for example `tenants/<tenantId>/blobs/<sha256>`).
      remote: createObjectStorageBlobBucket({ prefix: `tenants/${tenantId}/blobs/` }),
      maxCacheBytes: 64 * 1024 * 1024,
    });
    blobBuckets.push(cache);
    return cache;
  },
});

// 5. Portable HTTP + WebSocket server
const server = createPortableHarnessServer({
  registry,
  ownsRegistry: true,
  allowedOrigins: [process.env.PUBLIC_ORIGIN!],
  async authenticate(req) {
    // Verify a shared gateway secret (timing-safe) alongside verified Hono headers.
    const tenantId = req.headers["x-verified-tenant-id"];
    const userId = req.headers["x-verified-user-id"];
    if (typeof tenantId !== "string" || !tenantId || typeof userId !== "string" || !userId) {
      return null;
    }
    return {
      tenantId,
      kernelId: `${tenantId}:${userId}`,
      subjectId: userId,
    };
  },
});

const address = await server.listen(Number(process.env.HARNESS_PORT ?? 8799), "127.0.0.1");
console.log(`Portable harness server listening on ${address.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await server[Symbol.asyncDispose](); // drains active kernels, flushes PostgresKvStore & secrets
      await Promise.allSettled(blobBuckets.map((bucket) => bucket[Symbol.asyncDispose]()));
      await secretsBackend.close();
      await pool.end();
    })().finally(() => process.exit(0));
  });
}
```

> [!TIP]
> For unit and gateway tests that do not need a PostgreSQL server, substitute `MemoryKvStore` + `MemorySecretsBackend` behind the exact same `MultiKernelRegistry` and `createPortableHarnessServer` API.

### Exposed Server Endpoints

| Route | Protocol | Purpose |
| --- | --- | --- |
| `GET /healthz` | HTTP | Unauthenticated liveness probe (`{ ok: true }`, still checks `allowedOrigins` if `Origin` header is present) |
| `GET /sessions?limit=&projectId=&workspacePath=` | HTTP | Cold/SSR list of recent sessions evaluated from `recent_sessions` lane for the authenticated kernel |
| `GET /sessions/:sessionId` | HTTP | Session snapshot (`sessions` row + `session_nodes` rows) or `404` if owned by another kernel |
| `POST /rpc` | HTTP | JSON-RPC call `{ id, method, params, scope }` (`kernel` \| `project` \| `session`) |
| `/kernel` | WebSocket | Kernel-plane JSON-RPC, presence (`seat` awareness), and kernel-scoped `LiveShape` subscriptions |
| `/project?path=...` | WebSocket | Project-plane JSON-RPC and `scope_nodes` subscriptions |
| `/session?path=...&sessionId=...` | WebSocket | Session-plane JSON-RPC (`turn`, `turn/cancel`, `ask/answer`, `kv/set`, `blob/get`) and `session_nodes` stream |

---

## 7. Edge, ElectricSQL & Gateway Topology (Caddy + Hono + PostgreSQL)

### Why Caddy sits at the edge

Browser tabs keep ElectricSQL `/v1/shape` streams, HTTP API calls, and WebSocket rooms (`/kernel`, `/session`) open on the same origin. Serving the browser over HTTP/1.1 limits browsers to 6 TCP connections per origin and causes head-of-line stalls. Place **Caddy** in front for TLS termination and HTTP/2 + WebSocket pass-through:

```caddyfile
https://app.example.com {
  handle /api/tenants/*/agent/* {
    # Proxy both HTTP RPC/session calls and WebSocket upgrades through the Hono auth gateway
    reverse_proxy 127.0.0.1:8788
  }

  handle /v1/shape* {
    # Proxy browser ElectricSQL shape requests through the auth gateway so tenant WHERE filters stay server-enforced
    reverse_proxy 127.0.0.1:8788
  }

  handle /api/* {
    reverse_proxy 127.0.0.1:8788
  }

  handle {
    reverse_proxy 127.0.0.1:5173
  }
}
```

### Hono Gateway Pattern (Auth, Membership, WebSocket & Electric Shape Proxying)

Browser `WebSocket` and `EventSource` / `ShapeStream` requests rely on cookies or URL parameters for auth rather than trusted identity headers. Always authenticate the caller in **Hono** against **PostgreSQL**, verify active tenant membership, strip client-supplied internal headers, inject a shared `x-agent-gateway-secret` + verified `x-verified-tenant-id` / `x-verified-user-id`, and enforce single-table `WHERE` predicates when proxying ElectricSQL shapes (`harness.sessions`, `harness.session_nodes`, etc.):

```ts
import { Hono } from "hono";

// 1. Always strip inbound x-verified-* and x-agent-gateway-* headers before setting your own.
// 2. Verify session cookie + active non-guest tenant role in PostgreSQL on HTTP requests,
//    WebSocket upgrades, and ElectricSQL shape proxy requests.
// 3. Revalidate membership periodically or on logout / role downgrade and close active sockets.

export function registerAgentGatewayRoutes(app: Hono, harnessOrigin: string, gatewaySecret: string) {
  app.all("/api/tenants/:tenantId/agent/*", async (c) => {
    const tenantId = c.req.param("tenantId");
    const session = await verifyUserAndTenantInPostgres(c.req.raw.headers, tenantId);
    if (!session) return c.json({ error: "Unauthorized or forbidden" }, 401);

    const url = new URL(c.req.url);
    const strippedPath = url.pathname.replace(`/api/tenants/${tenantId}/agent`, "") || "/";
    const upstreamHeaders = new Headers(c.req.raw.headers);
    upstreamHeaders.delete("x-verified-tenant-id");
    upstreamHeaders.delete("x-verified-user-id");
    upstreamHeaders.delete("x-verified-kernel-id");
    upstreamHeaders.set("x-agent-gateway-secret", gatewaySecret);
    upstreamHeaders.set("x-verified-tenant-id", tenantId);
    upstreamHeaders.set("x-verified-user-id", session.userId);

    return fetch(`${harnessOrigin}${strippedPath}${url.search}`, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      duplex: "half",
    } as RequestInit);
  });
}
```

For sidebar session lists powered by ElectricSQL directly from `harness.sessions`:

- Table: `harness.sessions` (control PostgreSQL database)
- `WHERE` predicate: `kernel_id = $1 and project_id = $2 and archived_at_ms is null and mode = 'assistant'`
- Bound params (server-injected, never client-supplied): `params[0] = "${tenantId}:${userId}"`, `params[1] = workspaceId`
- Columns read by clients: `session_id`, `title`, `last_active_at_ms` (Unix epoch ms), `running` (`boolean`).

> [!WARNING]
> Always strip `x-verified-*` and `x-agent-gateway-secret` from untrusted external requests in Hono/Caddy, verify the shared gateway secret on the harness server with constant-time comparison, and bind `createPortableHarnessServer` strictly to `127.0.0.1` or a private VPC interface.

---

## 8. Provisioning Connections & Virtual Projects via JSON-RPC

Before running turns in a tenant workspace, provision:

1. **Model connection (secrets go directly to `EncryptedSecretsVault` -> PostgreSQL `vault`)**:
   `POST /rpc` with `scope: { kind: "kernel" }`:
   ```json
   {
     "id": 1,
     "method": "connect/adopt",
     "params": {
       "driver": "openai-compat",
       "name": "Primary LLM",
       "settings": { "baseUrl": "https://llm-gateway.internal/v1" },
       "secrets": { "apiKey": "sk-..." }
     }
   }
   ```
   Returns `{ result: { id: "<connectionId>" } }`. Never store provider secrets inside `kernel_state.kvs_json`, `projects.kvs_json`, or `session_nodes`.

2. **Virtual workspace overlay (`Project.pluginConfigs`)**:
   `POST /rpc` with `scope: { kind: "kernel" }`:
   ```json
   {
     "id": 2,
     "method": "project/configure",
     "params": {
       "projectId": "ws-42",
       "workspacePath": "/virtual/tenant-a/ws-42",
       "kind": "virtual",
       "title": "Workspace 42",
       "enabledPlugins": ["virtual-docs", "tasks"],
       "pluginConfigs": {
         "virtual-docs": { "tenantId": "tenant-a", "workspaceId": "ws-42" }
       }
     }
   }
   ```

---

## 9. Browser Client Integration (`@inhuman.tools/harness-peer` & `LiveShape`)

Client documents mirror server `session_nodes` via `ShapeDeltaFrame` (`LiveShape`) and enforce read-only immutability in the browser (`ReadOnlyDocumentError` on accidental local mutations).

```ts
import "@inhuman.tools/harness-model/register";
import {
  bindJsonRpc,
  bindRoomAwareness,
  createDoc,
  destroyRoomConnection,
  KERNEL_DOC_GUID,
  publishKernelSeat,
  RoomConnection,
  SessionDocument,
  waitForSync,
} from "@inhuman.tools/harness-peer";

export async function openRemoteAgentSession(wsOrigin: string, workspacePath: string, sessionId: string) {
  // 1. Kernel room: publish a presence seat so any stateless pod attaches and keeps this session active
  //    while the tab stays open. Closing the WebSocket removes the seat and permits idle eviction.
  const kernelDoc = createDoc({ guid: KERNEL_DOC_GUID });
  const kernelConn = new RoomConnection(wsOrigin, "kernel", kernelDoc);
  await waitForSync(kernelConn, "kernel", 8_000);
  publishKernelSeat(kernelConn.awareness, sessionId);

  // 2. Session room: node deltas + JSON-RPC share one WebSocket.
  const sessionRaw = createDoc({ guid: `harness:session:${sessionId}` });
  const sessionConn = new RoomConnection(wsOrigin, "session", sessionRaw, {
    params: { path: workspacePath, sessionId },
  });
  await waitForSync(sessionConn, "session", 8_000);

  const doc = SessionDocument.connect(sessionRaw, { readOnly: true });
  const rpc = bindJsonRpc(sessionConn);
  const stopAwareness = bindRoomAwareness(doc.awareness, sessionConn);

  return {
    doc,
    root: doc.root, // MobX-reactive SessionRoot for transcript & status rendering
    rpc,
    async sendTurn(prompt: string, connectionId: string, model: string) {
      await rpc.request("kv/set", { key: "connection", value: connectionId });
      await rpc.request("kv/set", { key: "model", value: model });
      return rpc.request("turn", { prompt });
    },
    async answerAsk(jobId: string, allow: boolean, comment?: string) {
      return rpc.request("ask/answer", { sessionId, jobId, allow, comment });
    },
    dispose() {
      publishKernelSeat(kernelConn.awareness, null);
      stopAwareness();
      destroyRoomConnection(sessionConn);
      destroyRoomConnection(kernelConn);
      doc.destroy();
      kernelDoc.destroy();
    },
  };
}
```

To receive live approval prompts (`pending_asks`) or sidebar session updates (`recent_sessions`) during active connections, send `shape/subscribe` frames over the `/kernel` or `/session` socket. For cold/persistent list views outside an active socket, subscribe to ElectricSQL `harness.sessions`.

> [!NOTE]
> **0.3.x Compatibility & Async Flush Consistency**:
> - `@inhuman.tools/harness-model` (`./session` and `.`) retains `@deprecated export const SessionPlexus = SessionDocument` and `export type SessionPlexus = SessionDocument`, and `@inhuman.tools/turn/context` keeps `@deprecated export const projectHistory = projectModelHistory` for incremental migrations.
> - Custom completion drivers registered alongside `PRODUCT_PROVIDERS` via `openDriverRegistry` can import `viewWire`, `toolsFor`, `completionCatalogOf`, and `liveToolDescriptionOf` directly from `@inhuman.tools/harness/server`.
> - Under async `HarnessKvStore` backends such as `PostgresKvStore`, `DocumentContainer.commitSnapshot` marks only snapshotted node revisions committed so concurrent mutations applied while `db.batch()` is awaiting PostgreSQL are preserved cleanly for the next flush.

---

## 10. Security, Sizing & Operational Checklist

- **Origin & Tenant Binding**: Configure `allowedOrigins` in production. Once a `kernelId` binds to a `tenantId` inside `createPortableHarnessServer`, attempts by another tenant to claim the same `kernelId` fail with `403`.
- **Cross-Tenant Isolation**: Direct reads, RPC calls, or WS connects to another kernel's `sessionId` or `workspacePath` return `404`; attempting to spoof `params.kernelId` in `shape/subscribe` immediately closes the WebSocket with code `1008` (`forbidden kernel subscription`).
- **Key Rotation**: Add the new 32-byte key to `SecretsKeyRing.keys`, promote `activeKid` to the new key ID, deploy, run `await vault.rewrapAllAsync()` for active/migrated kernels, and retire the legacy key once all rows use the new `kid`.
- **PostgreSQL & ElectricSQL Readiness**: Ensure `wal_level = logical` is enabled on the control PostgreSQL server and run migrations/DDL (`HARNESS_POSTGRES_DDL` + `vault.harness_connection_secrets`) before starting `agent-harness` pods.
- **Memory Capacity Planning**:
  - Set `MultiKernelRegistry({ idleEvictMs })` so dormant kernels flush to PostgreSQL and release heap memory promptly.
  - Bound `AsyncCachedBlobBucket({ maxCacheBytes })` per kernel according to total pod RAM (`maxConcurrentKernels × maxCacheBytes` worst-case clean cache ceiling).
- **Liveness & Graceful Drain**: Point orchestrator readiness probes at `GET /healthz`. On `SIGTERM`, await `server[Symbol.asyncDispose]()` before closing `secretsBackend` and `pool.end()` so all dirty KV batches, encrypted secrets, and S3 blobs flush cleanly.
