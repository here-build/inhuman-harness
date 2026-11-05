# Node 5: Harness Domain Models Migration (`@inhuman.tools/harness-model`)

**DAG Position**: Layer 2 (Depends on Node 1 `@inhuman.tools/model`, Node 2 `@inhuman.tools/harness-contract`, and Node 3 `@inhuman.tools/plexus-expectations`)  
**Packages Modified**: `packages/harness-model`  
**Downstream Consumers**: Node 6 (`packages-runtime/turn`), Node 7 (`packages/harness`), Node 8 (`harness-web-app`, `harness-transcript`), Node 10 (`harness-ios-app`), Node 11 (`../kley`)

---

## 1. Objective

Detach `packages/harness-model` completely from `@here.build/plexus` and `yjs`:
1. Migrate all session and kernel model classes (`SessionRoot`, `SessionTurn`, `CallJob` hierarchy, `PromptMessage`, `RegisteredToolsSet`, `ToolSpec`, `KernelRoot`) to `@inhuman.tools/model` (`@model`, `@column`, `@state`).
2. Replace `SessionPlexus` and `KernelPlexus` (`Y.Doc` wrappers) with pure MobX + Drizzle-validated containers: **`SessionDocument`** and **`KernelRowStore`**.

---

## 2. Replacing `KernelPlexus` & `KernelRoot`

Previously, `KernelPlexus` held a monolithic `Y.Doc` containing a `KernelRoot` with an unbounded map of every session ever created.

### New Design
- **`KernelRecord`** (`@model("harness:kernel:state", kernelStateTable)`):
  - Binds `@column` accessors directly to `kernelStateTable` (`defaultModel`, `permissionMode`, `kvsJson`, `updatedAtMs`).
- **`SessionSummaryRecord`** (`@model("harness:session:summary", sessionsTable)`):
  - Binds `@column` accessors directly to `sessionsTable` (`sessionId`, `title`, `workspacePath`, `mode`, `permissionMode`, `running`, `headTurnId`, `parentSessionId`, `parentCallId`, `depth`, `revision`, `createdAtMs`, `lastActiveAtMs`, `archivedAtMs`).
- **`PendingAskRecord`** (`@model("harness:session:pending-ask", pendingAsksTable)`):
  - Binds `@column` accessors directly to `pendingAsksTable` (`jobId`, `sessionId`, `turnId`, `kind`, `object`, `summary`, `createdAtMs`).

All three are statically checked against Drizzle's `SQLiteTable` definitions at compile time and audited on first instantiation (Node 1).

---

## 3. Migrating `SessionRoot`, `SessionTurn`, and Jobs

### 3.1 `SessionRoot` (`src/session/SessionRoot.ts`)
- Decorated with `@model("harness:session:root", sessionsTable)`.
- Top-level session metadata (`sessionId`, `workspacePath`, `permissionMode`, `mode`, `running`) binds directly to `sessionsTable` columns via `@column(...)` (no local defaults).
- Trajectory collections use `@state`:
  - `@state.childList accessor liveTurns!: SessionTurn[]`
  - `@state.ref accessor head!: SessionTurn | null` (serialized as `headTurnId` UUID reference, linked in Pass 2 of hydration)
  - `@state.record accessor kvs!: Record<string, string>`
  - `@state.record accessor agentCallbacks!: Record<string, string>`

### 3.2 `SessionTurn` (`src/session/SessionTurn.ts`)
- Decorated with `@model("harness:session:turn", sessionTurnsTable)`.
- Binds turn metadata columns (`turnId`, `sessionId`, `ordinal`, `prompt`, `status`, `cancelRequested`, `reducerExited`, `startedAtMs`, `endedAtMs`) via `@column(sessionTurnsTable.*)`.
- Binds in-turn PEW work lists via `@state.childList`:
  - `@state.childList accessor doneWork!: WorkContainer[]`
  - `@state.childList accessor queue!: WorkContainer[]`
  - `@state.child accessor tools!: RegisteredToolsSet`

### 3.3 Job & Expectation Subclasses (`src/session/jobs/*`, `src/session/expectations/*`)
Migrate all `@syncing("harness:...")` classes to `@model("harness:...")` and `@state`:
- `CallJob`, `AgentCallJob`, `BotCallJob`, `ShellJob`, `ProgramJob`, `CompletionJob`, `ToolCallJob`, `AskJob`, `AckJob`
- `PromptMessage`, `ToolSpec`, `RegisteredToolsSet`
- Preserve all `@computed` getters (`result`, `systemPrompt`, `speech`, `description`, `outcomeSnap`) without modification.

---

## 4. `SessionDocument` (Replaces `SessionPlexus`)

`SessionDocument` is the lightweight, zero-Yjs root container for a hydrated session:

```ts
export class SessionDocument {
  readonly sessionId: string;
  readonly root: SessionRoot;
  @observable.ref accessor revision: number;
  readonly #listeners = new Set<(batch: SessionPatchBatch) => void>();

  static create(row: InferSelectModel<typeof sessionsTable>): SessionDocument;
  static fromSnapshot(snapshot: SerializedSessionDocument): SessionDocument;

  toSnapshot(): SerializedSessionDocument;
  applyPatchBatch(batch: SessionPatchBatch): void;
  onPatch(listener: (batch: SessionPatchBatch) => void): () => void;
  destroy(): void;
}
```

- **No Dual-Doc Needed**: Because reading or hydrating `SessionDocument` never emits spurious CRDT writes, clients (`harness-web-app`, `kley`, `harness-ios-app`) attach a single `SessionDocument` and call `doc.applyPatchBatch(batch)` as frames arrive from the server.

---

## 5. Verification Criteria for Node 5

- [ ] `packages/harness-model` has zero imports from `@here.build/plexus` or `yjs`.
- [ ] Instantiating `KernelRecord`, `SessionSummaryRecord`, `PendingAskRecord`, `SessionRoot`, and `SessionTurn` passes the Node 1 Drizzle schema audit.
- [ ] Mutating `SessionRoot` / `SessionTurn` / `AgentCallJob` inside a MobX action on a server `SessionDocument` emits a `SessionPatchBatch` that, when applied to a replica `SessionDocument`, yields an identical object graph and identical `@computed` projections.
