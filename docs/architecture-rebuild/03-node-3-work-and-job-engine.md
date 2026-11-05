# Node 3: Work & Job Engine Migration (`@inhuman.tools/plexus-expectations`)

**DAG Position**: Layer 1 (Depends on Node 1 `@inhuman.tools/model`)  
**Packages Modified**: `packages/plexus-expectations`  
**Downstream Consumers**: Node 5 (`packages/harness-model`), Node 6 (`packages-runtime/turn`)

---

## 1. Scope & Objective

`packages/plexus-expectations` (PEW) defines the reactive work graph (`WorkContainer`, `WorkExpectation`, `Job`, `Outcome`, `FailureOutcome`, `SuccessOutcome`) and the two-phase reactive `Orchestrator` (`orchestrator.ts`).

Crucially, **PEW's execution semantics already rely on MobX (`reaction`, `when`, `computed`, `runInAction`)—not Yjs CRDT conflict resolution**. Its coupling to `@here.build/plexus` is limited to:
1. Base class inheritance (`WorkContainer extends PlexusModel`).
2. `@syncing` decorators on model properties.
3. `kernel-intern.ts` using `Plexus` internals for interning shared definitions.

This step ports `packages/plexus-expectations` to `@inhuman.tools/model` (Node 1) and removes `yjs` and `@here.build/plexus` from its dependencies.

---

## 2. File-by-File Migration Plan

### 2.1 `src/shared/models/WorkContainer.ts`
- **Current**: `export abstract class WorkContainer extends PlexusModel implements Promise<WorkFulfillment>` with `@syncing accessor startedAtMs` and `@syncing accessor endedAtMs`.
- **Target**:
  - Extend `Model` from `@inhuman.tools/model`.
  - Replace `@syncing` with `@state` (no local default initializers; `startedAtMs` and `endedAtMs` hydrate as `number | null` from the node constructor/snapshot).
  - Preserve `then`, `catch`, `finally` (`when(() => this.endedAtMs != null)`), `markStarted`, `markEnded`, `durationMs`, and `walkWork`.

### 2.2 `src/shared/models/WorkExpectation.ts` & Outcomes
- **Current**: `@syncing("@inhuman.tools/plexus-expectations:WorkExpectation")`, `@syncing.child accessor outcome`, `@syncing.child.list accessor subexpectations`.
- **Target**:
  - Decorate with `@model("@inhuman.tools/plexus-expectations:WorkExpectation")`.
  - Replace `@syncing.child` with `@state.child` and `@syncing.child.list` with `@state.childList`.
  - Migrate `Outcome`, `SuccessOutcome`, and `FailureOutcome` to `@model(...)` + `@state`.

### 2.3 `src/shared/models/Job.ts`
- **Current**:
  - `@syncing.child.list accessor children: Job<unknown, unknown>[] = []`
  - `@syncing.list accessor after: Job<unknown, unknown>[] = []`
  - `@syncing accessor background`, `walkBoundary`, `orchestrationResult`, `cancelled`, `completed`, `crash`
  - `@syncing.action markComplete()`, `@syncing.action stampAfter()`
- **Target**:
  - Decorate with `@model("@inhuman.tools/plexus-expectations:Job")`.
  - Replace `@syncing.child.list` on `children` with `@state.childList` (owned child jobs).
  - Replace `@syncing.list` on `after` with `@state.refList` (serialized as `uuid[]` pointers to earlier sibling jobs, resolved in Pass 2 of hydration).
  - Replace `@syncing.action` with `@state.action` (MobX `@action`).
  - Keep `@computed get afterReleased()`, `@computed get orchestrated()`, and `Promise<TValue>` settlement logic (`when(() => this.result !== null)`) untouched.

### 2.4 `src/executor/orchestrator.ts` & `src/executor/kernel-intern.ts`
- **`orchestrator.ts`**:
  - Already uses MobX `reaction` and `runInAction` to watch `walkWork(root)` and drive Phase 1 (license guard $\rightarrow$ `orchestrationResult`) and Phase 2 (executor body $\rightarrow$ `markComplete`).
  - Remove any `Plexus` container type references; accept any `WorkContainer` root or `DocumentContainer`.
- **`kernel-intern.ts`**:
  - Replace `Plexus`-backed interning with `DocumentContainer` node registry lookup by deterministic key/UUID.

---

## 3. Dependency Cleanup

In `packages/plexus-expectations/package.json`:
- **Remove**: `@here.build/plexus`, `yjs` (from `dependencies`, `devDependencies`, and `peerDependencies`).
- **Add**: `@inhuman.tools/model: "workspace:^"`, `mobx: "6.16.1"`.

---

## 4. Verification Criteria for Node 3

- [ ] All existing unit tests in `packages/plexus-expectations/src/__tests__/` (`job-orchestrator.test.ts`, `kernel-intern.test.ts`, `presence.test.ts`) pass without `Y.Doc` or `@here.build/plexus`.
- [ ] Snapshot round-trip test: a complex `Job` graph with nested `children`, `after` sibling dependencies, and settled `WorkExpectation` outcomes serializes to JSON and hydrates back via two-pass hydration with `afterReleased` and `await job` resolving identically.
