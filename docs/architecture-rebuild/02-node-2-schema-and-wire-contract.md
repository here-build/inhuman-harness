# Node 2: Relational Schema, Update Lanes & Wire Contract (`@inhuman.tools/harness-contract`)

**DAG Position**: Layer 0 (Foundation — depends only on `drizzle-orm` and `zod`)  
**Packages Modified**: `packages/harness-contract`  
**Downstream Consumers**: Node 4 (Storage & `LiveShape`), Node 5 (`harness-model`), Node 7 (Daemon), Node 8–10 (Web, Rust TUI, Mobile)

---

## 1. Purpose

Replace the implicit Yjs binary wire protocol (`y-protocols/sync` frames + opaque `.yjs` files) with an explicit, language-agnostic contract in `packages/harness-contract`:
1. **Canonical Drizzle SQLite Schema** (`packages/harness-contract/src/schema/sqlite.ts`) that serves as both the runtime DDL/query source of truth and the static type source for `@model(tag, table)` in Node 1.
2. **Update Lanes (`LiveShape` Specs)** defining the exact windowed/filtered queries clients can subscribe to for the Roster & Control Plane.
3. **Trajectory Patch Protocol** defining the initial snapshot + incremental `(revision, patches[])` frames for an active session.

---

## 2. Canonical Drizzle SQLite Schema

All local daemon state lives in a single WAL-mode SQLite database (`harness.db`) managed via Drizzle (`drizzle-orm/sqlite-core`).

### 2.1 Plane 1: Roster & Control Plane Tables

```ts
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Singleton kernel configuration & global state (replaces KernelRoot Y.Doc). */
export const kernelStateTable = sqliteTable("kernel_state", {
  id: text("id").primaryKey().default("singleton"),
  defaultModel: text("default_model").notNull().default(""),
  permissionMode: text("permission_mode").notNull().default("ask"),
  kvsJson: text("kvs_json").notNull().default("{}"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/** Session index & metadata (replaces KernelRoot.sessions + matches kley's system.assistant_session). */
export const sessionsTable = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    title: text("title").notNull().default(""),
    workspacePath: text("workspace_path").notNull().default(""),
    mode: text("mode", { enum: ["assistant", "agentic"] }).notNull().default("assistant"),
    permissionMode: text("permission_mode").notNull().default("ask"),
    running: integer("running", { mode: "boolean" }).notNull().default(false),
    headTurnId: text("head_turn_id"),
    parentSessionId: text("parent_session_id"),
    parentCallId: text("parent_call_id"),
    depth: integer("depth").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    createdAtMs: integer("created_at_ms").notNull(),
    lastActiveAtMs: integer("last_active_at_ms").notNull(),
    archivedAtMs: integer("archived_at_ms"),
  },
  (t) => [
    index("idx_sessions_active_recent").on(t.archivedAtMs, t.running, t.lastActiveAtMs),
    index("idx_sessions_parent").on(t.parentSessionId, t.parentCallId),
    index("idx_sessions_workspace").on(t.workspacePath, t.lastActiveAtMs),
  ],
);

/** Pending human approvals / asks surfaced across the roster (Attention / Bell / Drawer). */
export const pendingAsksTable = sqliteTable(
  "pending_asks",
  {
    jobId: text("job_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    kind: text("kind", { enum: ["ask", "ack"] }).notNull(),
    object: text("object").notNull(),
    summary: text("summary").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [index("idx_pending_asks_session").on(t.sessionId)],
);
```

### 2.2 Plane 2: Session Trajectory & Durability Tables

```ts
/** Materialized turn records per session for fast pagination and history projection. */
export const sessionTurnsTable = sqliteTable(
  "session_turns",
  {
    turnId: text("turn_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: ["running", "completed", "cancelled", "failed", "interrupted"] }).notNull(),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    reducerExited: integer("reducer_exited", { mode: "boolean" }).notNull().default(false),
    snapshotJson: text("snapshot_json").notNull(), // Serialized PEW tree & chunks for this turn
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
  },
  (t) => [index("idx_session_turns_order").on(t.sessionId, t.ordinal)],
);

/** Append-only revision patch log for active turn streaming & reconnect catch-up. */
export const sessionUpdatesTable = sqliteTable(
  "session_updates",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    incarnation: text("incarnation").notNull(),
    patchJson: text("patch_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.revision] })],
);

/** Durable idempotency ledger for SessionRuntime commands and external effects. */
export const sessionEffectsTable = sqliteTable(
  "session_effects",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    effectKey: text("effect_key").notNull(),
    kind: text("kind", { enum: ["command", "effect"] }).notNull(),
    inputHash: text("input_hash").notNull(),
    outcomeJson: text("outcome_json").notNull(),
    revision: integer("revision").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.effectKey] })],
);

/** Relational blob reference table (replaces O(N) Yjs file scanning in vacuum.ts). */
export const sessionBlobsTable = sqliteTable(
  "session_blobs",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.sessionId, { onDelete: "cascade" }),
    blobId: text("blob_id").notNull(),
    turnId: text("turn_id"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.blobId] }),
    index("idx_session_blobs_blob_id").on(t.blobId),
  ],
);
```

---

## 3. Update Lanes (`LiveShape` Contract)

Instead of syncing the entire `sessions` table when hundreds or thousands of sessions exist, `packages/harness-contract` defines named **Update Lanes** (matching the pattern in `kley`'s `shape-proxy.ts`):

| Lane Name | Parameters | SQL Projection & Filter | Purpose |
| :--- | :--- | :--- | :--- |
| `kernel_meta` | `{}` | `SELECT * FROM kernel_state WHERE id = 'singleton'` | Global model & permission settings. |
| `active_sessions` | `{ workspacePath?: string }` | `WHERE running = 1 OR session_id IN (SELECT session_id FROM pending_asks)` | Always-live lane for busy sessions & sessions awaiting human input. |
| `recent_sessions` | `{ workspacePath?: string; limit: number; beforeMs?: number }` | `WHERE archived_at_ms IS NULL ORDER BY last_active_at_ms DESC LIMIT :limit` | Windowed sidebar/drawer roster (e.g. `limit: 50`), expandable on scroll. |
| `child_sessions` | `{ parentSessionId: string }` | `WHERE parent_session_id = :parentSessionId ORDER BY created_at_ms ASC` | Subagent drawer (`agents-drawer`) for an active parent session. |
| `pending_asks` | `{ sessionId?: string }` | `SELECT * FROM pending_asks` (filtered by `sessionId` if provided) | Global bell / permission prompt notifications. |

### Wire Messages for Update Lanes

```ts
export type ShapeSubscribeFrame = {
  readonly kind: "shape/subscribe";
  readonly subscriptionId: string;
  readonly lane: "kernel_meta" | "active_sessions" | "recent_sessions" | "child_sessions" | "pending_asks";
  readonly params: Record<string, unknown>;
  readonly offset?: number; // Last seen commit seq for fast resume
};

export type ShapeDeltaFrame = {
  readonly kind: "shape/delta";
  readonly subscriptionId: string;
  readonly offset: number;
  readonly upserts: readonly Record<string, unknown>[];
  readonly deletes: readonly string[]; // Primary keys removed from the lane window
  readonly reset?: boolean;            // True on initial load or must-refetch
};
```

---

## 4. Session Trajectory Patch Protocol

When a client attaches to a specific session (`session/attach`), it sends its last cached `revision` (or `0` if uncached):

```ts
export type SessionAttachFrame = {
  readonly kind: "session/attach";
  readonly sessionId: string;
  readonly sinceRevision?: number;
};

export type SessionSyncFrame =
  | {
      readonly kind: "session/snapshot";
      readonly sessionId: string;
      readonly revision: number;
      readonly snapshot: SerializedSessionDocument;
    }
  | {
      readonly kind: "session/patch";
      readonly sessionId: string;
      readonly fromRevision: number;
      readonly toRevision: number;
      readonly patches: readonly ModelPatch[];
    };
```

---

## 5. Verification Criteria for Node 2

- [ ] Drizzle schema compiles cleanly and generates deterministic SQLite DDL migrations.
- [ ] All Zod and TypeScript wire schemas for `ShapeSubscribeFrame`, `ShapeDeltaFrame`, `SessionAttachFrame`, and `SessionSyncFrame` are exported from `@inhuman.tools/harness-contract`.
- [ ] Every Drizzle table exports its `InferSelectModel` and `InferInsertModel` types for consumption in Node 1, Node 4, and Node 5.
