# Node 8: Web App, Transcript & SDK Clients Migration

**DAG Position**: Layer 5 (Depends on Node 5 `@inhuman.tools/harness-model` and Node 7 Daemon & Transport)  
**Packages Modified**: `packages/harness-web-app`, `packages/harness-transcript`, `packages/harness-client`, `packages/harness-sdk`  
**Downstream Consumers**: Node 10 (`harness-ios-app` shares `Dial` and `harness-transcript`), Node 11 (`../kley` web client)

---

## 1. Objective

Migrate the browser and TypeScript SDK clients from `y-websocket` + IndexedDB Yjs update-log caching (`doc-cache.ts`) to:
1. **`LiveShape` Update Lanes** for the sidebar roster, workspace switcher, subagent drawer, and attention/ask badges.
2. **`SessionStore` (`SessionDocument` + Revision Cache)** for the active session transcript.

---

## 2. Migrating `packages/harness-web-app`

### 2.1 `src/client/dial.ts`
- **Current**: Opens `WebsocketProvider` (`y-websocket`) per room (`kernel` room + one room per opened `sessionId`) alongside the JSON-RPC WebSocket.
- **Target**:
  - Uses a **single** multiplexed WebSocket connection per host daemon.
  - Exposes pre-configured `LiveShape` instances:
    - `dial.kernelMeta`: `LiveShape` for `kernel_meta`
    - `dial.activeSessions`: `LiveShape` for `active_sessions`
    - `dial.recentSessions(limit)`: `LiveShape` for `recent_sessions`
    - `dial.pendingAsks`: `LiveShape` for `pending_asks`
    - `dial.childSessions(parentSessionId)`: `LiveShape` for `child_sessions`
  - Exposes `dial.attachSession(sessionId)` which returns a reactive `SessionHandle` backed by `SessionDocument`.

### 2.2 `src/client/doc-cache.ts` (IndexedDB Revision & Snapshot Cache)
- **Current**: Stores an append-only array of binary Yjs `Uint8Array` updates per room key in IndexedDB and compacts them on a timer by replaying them into a throwaway `Y.Doc`.
- **Target**:
  - Stores `{ sessionId, revision, snapshot: SerializedSessionDocument, savedAtMs }` in IndexedDB (with LRU eviction capped at e.g. 50 recently viewed sessions).
  - On `dial.attachSession(sessionId)`:
    1. Hydrates `SessionDocument.fromSnapshot(cached.snapshot)` immediately for instant 0-RTT rendering.
    2. Sends `{ kind: "session/attach", sessionId, sinceRevision: cached.revision }`.
    3. Applies incoming `session/patch` frames (`doc.applyPatchBatch(batch)`) and persists the updated snapshot to IndexedDB on idle debounce.

---

## 3. Migrating `packages/harness-transcript` (`src/tape.tsx`)

- `packages/harness-transcript` already renders `SessionRoot` / `SessionTurn` / `WorkContainer` using `mobx-react-lite` (`observer`).
- Because Node 5 preserves all `SessionRoot`, `SessionTurn`, and `Job` `@computed` properties on native MobX, `tape.tsx` requires only import/type updates (`SessionPlexus` $\rightarrow$ `SessionDocument`) with zero visual regressions.

---

## 4. Migrating `packages/harness-sdk` & `packages/harness-client`

- Remove `yjs` and `@here.build/plexus` from `packages/harness-sdk/package.json`.
- Update SDK session helpers to attach via the multiplexed `session/attach` stream or one-shot RPC queries.

---

## 5. Verification Criteria for Node 8

- [ ] `packages/harness-web-app`, `packages/harness-transcript`, and `packages/harness-sdk` have zero dependencies on `yjs`, `y-websocket`, or `@here.build/plexus`.
- [ ] Opening the web app with 1,000 sessions in the daemon DB fetches only the 50 rows in `recent_sessions` plus `active_sessions` and renders in `< 50 ms`.
- [ ] Switching between sessions hydrates cached sessions from IndexedDB immediately and catches up via `sinceRevision` delta patches.
