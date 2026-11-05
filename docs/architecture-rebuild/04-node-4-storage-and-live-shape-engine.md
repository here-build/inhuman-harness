# Node 4: SQLite Storage Engine & `LiveShape` Reactive Lanes

**DAG Position**: Layer 1 (Depends on Node 2 `@inhuman.tools/harness-contract`)  
**Packages Modified / Replaced**: `packages/scope-plane`, `packages/scope-plane-electric`, `packages/scope-plane-tinybase` (replaced by SQLite + `LiveShape` engine)  
**Downstream Consumers**: Node 6 (`packages-runtime/turn`), Node 7 (`packages/harness` daemon), Node 8–10 (Clients)

---

## 1. Objective

Build the relational storage engine and reactive **Update Lane (`LiveShape`)** pipeline that backs both local standalone `harness` (via `better-sqlite3` + Drizzle) and remote clients (over WebSocket shape subscriptions), modeled after the battle-tested `LiveShape` + `shape-proxy` pattern in `../kley`.

---

## 2. Server-Side: SQLite + Drizzle Engine (`HarnessDatabase`)

### 2.1 Single WAL-Mode SQLite Store (`harness.db`)
Replaces the directory of `.yjs` binary files (`packages/harness/src/yjs/storage.ts` and `update-log.ts`) with a single `better-sqlite3` database wrapped in Drizzle ORM:
- Configured on open with:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```
- Schema migrations run automatically on startup from the canonical Drizzle schema defined in Node 2 (`kernel_state`, `sessions`, `pending_asks`, `session_turns`, `session_updates`, `session_effects`, `session_blobs`).

### 2.2 Transaction Commit Notifier & Lane Invalidator
Instead of polling SQLite, every Drizzle write transaction goes through `db.WriteTransaction((tx) => ...)`, which records touched tables and primary keys:
1. When a transaction commits (e.g., updating `sessions.running` or inserting into `pending_asks`), a monotonic `commitOffset` increments.
2. Active server-side **Update Lane Evaluators** (`kernel_meta`, `active_sessions`, `recent_sessions`, `child_sessions`, `pending_asks`) whose source tables intersect the touched tables re-evaluate their parameterized Drizzle query.
3. Each lane evaluator diffs the new row set against its last emitted row map `(pk -> rowHash)` and emits a `ShapeDeltaFrame` (`{ subscriptionId, offset, upserts, deletes }`) only if rows entered, changed, or left the lane window.

---

## 3. Client-Side: MobX `LiveShape<TRow>`

Adapted directly from `../kley/client/web/src/document/live-shape.ts` so both `harness-web-app` and `kley` share the exact same reactive primitive:

```ts
import { createAtom, observable, runInAction, type IAtom } from "mobx";
import type { Model } from "@inhuman.tools/model";

export class LiveShape<TRow extends { readonly [K in TKey]: string }, TModel extends Model<TRow>, TKey extends keyof TRow> {
  readonly #atom: IAtom;
  readonly #items = observable.map<string, TModel>([], { deep: false });
  #synced = observable.box(false);
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly lane: string,
    private readonly params: Record<string, unknown>,
    private readonly keyField: TKey,
    private readonly ModelCtor: new (row: TRow) => TModel,
    private readonly transport: ShapeTransport,
  ) {
    this.#atom = createAtom(
      `LiveShape:${lane}`,
      () => this.#onBecomeObserved(),
      () => this.#onBecomeUnobserved(),
    );
  }

  get rows(): ReadonlyMap<string, TModel> {
    this.#atom.reportObserved();
    return this.#items;
  }

  get list(): readonly TModel[] {
    this.#atom.reportObserved();
    return [...this.#items.values()];
  }

  get synced(): boolean {
    this.#atom.reportObserved();
    return this.#synced.get();
  }

  applyDelta(frame: ShapeDeltaFrame): void {
    runInAction(() => {
      if (frame.reset) this.#items.clear();
      for (const id of frame.deletes) {
        this.#items.delete(id);
      }
      for (const raw of frame.upserts) {
        const row = raw as unknown as TRow;
        const id = row[this.keyField];
        const existing = this.#items.get(id);
        if (existing != null) {
          existing.applyRow(row); // Updates only changed @column accessors in-place!
        } else {
          this.#items.set(id, new this.ModelCtor(row)); // Triggers Node 1 Drizzle schema audit on 1st call!
        }
      }
      this.#synced.set(true);
    });
  }
}
```

### Key Properties of `LiveShape`
- **Lazy Subscription Lifecycle**: Connects to the lane only when a MobX observer (`observer` React component, `computed`, or `reaction`) reads `.rows` or `.list`, and unsubscribes after a 3-second grace window when unobserved.
- **In-Place Entity Updates**: When a row in `recent_sessions` updates (`running: true -> false`), `existing.applyRow(row)` updates only the changed `@column` MobX accessor on the existing `SessionRecord` instance, so unaffected UI rows do not re-render.
- **Bounded Memory**: When the user scrolls or switches workspaces, rows leaving the lane window arrive in `frame.deletes` and are evicted from `#items`.

---

## 4. Verification Criteria for Node 4

- [ ] Inserting 1,000 sessions into SQLite and subscribing to `recent_sessions (limit: 50)` loads only 50 `SessionRecord` instances into memory.
- [ ] Mutating a session from `running = false` to `running = true` immediately pushes an upsert into both `active_sessions` and `recent_sessions` within the same tick.
- [ ] Unobserving a `LiveShape` disposes the underlying subscription after the grace period and resumes cleanly from `offset` upon re-observation.
