import { ShapeStream } from "@electric-sql/client";
import {
  shapeSubscribeFrameSchema,
  tables,
  type ShapeDeltaFrame,
  type ShapeSubscribeFrame,
  type TableName,
} from "@inhuman.tools/harness-contract/schema";
import {
  mintInitialCommitOffset,
  type ElectricShapeMessage,
  type HarnessKvStore,
  type ShapeSource,
} from "@inhuman.tools/scope-plane";

export type ElectricLaneQuerySpec = {
  readonly table: TableName;
  readonly where: string;
  readonly params: readonly string[];
  readonly schema?: string;
};

export type ElectricShapeStreamLike = {
  subscribe(callback: (messages: readonly ElectricShapeMessage<Record<string, unknown>>[]) => void): () => void;
};

export type ElectricShapeStreamFactory = (
  spec: ElectricLaneQuerySpec & {
    readonly shapeUrl: string;
    readonly headers?: Record<string, string>;
    readonly signal: AbortSignal;
    readonly onError: (error: unknown) => void;
  },
) => ElectricShapeStreamLike;

export type ElectricShapeSourceOptions = {
  /** Base Electric server URL (e.g. `http://electric:3000` or `/v1/shape` prefix root). */
  readonly shapeUrl: string;
  /** PostgreSQL schema prefix passed to Electric (`table = "schema.table"` when not `"public"`). */
  readonly schema?: string;
  /** Default kernel ID when `frame.params.kernelId` is omitted (default `"local"`). */
  readonly defaultKernelId?: string;
  /** Optional static headers or dynamic header provider sent to Electric `/v1/shape`. */
  readonly headers?: Record<string, string>;
  /** Optional `HarnessKvStore` used for synchronous `evaluateLane()` point-in-time queries. */
  readonly store?: HarnessKvStore;
  /** Optional error callback when an Electric shape stream reports a transport/protocol error. */
  readonly onError?: (error: unknown, subscriptionId: string) => void;
  /** Optional custom stream factory (primarily for tests or proxies). */
  readonly streamFactory?: ElectricShapeStreamFactory;
};

type ActiveSubscription = {
  readonly key: string;
  readonly subscriptionId: string;
  readonly frame: ShapeSubscribeFrame;
  readonly sink: (delta: ShapeDeltaFrame) => void;
  readonly abortController: AbortController;
  readonly pendingUpserts: Map<string, Record<string, unknown>>;
  readonly pendingDeletes: Set<string>;
  unsubStream: (() => void) | null;
  initialized: boolean;
  refetching: boolean;
  disposed: boolean;
};

function subscriptionKey(clientId: string, subscriptionId: string): string {
  return `${clientId}\n${subscriptionId}`;
}

export function compileElectricLaneQuery(
  frame: ShapeSubscribeFrame,
  options?: { readonly defaultKernelId?: string; readonly schema?: string },
): ElectricLaneQuerySpec {
  const kernelId = frame.params.kernelId ?? options?.defaultKernelId ?? "local";
  const schema = options?.schema;

  switch (frame.lane) {
    case "kernel_meta":
      return { table: "kernel_state", where: "kernel_id = $1", params: [kernelId], schema };

    case "scope_nodes":
      return {
        table: "scope_nodes",
        where: "kernel_id = $1 AND scope_id = $2",
        params: [kernelId, frame.params.scopeId],
        schema,
      };

    case "session_nodes":
      return {
        table: "session_nodes",
        where: "kernel_id = $1 AND session_id = $2",
        params: [kernelId, frame.params.sessionId],
        schema,
      };

    case "active_sessions": {
      const clauses = ["kernel_id = $1", "running = TRUE"];
      const params: string[] = [kernelId];
      if (frame.params.projectId) {
        params.push(frame.params.projectId);
        clauses.push(`project_id = $${params.length}`);
      }
      if (frame.params.workspacePath) {
        params.push(frame.params.workspacePath);
        clauses.push(`workspace_path = $${params.length}`);
      }
      return { table: "sessions", where: clauses.join(" AND "), params, schema };
    }

    case "recent_sessions": {
      const clauses = ["kernel_id = $1", "archived_at_ms IS NULL"];
      const params: string[] = [kernelId];
      if (frame.params.projectId) {
        params.push(frame.params.projectId);
        clauses.push(`project_id = $${params.length}`);
      }
      if (frame.params.workspacePath) {
        params.push(frame.params.workspacePath);
        clauses.push(`workspace_path = $${params.length}`);
      }
      if (frame.params.beforeMs !== undefined) {
        params.push(String(frame.params.beforeMs));
        clauses.push(`last_active_at_ms < $${params.length}`);
      }
      return { table: "sessions", where: clauses.join(" AND "), params, schema };
    }

    case "child_sessions":
      return {
        table: "sessions",
        where: "kernel_id = $1 AND parent_session_id = $2",
        params: [kernelId, frame.params.parentSessionId],
        schema,
      };

    case "pending_asks": {
      if (frame.params.sessionId) {
        return {
          table: "pending_asks",
          where: "kernel_id = $1 AND session_id = $2",
          params: [kernelId, frame.params.sessionId],
          schema,
        };
      }
      return { table: "pending_asks", where: "kernel_id = $1", params: [kernelId], schema };
    }
  }
}

function normalizeElectricRow(
  table: TableName,
  raw: Record<string, unknown>,
  keyFallback?: string,
): { readonly pk: string; readonly row: Record<string, unknown> } {
  const def = tables[table];
  const rawPk = raw[def.keySql] ?? raw[def.key] ?? keyFallback ?? "";
  const pk = String(rawPk);
  const out: Record<string, unknown> = {
    [def.key]: pk,
  };

  for (const col of def.columns) {
    const rawVal = Object.hasOwn(raw, col.sql) ? raw[col.sql] : raw[col.name];
    if (rawVal === undefined || rawVal === null) {
      out[col.name] = null;
    } else if (col.kind === "boolean") {
      out[col.name] = rawVal === true || rawVal === "true" || rawVal === "t" || rawVal === 1;
    } else if (col.kind === "number") {
      out[col.name] = Number(rawVal);
    } else {
      out[col.name] = String(rawVal);
    }
  }

  return { pk, row: out };
}

function extractElectricPrimaryKey(table: TableName, msg: ElectricShapeMessage<Record<string, unknown>>): string {
  const def = tables[table];
  const val = msg.value;
  if (val !== undefined) {
    const rawPk = val[def.keySql] ?? val[def.key];
    if (rawPk !== undefined && rawPk !== null) {
      return String(rawPk);
    }
  }
  const key = msg.key ?? "";
  const slashIdx = key.lastIndexOf("/");
  const rawSegment = slashIdx !== -1 ? key.slice(slashIdx + 1) : key;
  return rawSegment.replaceAll(/^"+|"+$/g, "");
}

function defaultStreamFactory(spec: {
  readonly table: TableName;
  readonly where: string;
  readonly params: readonly string[];
  readonly schema?: string;
  readonly shapeUrl: string;
  readonly headers?: Record<string, string>;
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
}): ElectricShapeStreamLike {
  const root = spec.shapeUrl.replace(/\/$/, "");
  const qualifiedTable =
    spec.schema !== undefined && spec.schema !== "public"
      ? `${spec.schema}.${tables[spec.table].sql}`
      : tables[spec.table].sql;

  return new ShapeStream<Record<string, unknown>>({
    url: `${root}/v1/shape`,
    params: {
      table: qualifiedTable,
      where: spec.where,
      params: [...spec.params],
    },
    ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
    signal: spec.signal,
    onError: (err) => {
      spec.onError(err);
    },
  }) as unknown as ElectricShapeStreamLike;
}

/**
 * `ShapeSource` implementation backed by ElectricSQL `/v1/shape` streams.
 * Converts Electric control/change batches into canonical harness `ShapeDeltaFrame`s
 * matching `CommitDiffShapeSource`.
 */
export class ElectricShapeSource implements ShapeSource {
  readonly #options: ElectricShapeSourceOptions;
  readonly #streamFactory: ElectricShapeStreamFactory;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  #offset = mintInitialCommitOffset();
  #disposed = false;

  constructor(options: ElectricShapeSourceOptions) {
    this.#options = options;
    this.#streamFactory = options.streamFactory ?? defaultStreamFactory;
  }

  subscribe(rawFrame: unknown, sink: (delta: ShapeDeltaFrame) => void, clientId = "local"): () => void {
    if (this.#disposed) {
      throw new Error("ElectricShapeSource is disposed");
    }

    const frame = shapeSubscribeFrameSchema.parse(rawFrame);
    const key = subscriptionKey(clientId, frame.subscriptionId);

    const existing = this.#subscriptions.get(key);
    if (existing !== undefined) {
      this.#disposeSubscription(existing);
    }

    const spec = compileElectricLaneQuery(frame, {
      defaultKernelId: this.#options.defaultKernelId,
      schema: this.#options.schema,
    });
    const abortController = new AbortController();
    const sub: ActiveSubscription = {
      key,
      subscriptionId: frame.subscriptionId,
      frame,
      sink,
      abortController,
      pendingUpserts: new Map(),
      pendingDeletes: new Set(),
      unsubStream: null,
      initialized: false,
      refetching: false,
      disposed: false,
    };
    this.#subscriptions.set(key, sub);

    const stream = this.#streamFactory({
      ...spec,
      shapeUrl: this.#options.shapeUrl,
      headers: this.#options.headers,
      signal: abortController.signal,
      onError: (err) => {
        this.#options.onError?.(err, sub.subscriptionId);
      },
    });

    sub.unsubStream = stream.subscribe((messages) => {
      if (sub.disposed || this.#disposed) return;
      this.#handleMessages(sub, spec.table, messages);
    });

    return () => {
      this.unsubscribe(frame.subscriptionId, clientId);
    };
  }

  #handleMessages(
    sub: ActiveSubscription,
    table: TableName,
    messages: readonly ElectricShapeMessage<Record<string, unknown>>[],
  ): void {
    for (const msg of messages) {
      if ("headers" in msg && msg.headers.control !== undefined) {
        const control = msg.headers.control;
        if (control === "must-refetch") {
          sub.pendingUpserts.clear();
          sub.pendingDeletes.clear();
          sub.refetching = true;
          continue;
        }
        if (control === "up-to-date") {
          this.#flushPending(sub, !sub.initialized || sub.refetching);
          sub.initialized = true;
          sub.refetching = false;
        }
        continue;
      }

      const op = msg.headers.operation;
      if (op === "insert" || op === "update") {
        if (msg.value === undefined) continue;
        const { pk, row } = normalizeElectricRow(table, msg.value, extractElectricPrimaryKey(table, msg));
        sub.pendingDeletes.delete(pk);
        sub.pendingUpserts.set(pk, row);
      } else if (op === "delete") {
        const pk = extractElectricPrimaryKey(table, msg);
        if (pk !== "") {
          sub.pendingUpserts.delete(pk);
          sub.pendingDeletes.add(pk);
        }
      }
    }

    if (sub.initialized && !sub.refetching && (sub.pendingUpserts.size > 0 || sub.pendingDeletes.size > 0)) {
      this.#flushPending(sub, false);
    }
  }

  #flushPending(sub: ActiveSubscription, reset: boolean): void {
    const upserts = [...sub.pendingUpserts.values()];
    const deletes = [...sub.pendingDeletes];
    sub.pendingUpserts.clear();
    sub.pendingDeletes.clear();

    if (!reset && upserts.length === 0 && deletes.length === 0) {
      return;
    }

    this.#offset += 1;
    sub.sink({
      kind: "shape/delta",
      subscriptionId: sub.subscriptionId,
      offset: this.#offset,
      upserts,
      deletes,
      ...(reset ? { reset: true } : {}),
    });
  }

  unsubscribe(subscriptionId: string, clientId = "local"): void {
    const key = subscriptionKey(clientId, subscriptionId);
    const sub = this.#subscriptions.get(key);
    if (sub !== undefined) {
      this.#disposeSubscription(sub);
      this.#subscriptions.delete(key);
    }
  }

  unsubscribeClient(clientId: string): void {
    const prefix = `${clientId}\n`;
    for (const key of [...this.#subscriptions.keys()]) {
      if (key.startsWith(prefix)) {
        const sub = this.#subscriptions.get(key);
        if (sub !== undefined) {
          this.#disposeSubscription(sub);
        }
        this.#subscriptions.delete(key);
      }
    }
  }

  async evaluateLane(frame: ShapeSubscribeFrame): Promise<Record<string, unknown>[]> {
    if (this.#options.store === undefined) {
      throw new Error("ElectricShapeSource.evaluateLane requires options.store to be configured");
    }
    const targetKernelId = frame.params.kernelId ?? this.#options.defaultKernelId ?? "local";
    switch (frame.lane) {
      case "kernel_meta":
        return [...(await this.#options.store.scan("kernel_state", { where: { kernelId: targetKernelId } }))];
      case "scope_nodes":
        return [
          ...(await this.#options.store.scan("scope_nodes", {
            where: { kernelId: targetKernelId, scopeId: frame.params.scopeId },
          })),
        ];
      case "session_nodes":
        return [
          ...(await this.#options.store.scan("session_nodes", {
            where: { kernelId: targetKernelId, sessionId: frame.params.sessionId },
          })),
        ];
      case "recent_sessions":
        return [
          ...(await this.#options.store.scan("sessions", {
            where: {
              kernelId: targetKernelId,
              archivedAtMs: null,
              ...(frame.params.projectId ? { projectId: frame.params.projectId } : {}),
              ...(frame.params.workspacePath ? { workspacePath: frame.params.workspacePath } : {}),
              ...(frame.params.beforeMs !== undefined ? { lastActiveAtMs: { lt: frame.params.beforeMs } } : {}),
            },
            orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
            limit: frame.params.limit,
          })),
        ];
      case "child_sessions":
        return [
          ...(await this.#options.store.scan("sessions", {
            where: { kernelId: targetKernelId, parentSessionId: frame.params.parentSessionId },
            orderBy: [{ column: "createdAtMs", direction: "asc" }],
          })),
        ];
      case "pending_asks":
        return [
          ...(await this.#options.store.scan("pending_asks", {
            where: {
              kernelId: targetKernelId,
              ...(frame.params.sessionId ? { sessionId: frame.params.sessionId } : {}),
            },
            orderBy: [{ column: "createdAtMs", direction: "asc" }],
          })),
        ];
      case "active_sessions": {
        const baseWhere = {
          kernelId: targetKernelId,
          ...(frame.params.projectId ? { projectId: frame.params.projectId } : {}),
          ...(frame.params.workspacePath ? { workspacePath: frame.params.workspacePath } : {}),
        };
        const [runningRows, askRows] = await Promise.all([
          this.#options.store.scan("sessions", {
            where: { ...baseWhere, running: true },
            orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
          }),
          this.#options.store.scan("pending_asks", {
            where: { kernelId: targetKernelId },
          }),
        ]);
        const runningIds = new Set(runningRows.map((row) => row.sessionId));
        const extraIds = [...new Set(askRows.map((row) => row.sessionId).filter((id) => !runningIds.has(id)))];
        if (extraIds.length === 0) {
          return [...runningRows];
        }
        const askSessionRows = await this.#options.store.scan("sessions", {
          where: { ...baseWhere, sessionId: { in: extraIds } },
        });
        return [...runningRows, ...askSessionRows].sort((a, b) => Number(b.lastActiveAtMs) - Number(a.lastActiveAtMs));
      }
    }
  }

  #disposeSubscription(sub: ActiveSubscription): void {
    sub.disposed = true;
    sub.unsubStream?.();
    sub.unsubStream = null;
    sub.abortController.abort();
  }

  dispose(): void {
    this.#disposed = true;
    for (const sub of this.#subscriptions.values()) {
      this.#disposeSubscription(sub);
    }
    this.#subscriptions.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
