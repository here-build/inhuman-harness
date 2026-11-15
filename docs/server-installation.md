# Portable Multi-Tenant Server Installation Guide

This guide describes how to deploy `@inhuman.tools/harness/server` as a portable multi-tenant agent backend alongside a web application fronted by **Caddy**, **Hono**, and **PostgreSQL**.

---

## 1. Architecture Overview (`"server"` vs `"local"` Contour)

`@inhuman.tools/harness` runs in two symmetric contours sharing the same session runtime, turn loop, LiveShape state plane, and JSON-RPC contract:

| Capability | `"local"` contour (`HarnessDaemon`) | `"server"` contour (`createPortableHarnessServer` / `MultiKernelRegistry`) |
| --- | --- | --- |
| Primary transport | UNIX domain socket + loopback HTTP/WS | Portable HTTP + WebSocket server + `MultiKernelRegistry` |
| Kernel multiplicity | Single host kernel (`kernelId: "local"`) | Pooled in-memory kernels keyed by `kernelId`, bound 1:1 to `tenantId` |
| Filesystem watcher (`KernelReflector`) | Watches `~/.harness` and local `.scm` files | **Disabled**; Scheme policy and compaction resources live in `scm_resources` DB rows |
| Local `FS` / `shell` plugin | Enabled by default | **Disabled** unless explicitly enabled per project; `plugin/install` RPC is rejected |
| Host plugins | Loaded per workspace/install | Pre-warmed once in `HostRuntimePluginCatalog` (`0` disk reads per kernel boot) |
| Lifecycle & eviction | Resident daemon process | `KernelLease` ref-counting + `idleEvictMs` + `Symbol.dispose` / `Symbol.asyncDispose` |

---

## 2. Three-Database Isolation Model

Production server deployments isolate state across three logical databases so high-frequency agent deltas, tenant application data, and encrypted credentials do not contend or share blast radius:

1. **Product Database (PostgreSQL)**
   - Owned by the host application (`Hono` gateway + domain services).
   - Stores users, tenants/workspaces, memberships/roles, domain entities, and pointers/IDs to agent sessions.
   - Stores **no** agent turn state, prompt history, or provider credentials used directly by the runtime.

2. **Dedicated Agent Database (`Agent DB`)**
   - Stores the canonical 11 `kernel_id`-partitioned harness tables:
     `kernel_state`, `projects`, `scope_nodes`, `sessions`, `pending_asks`, `session_turns`, `session_nodes`, `session_effects`, `scm_resources`, `kv_entries`, and `plugin_state`.
   - **Single-node stateful deployment (default)**: run `HarnessDatabase` + `UpdateLaneHub` (`@inhuman.tools/scope-plane/sqlite`) backed by local NVMe storage with SQLite WAL mode. A single process can pool many active kernels concurrently (`~0.43 MB` steady heap per active kernel and `>98%` reclamation on `evict()` in reference benchmarks).
   - **Dedicated PostgreSQL deployment (externalized Agent DB)**: provision a separate PostgreSQL instance (not shared with heavy product transactional tables) and apply `HARNESS_POSTGRES_DDL` exported from `@inhuman.tools/harness-contract/schema`. All replicated tables enable `REPLICA IDENTITY FULL` so ElectricSQL `/v1/shape` streams can fan out filtered tenant shapes (`WHERE kernel_id = ...`).

3. **Dedicated Secrets Database (`Secrets DB`)**
   - Physically separate storage backend holding encrypted model-provider keys and integration tokens, never exposed to SQLite/Postgres `Agent DB` projections or client `LiveShape` deltas.
   - `EncryptedSecretsVault` encrypts JSON secret payloads per `(tenantId, kernelId, connectionId)` using **AES-256-GCM**:
     - Fresh 12-byte random IV per write and 16-byte authentication tag.
     - Canonical length-prefixed Additional Authenticated Data (`encodeCanonicalAad(tenantId, kernelId, connectionId)`) preventing cross-tenant or cross-connection ciphertext transplant attacks.
     - Built-in `SecretsKeyRing` (`activeKid` + `keys` map of 32-byte keys) with zero-downtime key rotation via `vault.rewrapAll()`.
   - Use `SqliteSecretsBackend` on an isolated database file/volume, or implement `SecretsStoreBackend` over a dedicated PostgreSQL pool (`pg`) when running stateless/replicated pods:

```ts
import type { EncryptedSecretRecord, SecretsStoreBackend } from "@inhuman.tools/harness/server";
import type { Pool } from "pg";

export class PostgresSecretsBackend implements SecretsStoreBackend {
  constructor(private readonly pool: Pool) {}

  getRecord(): EncryptedSecretRecord | undefined {
    // Tip: if your KMS/PostgreSQL secrets store uses async I/O, keep a synchronous
    // write-through in-memory map warmed at kernel acquisition, or use SqliteSecretsBackend
    // on a dedicated encrypted volume because SecretsVaultPort reads synchronously during turns.
    throw new Error("See note below on synchronous SecretsVaultPort reads");
  }
  putRecord(): void {}
  deleteRecord(): void {}
  listConnectionIds(): string[] { return []; }
  [Symbol.dispose](): void {}
}
```

> [!IMPORTANT]
> `SecretsVaultPort` (`readConnectionSecrets` / `writeConnectionSecrets`) is synchronous during model driver invocation. When storing encrypted envelopes in a remote PostgreSQL `Secrets DB`, either pair a warmed synchronous per-kernel `MemorySecretsBackend` with write-through persistence on `acquire(kernelId)`/`evict(kernelId)`, or place `SqliteSecretsBackend` on a dedicated volume attached to the stateful agent-harness service.

---

## 3. Packages & Runtime Prerequisites

- **Node.js**: `>= 22` (native `AsyncDisposable`, `node:crypto`, and `better-sqlite3` ABI support).
- **Package manager (`pnpm` v10+)**: allow native compilation of SQLite bindings by listing `"better-sqlite3"` in `pnpm.onlyBuiltDependencies` in your root `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "better-sqlite3"]
  }
}
```

### Dependencies to install

**Server service package:**
- `@inhuman.tools/harness` (import entrypoint `@inhuman.tools/harness/server`)
- `@inhuman.tools/scope-plane` (import `@inhuman.tools/scope-plane/sqlite` on server)
- `@inhuman.tools/plugin-sdk`
- `@inhuman.tools/harness-contract`
- `@inhuman.tools/harness-model`

**Browser application package:**
- `@inhuman.tools/harness-peer`
- `@inhuman.tools/harness-client`
- `@inhuman.tools/harness-contract`
- `@inhuman.tools/harness-model`
- `@inhuman.tools/scope-plane`

> [!NOTE]
> The server process hosting `@inhuman.tools/harness/server` should remain isolated from heavy frontend or unrelated domain-schema packages. Authenticate tenants via lightweight token/session verification against PostgreSQL + your gateway, keeping tenant business models outside the agent kernel runtime.

---

## 4. Curating Host Plugins & Virtual Workspaces

In the `"server"` contour, tenant users cannot execute arbitrary local disk code or call `plugin/install`. Instead, the host registers curated plugins once at startup via `HostRuntimePluginCatalog`:

1. **Seed packages**: `includeSeedPackages: true` preloads bundled runtime plugins (task tracking, goals, memory/offload, fusion) from immutable memory caches (`warmPluginDirectory(..., { immutable: true })`).
2. **Custom server `InhumanPlugin` extensions**: implement domain capabilities (virtual document collections, cloud storage, SQL query tools, remote APIs, or VM sandbox bridges) via `@inhuman.tools/plugin-sdk`.
3. **Virtual workspaces via `WorkspaceEnvPort` and `activateProject`**:
   - Server projects typically represent a logical workspace, tenant folder, or virtual sandbox rather than a local directory on the server host.
   - Return `{ workspaceEnv }` from `activateProject(ctx, config)` so path resolution and write-admission policy checks validate against the virtual logical root without probing the host filesystem.

```ts
import { InhumanPlugin, InhumanTool, type WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";
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
        new InhumanTool({
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

## 5. Bootstrapping `createPortableHarnessServer`

The entry point below mounts a complete multi-tenant HTTP + WebSocket server backed by `MultiKernelRegistry`, encrypted secrets, warmed plugins, and bounded blob write-back caching:

```ts
import {
  AsyncCachedBlobBucket,
  createPortableHarnessServer,
  EncryptedSecretsVault,
  HostRuntimePluginCatalog,
  MultiKernelRegistry,
  SqliteSecretsBackend,
  type SecretsKeyRing,
} from "@inhuman.tools/harness/server";
import { HarnessDatabase, UpdateLaneHub } from "@inhuman.tools/scope-plane/sqlite";

// 1. Dedicated Agent DB (SQLite WAL) + reactive LiveShape hub
const agentDb = new HarnessDatabase(process.env.AGENT_DB_PATH ?? "./data/agent-harness.db");
const laneHub = new UpdateLaneHub(agentDb);

// 2. Dedicated Secrets DB + 32-byte AES-256-GCM keyring loaded from your KMS/env
const secretsBackend = new SqliteSecretsBackend(
  process.env.AGENT_SECRETS_DB_PATH ?? "./data/agent-secrets.db",
);
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

// 4. Pooled per-kernel registry with idle eviction
const registry = new MultiKernelRegistry({
  db: agentDb,
  ownsDb: true,
  laneHub,
  ownsLaneHub: true,
  idleEvictMs: 10 * 60_000,
  ...catalog.kernelOptions(),
  createSecretsVault: (kernelId) => {
    const [tenantId] = kernelId.split(":", 1);
    return new EncryptedSecretsVault({
      backend: secretsBackend,
      keyRing,
      tenantId: tenantId!,
      kernelId,
      ownsBackend: false,
    });
  },
  createBlobBucket: (kernelId) =>
    new AsyncCachedBlobBucket({
      // Wrap your S3-compatible / object storage BlobBucket adapter here.
      remote: createObjectStorageBlobBucket({ prefix: `agent-blobs/${kernelId}/` }),
      maxCacheBytes: 64 * 1024 * 1024, // caps clean in-memory cache; dirty entries stay pinned until flushed
    }),
});

// 5. Portable HTTP + WebSocket server
const server = createPortableHarnessServer({
  registry,
  ownsRegistry: true,
  allowedOrigins: [process.env.PUBLIC_ORIGIN!],
  async authenticate(req) {
    // Prefer gateway-injected verified headers after Hono + PostgreSQL validation,
    // or verify a signed bearer token directly here.
    const tenantId = req.headers["x-verified-tenant-id"];
    const userId = req.headers["x-verified-user-id"];
    if (typeof tenantId !== "string" || !tenantId || typeof userId !== "string" || !userId) {
      return null; // responds 401 Unauthorized
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
    void server[Symbol.asyncDispose]().finally(() => {
      secretsBackend[Symbol.dispose]();
      process.exit(0);
    });
  });
}
```

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

## 6. Edge & Gateway Topology (Caddy + Hono + PostgreSQL)

### Why Caddy sits at the edge

Browser sessions often keep `GET` SSE/polling streams, API calls, and WebSocket rooms (`/kernel`, `/session`) open on the same origin. Serving the browser over HTTP/1.1 limits Chrome/Firefox to 6 TCP sockets per origin and creates ~20s head-of-line stalls. Place **Caddy** in front for TLS termination and HTTP/2 + WebSocket pass-through:

```caddyfile
https://app.example.com {
  handle /api/tenants/*/agent/* {
    # Proxy both HTTP RPC/session calls and WebSocket upgrades through the Hono auth gateway
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

### Hono Gateway Pattern (Auth, Membership, and WebSocket Forwarding)

Browser `WebSocket` APIs **cannot set custom `Authorization` or tenant headers** on upgrade requests — only cookies and URL path/query parameters are sent automatically. Therefore, let **Hono** terminate client authentication against **PostgreSQL**, verify active tenant membership, strip any client-supplied internal headers, inject `x-verified-tenant-id` / `x-verified-user-id`, and rewrite `/api/tenants/:tenantId/agent/*` -> `/*` toward `createPortableHarnessServer`:

```ts
import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// Pseudocode sketch for your Node-hosted Hono HTTP + raw upgrade bridge:
// 1. Always strip inbound x-verified-* headers before setting your own.
// 2. Verify session cookie + active non-guest tenant role in PostgreSQL on BOTH HTTP requests and WS upgrades.
// 3. Revalidate membership periodically or on logout / role downgrade and destroy active WS sockets immediately.

export function registerAgentGatewayRoutes(app: Hono, harnessOrigin: string, harnessPort: number) {
  app.all("/api/tenants/:tenantId/agent/*", async (c) => {
    const tenantId = c.req.param("tenantId");
    const session = await verifyUserAndTenantInPostgres(c.req.raw.headers, tenantId);
    if (!session) return c.json({ error: "Unauthorized or forbidden" }, 401);

    const url = new URL(c.req.url);
    const strippedPath = url.pathname.replace(`/api/tenants/${tenantId}/agent`, "") || "/";
    const upstreamHeaders = new Headers(c.req.raw.headers);
    upstreamHeaders.delete("x-verified-tenant-id");
    upstreamHeaders.delete("x-verified-user-id");
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

// On the Node HTTP server's `upgrade` event for `/api/tenants/:tenantId/agent/(kernel|project|session)`:
// - Validate Origin and verify user + tenant membership in PostgreSQL.
// - Strip client `x-verified-*` headers, set verified `x-verified-tenant-id` & `x-verified-user-id`.
// - Rewrite `req.url` to `/kernel?...` / `/session?...` and tunnel the raw TCP Duplex socket to 127.0.0.1:harnessPort.
```

> [!WARNING]
> Always strip `x-verified-tenant-id` and `x-verified-user-id` from untrusted external requests in Hono/Caddy, and bind `createPortableHarnessServer` strictly to `127.0.0.1` (or a private VPC network). Never expose the internal harness port directly to the public internet without signed authentication.

---

## 7. Provisioning Connections & Virtual Projects via JSON-RPC

Before creating sessions for a tenant workspace, provision:

1. **Model connection (secrets go directly to `EncryptedSecretsVault`)**:
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
   Returns `{ result: { id: "<connectionId>" } }`. Never store provider secrets in `kv_entries` or `Agent DB` nodes.

2. **Virtual workspace overlay (`Project.pluginConfigs`)**:
   `POST /rpc` with `scope: { kind: "kernel" }`:
   ```json
   {
     "id": 2,
     "method": "project/configure",
     "params": {
       "projectId": "ws-42",
       "workspacePath": "virtual://tenant-a/ws-42",
       "kind": "virtual",
       "title": "Workspace 42",
       "enabledPlugins": ["virtual-docs", "tasks", "offload-tingle"],
       "pluginConfigs": {
         "virtual-docs": { "tenantId": "tenant-a", "workspaceId": "ws-42" }
       }
     }
   }
   ```

---

## 8. Browser Client Integration (`@inhuman.tools/harness-peer` & `LiveShape`)

Client documents mirror server `session_nodes` via `ShapeDeltaFrame` (`LiveShape`) and enforce read-only immutability on the browser (`ReadOnlyDocumentError` on accidental local mutations).

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
  // 1. Kernel room: publish a presence seat so the server attaches and keeps this session live
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

To receive live approval prompts (`pending_asks`) or sidebar session updates (`recent_sessions`) without polling, send `shape/subscribe` frames over the `/kernel` or `/session` socket. The server filters and pins every subscription to the authenticated `kernelId`.

---

## 9. Security, Sizing & Operational Checklist

- **Origin & Tenant Binding**: Always configure `allowedOrigins` in production. Once a `kernelId` binds to a `tenantId` inside `createPortableHarnessServer`, attempts by another tenant to claim the same `kernelId` fail with `403`.
- **Cross-Tenant Isolation**: Direct reads/RPC/WS connects to another kernel's `sessionId` or `workspacePath` return `404`; attempting to spoof `params.kernelId` in `shape/subscribe` immediately closes the WebSocket with code `1008` (`forbidden kernel subscription`).
- **Key Rotation**: To rotate `Secrets DB` keys, add the new key to `SecretsKeyRing.keys`, promote `activeKid` to the new key ID, deploy, run `vault.rewrapAll()` per kernel, and then retire the old key.
- **Memory Capacity Planning**:
  - Set `MultiKernelRegistry({ idleEvictMs })` so dormant kernels park and flush dirty blobs cleanly (~`0.43 MB` baseline per active kernel, ~`98%` reclaimed on `evict()`).
  - Bound `AsyncCachedBlobBucket({ maxCacheBytes })` per kernel according to total pod RAM (`maxConcurrentKernels × maxCacheBytes` worst-case clean cache ceiling).
- **Liveness & Graceful Drain**: Point orchestrator readiness probes at `GET /healthz`. On `SIGTERM`, await `server[Symbol.asyncDispose]()` before exit so `MultiKernelRegistry` flushes pending SQLite transactions, uploads dirty blobs, and disposes active sessions.
