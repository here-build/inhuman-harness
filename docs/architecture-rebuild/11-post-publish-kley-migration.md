# Post-Publish Cluster (Node 11): `../kley` Migration Plan

**DAG Position**: Post-Publish (Executed in `/Users/jabher/WebstormProjects/kley` **after** Nodes 1–8 are verified and the updated `@inhuman.tools/model`, `@inhuman.tools/plexus-expectations`, `@inhuman.tools/harness-model`, `@inhuman.tools/turn`, `@inhuman.tools/harness-contract`, and `@inhuman.tools/harness-client` packages are published)

---

## 1. Why `kley` Benefits Directly From This Rebuild

`kley` already uses **Postgres database-per-team (`t_<md5>`) + on-demand ElectricSQL + `LiveShape`** for its core product, including `system.assistant_session`. However, because `@inhuman.tools/harness-model` and `@inhuman.tools/turn` previously required Yjs (`SessionPlexus`), `kley` had to maintain four costly workarounds that this migration eliminates:

1. **Full-Blob `state bytea` Overwrites in Postgres WAL**: `Persister` in `server/kley/src/assistant/agent-session.ts` and `flush()` in `assistant-sessions.ts` ran `Y.encodeStateAsUpdate(doc)` every 300ms, overwriting the entire accumulated binary session snapshot in `system.assistant_session_doc`.
2. **Client Dual-`Y.Doc` (`#wire` + `#doc`) + Manual `tick` Hack**: `client/web/src/document/assistant-session.ts` had to allocate two `Y.Doc` instances (`#wire` and `#doc`) so `SessionPlexus.connect` wouldn't write hydration mutations back onto the read-only wire socket, plus manually increment `this.tick += 1` on every update.
3. **Hydrating Parent/Child Yjs Docs Just to Reconcile Subagent Callbacks**: `reconcileAgentCallbacks` in `agent-session.ts` had to load parent and child `SessionPlexus` blobs into memory and walk their trees (`walkWork`) to see if a child `AgentCallJob` settled.
4. **Ephemeral `SessionPlexus` in `@kley/execution` (`agentik`)**: `server/execution/src/runtime/ask.ts` had to spin up an in-memory `SessionPlexus.create(...)` just to run `@inhuman.tools/turn` primitives.

---

## 2. Server-Side Migration in `../kley`

### 2.1 Team Database Schema Upgrade (`server/kley/base-template.sql` & `assistant-sessions.ts`)
Replace the monolithic `system.assistant_session_doc (session_id, state bytea)` overwrite pattern with structured turn/delta persistence in the team database:
- **`system.assistant_session`**:
  - Already synced via Electric `LiveShape` (`shape=assistant_sessions` in `server/kley/src/realtime/shape-proxy.ts`).
  - Add `revision integer not null default 0` and `head_turn_id uuid`.
- **`system.assistant_session_turn`**:
  - Stores per-turn rows `(session_id, turn_id, ordinal, status, snapshot jsonb, updated_at)` so each checkpoint only upserts the active turn (`O(active turn)` instead of `O(entire session history)`).
- **`system.assistant_session_effect`**:
  - Stores the `SessionRuntime` idempotency ledger `(session_id, effect_key, kind, input_hash, outcome jsonb, revision)`.

### 2.2 `server/kley/src/assistant/agent-session.ts` & `turn-runtime.ts`
- Replace `SessionPlexus` with `SessionDocument` from `@inhuman.tools/harness-model/session`.
- Remove `import * as Y from "yjs"` and `restored(sessionId, state: Uint8Array)`.
- Update `Persister.commit(checkpoint: SessionCheckpoint)`:
  - Writes `checkpoint.sessionRow` (`running`, `revision`, `head_turn_id`) to `system.assistant_session` and upserts `checkpoint.dirtyTurns` into `system.assistant_session_turn` in one Postgres transaction.
  - Broadcasts `checkpoint.patchBatch` (`session/patch` JSON frame) to connected WebSocket clients for that session.
- Simplify `reconcileAgentCallbacks`:
  - Query child completion status directly from SQL (`system.assistant_session` + `system.assistant_session_turn`) instead of hydrating full Yjs documents when not needed.

### 2.3 `server/execution/src/runtime/ask.ts` (`@kley/execution`)
- Replace `SessionPlexus.create(...)` with `SessionDocument.create(...)`.
- Remove `yjs` and `@here.build/plexus` from `server/execution/package.json`.

---

## 3. Client-Side Migration in `../kley/client/web`

### 3.1 `client/web/src/document/assistant-session.ts`
- **Delete**:
  - `import * as Y from "yjs"`
  - `import * as syncProtocol from "y-protocols/sync"`
  - `import * as encoding from "lib0/encoding"` / `decoding`
  - Dual `readonly #wire = new Y.Doc()` and `readonly #doc = new Y.Doc()`
  - Manual `tick = 0` observable counter
- **Replace with**:
  - Single `SessionDocument` instance hydrated from the initial `session/snapshot` frame and updated in-place via `this.#doc.applyPatchBatch(frame.patches)` on `session/patch` frames.
  - Because every field on `SessionRoot`, `SessionTurn`, and `Job` is now a native `@column` / `@state` MobX observable (Node 1 & Node 5), `@computed get messages()` (`sessionMessages(this.#doc.root)`) and `@computed get busy()` (`sessionBusy(this.#doc.root)`) track dependencies automatically without `void this.tick`.

---

## 4. Verification Criteria for Node 11 (`../kley`)

- [ ] `server/kley`, `server/execution`, and `client/web` have zero dependencies on `yjs`, `y-protocols`, `lib0`, or `@here.build/plexus`.
- [ ] Postgres WAL write volume during a 10-turn agentic session drops by $>90\%$ (no full-session `bytea` overwrites every 300ms).
- [ ] All assistant session unit and integration tests in `server/kley`, `server/execution`, and `client/web` pass.
