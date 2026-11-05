# Node 7: Harness Daemon, Peer Transport & Relay Migration

**DAG Position**: Layer 4 (Depends on Node 4 Storage/`LiveShape` and Node 6 `@inhuman.tools/turn`)  
**Packages Modified**: `packages/harness`, `packages/harness-peer`, `packages/harness-relay`  
**Downstream Consumers**: Node 8 (Web/SDK), Node 9 (Rust Ratatui TUI), Node 10 (Mobile iOS App)

---

## 1. Objective

Remove the entire Yjs document/room server subsystem (`packages/harness/src/yjs/*`) and rewire the Harness Daemon (`HarnessDaemon`, `KernelDaemon`, `SessionDaemon`), peer transport (`harness-peer`), and remote relay (`harness-relay`) to serve:
1. **JSON-RPC commands** (unchanged request/response semantics).
2. **`LiveShape` Update Lanes** (`shape/subscribe` $\rightarrow$ `shape/delta`) for the Roster & Control Plane.
3. **Session Trajectory Patch Streams** (`session/attach` $\rightarrow$ `session/snapshot` + `session/patch`) for active sessions.

---

## 2. Deleting `packages/harness/src/yjs/*`

The following files become obsolete and are deleted outright:
- `packages/harness/src/yjs/document-service.ts`
- `packages/harness/src/yjs/storage.ts`
- `packages/harness/src/yjs/update-log.ts`
- `packages/harness/src/yjs/rooms.ts`
- `packages/harness/src/yjs/relay.ts`
- `packages/harness/src/yjs/bin.ts`

And in `packages/harness/package.json`, remove `yjs`, `y-protocols`, `y-websocket`, `lib0`, and `@here.build/plexus`.

---

## 3. Rewiring the Daemon Planes (`packages/harness/src/server/daemon/`)

### 3.1 `HarnessDaemon.ts` & `KernelDaemon.ts`
- **Startup**: Opens `HarnessDatabase` (`harness.db` via Node 4) in the daemon data directory.
- **Crash Recovery on Boot**:
  - Instead of scanning `.yjs` files on disk, runs a single indexed SQL query:
    ```sql
    SELECT session_id FROM sessions WHERE running = 1
    ```
  - Hydrates only those interrupted sessions, runs `SessionRuntime.recover(...)`, and flushes their settled state. Idle historical sessions remain untouched on disk (`0 MB` RAM).
- **Subagent Reconciliation (`agent-calls`)**:
  - Parent-child subagent queries (`WHERE parent_session_id = ?`) run directly against `sessionsTable` in SQLite.

### 3.2 `SessionDaemon.ts`
- **On-Demand Hydration & Idle Eviction**:
  - Hydrates a `SessionDocument` + `SessionRuntime` from `sessions` + `session_turns` only when a client attaches (`session/attach`) or a turn is running.
  - When a `SessionCheckpoint` commits (Node 6), `SessionDaemon` writes the checkpoint transactionally to `HarnessDatabase` and broadcasts the `session/patch` frame to all sockets attached to `sessionId`.
  - When `connections === 0` and `!running` for `IDLE_EVICT_MS`, evicts the `SessionDocument` from memory and compacts old rows in `session_updates` for that session (since `session_turns` already holds the materialized turn snapshots).

### 3.3 Instant SQL Blob Vacuuming (`packages/harness/src/server/blobs/vacuum.ts`)
- **Before**: Loaded every `.yjs` session file into a `Y.Doc` in memory and walked its tree to find referenced blob IDs.
- **After**: Runs a single indexed query against `session_blobs`:
  ```sql
  SELECT DISTINCT blob_id FROM session_blobs
  ```
  and deletes unreferenced blob files from the blob store in milliseconds.

---

## 4. Multiplexed Transport (`accept.ts`, `harness-peer`, `harness-relay`)

- **Single Multiplexed WebSocket Connection**:
  - Retains the existing JSON-RPC channel (`harness-client` / `harness-peer`).
  - Replaces binary `y-websocket` sync frames with typed JSON/MessagePack frames for `shape/subscribe` / `shape/delta` and `session/attach` / `session/snapshot` / `session/patch`.
- **`harness-relay` (`packages/harness-relay`)**:
  - Forwards the multiplexed WebSocket stream end-to-end encrypted between remote clients (Web / iOS) and the host daemon without needing any Yjs room awareness.

---

## 5. Verification Criteria for Node 7

- [ ] `HarnessDaemon` cold-starts in `< 20 ms` even with 5,000 historical sessions in `harness.db`.
- [ ] Reconnecting a client with `sinceRevision: N` replays only patches `N + 1 .. currentRevision` from `session_updates` (or sends a fresh snapshot if compacted).
- [ ] `vacuum.ts` completes without hydrating any `SessionDocument` into memory.
- [ ] All server & process integration tests (`pnpm --filter @inhuman.tools/harness test` and `test:process`) pass.
