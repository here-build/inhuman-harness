# Session execution

`@inhuman.tools/turn/runtime` owns session execution and lifecycle. A local daemon and an embedded host such as Kley bind the same session model, interpreter, command rules, recovery policy, and compaction strategy. Each host supplies its storage, model connections, tool capabilities, notes, and diagnostics.

Import `@inhuman.tools/harness-model/session/register` before creating or restoring a session. It registers session and work models without registering a kernel or project document. Session data and types come from `@inhuman.tools/harness-model/session`.

```ts
import "@inhuman.tools/harness-model/session/register";
import { SessionRuntime } from "@inhuman.tools/turn/runtime";

const runtime = SessionRuntime.create("conversation-id", { kind: "memory" });
runtime.recover({ kind: "interrupt", message: "Interrupted by the host" });
runtime.activate();
```

A restored runtime begins hydrated. The host chooses whether to resume supported jobs or interrupt execution, then activates it. `checkpoint()` returns a Yjs update that `SessionRuntime.restore` accepts. The host owns the session document and destroys it after disposing its runtime. A replacement runtime bound to the same document revokes the old runtime’s signal and effect ownership.

Use memory durability for an explicitly transient session. For durable sessions, supply `commit(checkpoint)`, persist `checkpoint.state`, and acknowledge its session, incarnation, and revision only after that write is durable. The runtime holds admission until the checkpoint is acknowledged. Storage may commit and lose its acknowledgement; retrying the same command or effect identity must preserve the existing result.

After recovering unfinished state, acknowledge its checkpoint before activating dependent work. A failed checkpoint remains held; the host retries `flush()` when storage recovers. The local daemon exposes that retry through `turn/retry`, while Kley also retries persistence in the background and durably interrupts abandoned execution.

`effect(operationId, method, payload, port, apply)` is the host effect boundary. Requests carry strings and execution identity; results distinguish success, refusal, and an unknown dispatch outcome. The runtime records intent before dispatch and checks ownership before applying a result. Reconciliation of interrupted effects belongs to the supplied port. Give each logical operation a stable identity across retries, and apply model changes inside the runtime’s result callback.

The interpreter’s `TurnIteratorHost` and `createTurnResolvers` are trusted in-process strategies. They operate on the owned work model and must propagate abort signals through provider and tool adapters. An external service should receive the data-only effect request rather than a mutable session node. Filesystem access is a host capability: local tools may provide it, while a cloud host may refuse it or route it through a bridge.

`signal` stops ordinary execution on park. `ownershipSignal` stops work when the document binding is replaced, disposed, or destroyed; it stays live during a park so a host can drain an already dispatched obligation. `isCurrent` fences those retained result writes. It does not authorize new admission. Built-in mutable adapters check this binding before applying asynchronous results; an injected strategy must do the same.

`@inhuman.tools/turn/resources` exports `bundledCompactProgram()` and `createModuleBundle()`. The bundled strategy includes its prompt text in the package. A module bundle captures a resource identity, revision, and namespace-confined loader. Compaction checkpoints its captured source and imported modules for replay; the interpreter does not open a workspace filesystem to resolve these resources.

The other public entries expose session commands (`/session`), transcript projection (`/context`), agent-call rules (`/agent-calls`), catalog construction (`/catalog`), and tool execution (`/tool-runtime`). Import the entry matching the host’s responsibility.

The current runtime import graph reaches Arrival's TypeScript diagnostics through `arrival/lsp-internals`. The session model imports `BASE_ROSTER` there, and Scheme execution uses its tokenizer. This package declares TypeScript at runtime because Arrival currently declares the compiler only as a development dependency. Removing it breaks a clean runtime import. Removing the compiler from the shipped graph requires narrower upstream exports for those runtime utilities.

## Qualification

Run `pnpm exec vitest run src/runtime/__tests__ src/session-runtime/__tests__ src/resources/__tests__` in this package for interpreter, lifecycle, and resource laws. These tests use actual session documents, command admission, catalogs, and result transitions with scripted external responses.

After building this package and its workspace dependencies, run `node --test scripts/session-runtime.test.mjs` from the repository root. The test packs workspace dependencies, copies installed external dependency versions, and recreates their graph in a temporary consumer. Every dependency link stays inside that consumer; no source aliases or workspace links are available. It compiles the public TypeScript surface and starts a fresh process with only session registration. The process restores a genuine model-0.1 session, admits and executes another turn, restores a committed effect without applying it twice, and runs the shipped compaction strategy. An import guard rejects kernel registration, filesystem loaders, and dependencies escaping the candidate graph.
