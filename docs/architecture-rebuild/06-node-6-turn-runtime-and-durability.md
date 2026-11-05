# Node 6: Turn Runtime & Durability Pivot (`@inhuman.tools/turn`)

**DAG Position**: Layer 3 (Depends on Node 4 Storage Engine and Node 5 `@inhuman.tools/harness-model`)  
**Packages Modified**: `packages-runtime/turn`  
**Downstream Consumers**: Node 7 (`packages/harness` daemon), Node 11 (`../kley`)

---

## 1. Objective

`packages-runtime/turn` (`SessionRuntime`, `SessionDurability`, `iterateTurn`, `admitTurn`, `recoverSessionJobs`) is the execution engine of Harness. Currently, `src/session-runtime/runtime.ts` and `durability.ts` are coupled to Yjs in three ways:
1. **Ownership binding via `WeakMap<Y.Doc, Binding>`** and listening to `session.doc.on("update")` / `session.doc.on("destroy")`.
2. **Full-document binary checkpoints**: `SessionCheckpoint.state` is `Y.encodeStateAsUpdate(this.session.doc)` (`Uint8Array`), forcing every checkpoint commit to serialize and write the entire session history.
3. **Hidden `Y.Map("harness:session-runtime")`** inside the Yjs doc storing the command/effect idempotency ledger (`operations` and `commands`).

Node 6 replaces all three with **`SessionDocument`**, **incremental structured checkpoints**, and **the relational `session_effects` ledger**.

---

## 2. Refactoring `SessionDurability` & `SessionCheckpoint` (`src/session-runtime/durability.ts`)

Instead of passing an opaque `state: Uint8Array` blob on every commit, `SessionCheckpoint` carries the structured delta produced since the last committed revision:

```ts
export type SessionCheckpoint = {
  readonly sessionId: string;
  readonly incarnation: string;
  readonly fromRevision: number;
  readonly revision: number;
  /** Row-level metadata update for `sessions` table (`running`, `headTurnId`, `lastActiveAtMs`, `title`). */
  readonly sessionRow: Partial<InferInsertModel<typeof sessionsTable>>;
  /** Dirty turns to upsert into `session_turns` (`turnId`, `status`, `snapshotJson`, etc.). */
  readonly dirtyTurns: readonly InferInsertModel<typeof sessionTurnsTable>[];
  /** Active pending asks/acks to sync into `pending_asks` for this session. */
  readonly pendingAsks: readonly InferInsertModel<typeof pendingAsksTable>[];
  /** Incremental patch batch to append to `session_updates` and broadcast to attached clients. */
  readonly patchBatch: SessionPatchBatch;
  /** Newly recorded idempotent command/effect receipts for `session_effects`. */
  readonly effectRecords: readonly InferInsertModel<typeof sessionEffectsTable>[];
};
```

### Why This Solves Both Local SQLite and Cloud Postgres (`kley`) Performance
- **O(delta) Checkpoints**: Committing a checkpoint during a turn writes only the active `SessionTurn` row + a small JSON patch row into `session_updates` + updates `sessions.running` in a single atomic SQL transaction.
- **Automatic Roster Sync**: Because `sessionRow` and `pendingAsks` are part of the atomic checkpoint commit, the Roster Plane (`sessions` and `pending_asks` tables) is **guaranteed** to stay 100% in sync with the Trajectory Plane without manual dual-writing!

---

## 3. Refactoring `SessionRuntime` (`src/session-runtime/runtime.ts`)

1. **Bind to `SessionDocument` Instead of `SessionPlexus` / `Y.Doc`**:
   - Replace `WeakMap<Y.Doc, Binding>` with `WeakMap<SessionDocument, Binding>`.
   - Subscribe to `sessionDoc.onPatch((batch) => ...)` to accumulate dirty turns and patches between `flush()` / `commit()` calls.
2. **Idempotency Ledger (`#operations` & `commands`)**:
   - Instead of reading/writing `session.doc.getMap("harness:session-runtime")`, hydrate the session's active turn effect ledger from `session_effects` on `SessionRuntime.restore(...)` and include new effect records in `SessionCheckpoint.effectRecords`.
3. **Blob Reference Tracking**:
   - When `PromptTextExternalizer` or tool output externalizes a large payload to a blob, record its `blobId` in the turn checkpoint so `session_blobs` is updated atomically in SQLite.

---

## 4. Verification Criteria for Node 6

- [ ] `packages-runtime/turn` has zero dependencies on `yjs` or `@here.build/plexus`.
- [ ] All turn admission, steering, cancellation, crash recovery (`recoverSessionJobs`), and idempotent effect replay tests pass against both `{ kind: "memory" }` and `{ kind: "durable" }` (SQLite) durability backends.
- [ ] Committing 50 sequential streaming checkpoints in a turn performs O(current turn) SQL writes instead of O(total session history) writes.
