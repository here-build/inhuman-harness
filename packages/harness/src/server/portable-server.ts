import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { CommitDiffShapeSource, type ShapeSource } from "@inhuman.tools/scope-plane";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { JSON_RPC_INTERNAL_ERROR } from "@/protocol/rpc";

import type { RequestHost } from "./contract.js";
import { KernelDaemon } from "./daemon/kernel/KernelDaemon.js";
import { originAllowed } from "./listen.js";
import { MultiKernelRegistry } from "./multi-kernel-registry.js";
import { classifyPublicUpgrade, UPGRADE_NOT_FOUND, UPGRADE_ROUTE_FAILED } from "./transport/routes.js";
import { readField } from "./util/read-field.js";

const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSIONS_LIMIT = 50;
const MAX_SESSIONS_LIMIT = 500;

async function evaluateLaneFrame(
  kernel: KernelDaemon,
  frame: Parameters<NonNullable<ShapeSource["evaluateLane"]>>[0],
): Promise<Record<string, unknown>[]> {
  if (kernel.laneHub.evaluateLane !== undefined) {
    return kernel.laneHub.evaluateLane(frame);
  }
  const hub = new CommitDiffShapeSource(kernel.db, { defaultKernelId: kernel.kernelId });
  try {
    return await hub.evaluateLane(frame);
  } finally {
    hub.dispose();
  }
}

export interface PortablePrincipal {
  readonly tenantId: string;
  readonly kernelId: string;
  readonly subjectId?: string;
}

export type PortableRequestContext = {
  readonly kind: "http" | "upgrade";
  readonly req: IncomingMessage;
  readonly principal: PortablePrincipal;
  readonly kernel: KernelDaemon;
};

export type PortableRpcScope =
  | { readonly kind: "kernel" }
  | { readonly kind: "project"; readonly path: string }
  | { readonly kind: "session"; readonly sessionId: string; readonly path?: string };

export type PortableRpcContext = {
  readonly body: {
    readonly id?: string | number | null;
    readonly method: string;
    readonly params?: unknown;
    readonly scope?: PortableRpcScope;
  };
  readonly principal: PortablePrincipal;
  readonly kernel: KernelDaemon;
};

export type PortableRpcAdjustment = {
  readonly method?: string;
  readonly params?: unknown;
  readonly scope?: PortableRpcScope;
};

export interface PortableHarnessServerOptions {
  readonly registry: MultiKernelRegistry;
  /** Whether `[Symbol.asyncDispose]` also disposes `registry`. Default: `true`. */
  readonly ownsRegistry?: boolean;
  readonly authenticate: (req: IncomingMessage) => Promise<PortablePrincipal | null> | PortablePrincipal | null;
  readonly allowedOrigins?: readonly string[];
  /** Optional host hook run after authentication and kernel acquisition before route dispatch. */
  readonly prepareRequest?: (context: PortableRequestContext) => Promise<void> | void;
  /** Optional host hook to normalize or auto-provision scope before `POST /rpc` executes. */
  readonly prepareRpc?: (context: PortableRpcContext) => Promise<PortableRpcAdjustment | void> | PortableRpcAdjustment | void;
}

export interface PortableListenAddress {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly wsUrl: string;
}

export interface PortableHarnessServer extends AsyncDisposable {
  readonly server: Server;
  readonly registry: MultiKernelRegistry;
  listen(port?: number, host?: string): Promise<PortableListenAddress>;
  [Symbol.asyncDispose](): Promise<void>;
}

const rpcScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("kernel") }),
  z.object({ kind: z.literal("project"), path: z.string().min(1) }),
  z.object({ kind: z.literal("session"), sessionId: z.string().min(1), path: z.string().optional() }),
]);

const rpcBodySchema = z.object({
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
  scope: rpcScopeSchema.optional(),
});

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body exceeds limit");
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

async function readRequestJson(req: IncomingMessage): Promise<{ readonly raw: string; readonly parsed: unknown }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.byteLength;
    if (total > MAX_RPC_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(raw);
  return { raw, parsed };
}

function refuseUpgrade(socket: Duplex, goneRef: { gone: boolean }, status: number, reason: string): void {
  if (goneRef.gone || socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

async function findSessionOwnerKernel(kernel: KernelDaemon, sessionId: string): Promise<string | null> {
  const row = await kernel.db.get("sessions", sessionId);
  if (row !== undefined) return row.kernelId;
  const nodeRows = await kernel.db.scan("session_nodes", { where: { sessionId }, limit: 1 });
  return nodeRows[0]?.kernelId ?? null;
}

async function resolveSessionHost(kernel: KernelDaemon, sessionId: string): Promise<RequestHost | null> {
  if (!kernel.hasStoredSession(sessionId)) {
    const owner = await findSessionOwnerKernel(kernel, sessionId);
    if (owner !== kernel.kernelId) return null;
  }
  const doc = kernel.sessionDoc(sessionId) ?? (await kernel.acquireSession(sessionId));
  if (doc == null) return null;
  if (doc.root.agent.spec.recipeScope === "global") {
    return await kernel.globalSession(sessionId);
  }
  const project = kernel.project(doc.root.path);
  await project.ready;
  return await project.session(sessionId);
}

function parseSessionsLimit(url: URL): number {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null) return DEFAULT_SESSIONS_LIMIT;
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SESSIONS_LIMIT;
  return Math.min(MAX_SESSIONS_LIMIT, Math.floor(parsed));
}

function formatHttpHost(address: AddressInfo, requestedHost: string): string {
  if (address.family === "IPv6") {
    return address.address === "::" ? `[${requestedHost}]` : `[${address.address}]`;
  }
  return address.address === "0.0.0.0" ? requestedHost : address.address;
}

/**
 * Composes a portable multi-tenant HTTP + WebSocket server backed by {@link MultiKernelRegistry}.
 *
 * Designed for direct import by external SaaS / self-hosted deployments via `@inhuman.tools/harness/server`
 * without altering local UNIX-socket daemon startup (`HarnessDaemon`).
 */
export function createPortableHarnessServer(options: PortableHarnessServerOptions): PortableHarnessServer {
  const { registry, authenticate } = options;
  const ownsRegistry = options.ownsRegistry ?? true;
  const allowedOriginSet =
    options.allowedOrigins === undefined
      ? null
      : new Set(options.allowedOrigins.map((origin) => origin.trim().toLowerCase()).filter((origin) => origin !== ""));
  const boundTenantByKernel = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true });
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let listenPromise: Promise<PortableListenAddress> | null = null;
  let listeningAddress: PortableListenAddress | null = null;

  const isOriginAllowed = (req: IncomingMessage): boolean => {
    if (allowedOriginSet === null) return true;
    return originAllowed(req.headers.origin, allowedOriginSet);
  };

  const authenticateChecked = async (
    req: IncomingMessage,
  ): Promise<
    { readonly ok: true; readonly principal: PortablePrincipal } | { readonly ok: false; readonly status: 401 | 403 }
  > => {
    let principal: PortablePrincipal | null = null;
    try {
      principal = await authenticate(req);
    } catch {
      return { ok: false, status: 401 };
    }
    if (
      principal === null ||
      typeof principal.tenantId !== "string" ||
      principal.tenantId === "" ||
      typeof principal.kernelId !== "string" ||
      principal.kernelId === ""
    ) {
      return { ok: false, status: 401 };
    }
    const existingTenant = boundTenantByKernel.get(principal.kernelId);
    if (existingTenant !== undefined && existingTenant !== principal.tenantId) {
      return { ok: false, status: 403 };
    }
    boundTenantByKernel.set(principal.kernelId, principal.tenantId);
    return { ok: true, principal };
  };

  const handleHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (disposed) {
      writeJson(res, 503, { error: "server shutting down" });
      return;
    }
    if (!isOriginAllowed(req)) {
      writeJson(res, 403, { error: "forbidden origin" });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", "http://portable.invalid");
    } catch {
      writeJson(res, 400, { error: "invalid url" });
      return;
    }

    const { pathname } = parsedUrl;
    const method = req.method ?? "GET";

    if (method === "GET" && pathname === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }

    const auth = await authenticateChecked(req);
    if (!auth.ok) {
      writeJson(res, auth.status, { error: auth.status === 401 ? "unauthorized" : "forbidden kernel tenant" });
      return;
    }

    const lease = await registry.acquire(auth.principal.kernelId);
    try {
      if (options.prepareRequest !== undefined) {
        await options.prepareRequest({
          kind: "http",
          req,
          principal: auth.principal,
          kernel: lease.kernel,
        });
        parsedUrl = new URL(req.url ?? "/", "http://portable.invalid");
      }
      const routePathname = parsedUrl.pathname;

      if (method === "GET" && routePathname === "/sessions") {
        const limit = parseSessionsLimit(parsedUrl);
        const projectId = parsedUrl.searchParams.get("projectId") ?? undefined;
        const workspacePath = parsedUrl.searchParams.get("workspacePath") ?? undefined;
        const sessions = await evaluateLaneFrame(lease.kernel, {
          kind: "shape/subscribe",
          subscriptionId: "http",
          lane: "recent_sessions",
          params: {
            kernelId: lease.kernelId,
            limit,
            ...(projectId !== undefined && projectId !== "" ? { projectId } : {}),
            ...(workspacePath !== undefined && workspacePath !== "" ? { workspacePath } : {}),
          },
        });
        writeJson(res, 200, { kernelId: lease.kernelId, sessions });
        return;
      }

      if (method === "GET" && routePathname.startsWith("/sessions/")) {
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(routePathname.slice("/sessions/".length));
        } catch {
          writeJson(res, 400, { error: "invalid session id encoding" });
          return;
        }
        if (sessionId === "" || sessionId.includes("/")) {
          writeJson(res, 404, { error: "not found" });
          return;
        }
        let sessionRow = await lease.kernel.db.get("sessions", sessionId);
        if (sessionRow !== undefined && sessionRow.kernelId !== lease.kernelId) {
          sessionRow = undefined;
        }
        if (sessionRow === undefined && !lease.kernel.hasStoredSession(sessionId)) {
          writeJson(res, 404, { error: "session not found" });
          return;
        }
        const nodes = await evaluateLaneFrame(lease.kernel, {
          kind: "shape/subscribe",
          subscriptionId: "http",
          lane: "session_nodes",
          params: { kernelId: lease.kernelId, sessionId },
        });
        writeJson(res, 200, { kernelId: lease.kernelId, sessionId, session: sessionRow ?? null, nodes });
        return;
      }

      if (method === "POST" && routePathname === "/rpc") {
        let parsedBody: unknown;
        try {
          parsedBody = (await readRequestJson(req)).parsed;
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            writeJson(res, 413, { error: error.message });
            return;
          }
          writeJson(res, 400, { error: "invalid json body" });
          return;
        }
        const bodyResult = rpcBodySchema.safeParse(parsedBody);
        if (!bodyResult.success) {
          writeJson(res, 400, { error: "invalid rpc request body" });
          return;
        }
        const body = bodyResult.data;
        let rpcMethod = body.method;
        let rpcParams: unknown = body.params ?? {};
        let rpcScope: PortableRpcScope = body.scope ?? { kind: "kernel" as const };
        if (options.prepareRpc !== undefined) {
          const adjusted = await options.prepareRpc({
            body: { id: body.id, method: rpcMethod, params: rpcParams, scope: rpcScope },
            principal: auth.principal,
            kernel: lease.kernel,
          });
          if (adjusted !== undefined) {
            if (adjusted.method !== undefined) rpcMethod = adjusted.method;
            if (adjusted.params !== undefined) rpcParams = adjusted.params;
            if (adjusted.scope !== undefined) rpcScope = adjusted.scope;
          }
        }
        let host: RequestHost | null = null;
        switch (rpcScope.kind) {
          case "kernel":
            host = lease.kernel;
            break;
          case "project": {
            if (!lease.kernel.hasProject(rpcScope.path)) {
              writeJson(res, 404, { error: "project not found" });
              return;
            }
            const project = lease.kernel.project(rpcScope.path);
            await project.ready;
            host = project;
            break;
          }
          case "session": {
            const owner = await findSessionOwnerKernel(lease.kernel, rpcScope.sessionId);
            if (owner !== null && owner !== lease.kernelId) {
              writeJson(res, 404, { error: "session not found" });
              return;
            }
            if (rpcScope.path !== undefined && rpcScope.path !== "") {
              if (!lease.kernel.hasProject(rpcScope.path)) {
                writeJson(res, 404, { error: "project not found" });
                return;
              }
              const project = lease.kernel.project(rpcScope.path);
              await project.ready;
              host = await project.session(rpcScope.sessionId);
            } else {
              host = await resolveSessionHost(lease.kernel, rpcScope.sessionId);
            }
            break;
          }
        }
        if (host === null) {
          writeJson(res, 404, { error: "target host not found" });
          return;
        }
        try {
          const result = await host.handleRequest(rpcMethod, rpcParams, {
            requestId: body.id ?? randomUUID(),
            connectionId: `http-${randomUUID()}`,
            remote: true,
          });
          writeJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, result });
        } catch (error) {
          const rawCode =
            typeof error === "object" && error !== null ? Number(readField(error, "code")) : JSON_RPC_INTERNAL_ERROR;
          const code = Number.isInteger(rawCode) ? rawCode : JSON_RPC_INTERNAL_ERROR;
          const message = error instanceof Error ? error.message : "Internal error";
          writeJson(res, 200, { jsonrpc: "2.0", id: body.id ?? null, error: { code, message } });
        }
        return;
      }

      writeJson(res, 404, { error: "not found" });
    } finally {
      lease[Symbol.dispose]();
    }
  };

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "internal error";
      writeJson(res, 500, { error: message });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const goneRef = { gone: false };
    socket.on("error", () => {
      goneRef.gone = true;
    });
    socket.once("close", () => {
      goneRef.gone = true;
    });

    const runUpgrade = async (): Promise<void> => {
      if (disposed) {
        refuseUpgrade(socket, goneRef, 503, "Service Unavailable");
        return;
      }
      if (!isOriginAllowed(req)) {
        refuseUpgrade(socket, goneRef, 403, "Forbidden");
        return;
      }
      const [rawPathname = "/"] = (req.url ?? "/").split("?");
      if (rawPathname !== "/kernel" && rawPathname !== "/project" && rawPathname !== "/session") {
        refuseUpgrade(socket, goneRef, UPGRADE_NOT_FOUND, "not found");
        return;
      }

      const auth = await authenticateChecked(req);
      if (!auth.ok) {
        refuseUpgrade(socket, goneRef, auth.status, auth.status === 401 ? "Unauthorized" : "Forbidden");
        return;
      }
      if (goneRef.gone || socket.destroyed) return;

      const lease = await registry.acquire(auth.principal.kernelId);
      let transferred = false;
      try {
        if (options.prepareRequest !== undefined) {
          await options.prepareRequest({
            kind: "upgrade",
            req,
            principal: auth.principal,
            kernel: lease.kernel,
          });
        }
        if (goneRef.gone || socket.destroyed) return;

        const classified = classifyPublicUpgrade(req.url ?? "/");
        if (classified.action === "refuse") {
          refuseUpgrade(socket, goneRef, classified.status, classified.reason);
          return;
        }

        let host: RequestHost | null = null;
        if (classified.action === "open") {
          const { key } = classified;
          if (key.kind === "kernel") {
            host = lease.kernel;
          } else if (key.kind === "projects") {
            if (!lease.kernel.hasProject(key.id)) {
              refuseUpgrade(socket, goneRef, UPGRADE_NOT_FOUND, "not found");
              return;
            }
            const project = lease.kernel.project(key.id);
            await project.ready;
            host = project;
          } else {
            host = await resolveSessionHost(lease.kernel, key.id);
          }
        } else {
          const path = classified.path;
          if (path === undefined || path === "" || !lease.kernel.hasProject(path)) {
            refuseUpgrade(socket, goneRef, UPGRADE_NOT_FOUND, "not found");
            return;
          }
          if (classified.sessionId !== undefined && classified.sessionId !== "") {
            const owner = await findSessionOwnerKernel(lease.kernel, classified.sessionId);
            if (owner !== null && owner !== lease.kernelId) {
              refuseUpgrade(socket, goneRef, UPGRADE_NOT_FOUND, "not found");
              return;
            }
          }
          const project = lease.kernel.project(path);
          await project.ready;
          host = await project.session(classified.sessionId);
        }

        if (host === null) {
          refuseUpgrade(socket, goneRef, UPGRADE_NOT_FOUND, "not found");
          return;
        }
        if (goneRef.gone || socket.destroyed) return;

        req.headers["x-harness-remote"] = "1";
        transferred = true;
        socket.once("close", () => {
          lease[Symbol.dispose]();
        });
        host.accept(socket, req, head, wss);
      } finally {
        if (!transferred) {
          lease[Symbol.dispose]();
        }
      }
    };

    void runUpgrade().catch((error) => {
      const reason = error instanceof Error ? error.message : "route failed";
      refuseUpgrade(socket, goneRef, UPGRADE_ROUTE_FAILED, reason);
    });
  });

  const portable: PortableHarnessServer = {
    server,
    registry,

    async listen(port = 0, host = "127.0.0.1"): Promise<PortableListenAddress> {
      if (disposed) {
        throw new Error("PortableHarnessServer has been disposed");
      }
      if (listeningAddress !== null) return listeningAddress;
      if (listenPromise !== null) return listenPromise;

      listenPromise = new Promise<PortableListenAddress>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const rawAddr = server.address();
          if (rawAddr === null || typeof rawAddr === "string") {
            reject(new Error("PortableHarnessServer failed to bind a TCP port"));
            return;
          }
          const formattedHost = formatHttpHost(rawAddr, host);
          const resolved: PortableListenAddress = {
            port: rawAddr.port,
            host: formattedHost,
            url: `http://${formattedHost}:${rawAddr.port}`,
            wsUrl: `ws://${formattedHost}:${rawAddr.port}`,
          };
          listeningAddress = resolved;
          resolve(resolved);
        });
      });

      return listenPromise;
    },

    async [Symbol.asyncDispose](): Promise<void> {
      if (disposePromise !== null) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
            server.closeIdleConnections?.();
          });
        });
        if (ownsRegistry) {
          await registry[Symbol.asyncDispose]();
        }
      })();
      return disposePromise;
    },
  };

  return portable;
}

export {
  AsyncCachedBlobBucket,
  type AsyncCachedBlobBucketOptions,
  MemoryAsyncBlobBucket,
} from "./blobs/async-cached-bucket.js";
export { type KernelContour, type KernelDaemonOptions, KernelDaemon } from "./daemon/kernel/KernelDaemon.js";

export {
  HostRuntimePluginCatalog,
  type BundledPluginSpec,
  type HostRuntimePluginCatalogOptions,
} from "./host-plugin-catalog.js";
export {
  type KernelLease,
  type KernelStoreBinding,
  type MultiKernelRegistryOptions,
  MultiKernelRegistry,
} from "./multi-kernel-registry.js";

export {
  type AsyncSecretsStoreBackend,
  EncryptedSecretsVault,
  type EncryptedSecretRecord,
  encodeCanonicalAad,
  type EncryptedSecretsVaultOptions,
  SecretsAuthError,
  MemorySecretsBackend,
  type SecretsKeyRing,
  SqliteSecretsBackend,
  type SecretsStoreBackend,
} from "./secrets-encrypted.js";

export {
  BLOB_KEY_PREFIX,
  blobKeyOf,
  sha256OfBlobKey,
  type BlobBucket,
  type BlobBucketSync,
  type BlobListOptions,
  type BlobListPage,
  type BlobStat,
} from "./blobs/bucket.js";
export { DriverRegistry, isDriverRegistry, openDriverRegistry } from "../connections/registry.js";
export { PRODUCT_PROVIDERS } from "./composition.js";
export { MemorySecretsVault, type SecretsVaultPort } from "./secrets.js";
export { type OpenAiTool } from "../providers/openai-compat/arg-aliases.js";
export {
  completionCatalogOf,
  liveToolDescriptionOf,
  type CompletionFace,
  type LiveToolDescription,
} from "../providers/openai-compat/completion-face.js";
export {
  chatContentText,
  toolsFor,
  viewWire,
  type ChatImagePart,
  type ChatMessage,
} from "../providers/openai-compat/actor.js";

export {
  type HarnessKvStore,
  MemoryKvStore,
  UpdateLaneHub,
  CommitDiffShapeSource,
  type ShapeSource,
} from "@inhuman.tools/scope-plane";
