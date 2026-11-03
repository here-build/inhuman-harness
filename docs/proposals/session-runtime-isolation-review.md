# Astra review of portable session runtime

Reviewer: GPT-6 Astra. Date: 2026-11-02.

Subject: [Portable session runtime rework](session-runtime-isolation.md).

Initial verdict: the direction is sound and the QA strategy exercises stronger
boundaries than a copied iterator with cooperative mocks. Approval was
conditional on the five revisions below. The proposal now incorporates those
revisions. Follow-up review confirmed that all five findings are addressed in
the proposal. Architecture and QA plan approved; implementation and
qualification are recorded below.

The findings below condense Astra's review of the initial draft and relevant
Inhuman/Kley source. Section links refer to the revised proposal.

## P1 Require shared lifecycle adoption in Kley

The initial stage-5 gate could pass after deleting copied iterator/compaction
code while Kley retained independent hydration, recovery, cancellation and
settlement. That did not establish the stronger goal of one shared session
implementation. Kley's current
[session hydration](../../../kley/server/kley/src/assistant/agent-session.ts)
and [interrupted-turn handling](../../../kley/server/kley/src/assistant/turn-runtime.ts)
demonstrate the second lifecycle that needs adaptation.

Applied revision: [stage 5](session-runtime-isolation.md#5-migrate-kley-as-the-second-consumer)
requires the actual Agentic composition to enter through the shared lifecycle.
Stop-on-interruption is a supported host policy implemented by shared mechanisms,
with delivery obligations reconciled. The older table assistant stays a separate
profile. Stage 2 now includes an early Kley integration proof before stabilizing
the API.

## P1 Make settlement recoverable across document commits

A rejecting durable flush is necessary but does not by itself fix settlement.
Kley's [callback resolver](../../../kley/server/kley/src/agentic/driver.ts)
completes the parent in memory before its flush, while
[child cleanup](../../../kley/server/kley/src/agentic/subagents.ts) can remove and
flush the callback in `finally` before a parent flush succeeds. Interruption
cleanup also clears callbacks. These paths can erase a delivery obligation while
the corresponding result is not durable. Optimistic in-memory completion can
also become visible to scheduling before the durable barrier.

Applied revision: stage 5 and the
[behavioral laws](session-runtime-isolation.md#behavioral-laws) require stable
delivery/settlement identities and recoverable acknowledgements across caller,
worker and host lineage records. Callback cleanup requires a covering parent
receipt on success, exception, cancellation and interruption paths. Provisional
completion cannot authorize continuation. QA includes a failed parent commit
followed by potentially successful child cleanup and every relevant commit
boundary.

## P1 Test committed writes with lost acknowledgements

The initial deterministic recovery strategy retained only acknowledged state.
That excluded a storage commit that succeeded before its response was lost. An
intent, result, command receipt or callback acknowledgement can already be in
storage when the runtime observes failure. This is a different window from an
external effect whose response was lost.

Applied revision:
[failure ordering](session-runtime-isolation.md#failure-ordering-and-adapter-proof)
controls storage commit and acknowledgement delivery independently. Recovery
restores actual committed bytes, including unacknowledged writes, and retries
through public APIs. Failed-before-commit and committed-with-lost-acknowledgement
are separate observations, backed by the independent endpoint ledger.

## P2 Preserve source module confinement

The initial resource proposal covered portability without preserving all of the
existing loader's authority boundary. The
[current source loader](../../packages-runtime/scheme-program/src/source-fs.ts)
checks real paths and prevents imports escaping the source root. Compaction
installs a restricted module loader. A general remote resolver must preserve
equivalent restrictions.

Applied revision: the [resource contract](session-runtime-isolation.md#ownership-and-contracts)
grants only an explicit versioned module closure or scoped namespace. Nested
loads inherit the restriction; normalization, denial and pinned replay content
are required. Adapter qualification covers bundled success, local traversal and
symlink escape, and remote cross-namespace rejection. This contract must be
settled before replacing the loader.

## P2 Revoke late resolver mutation authority

The initial draft deferred mutation ownership while promising stale-work
rejection. Current
[turn resolvers](../../packages/harness/src/server/daemon/session/turn-resolvers.ts)
receive mutable jobs, and Kley's completion/callback resolvers mutate live
objects. Checking authority only at dispatch or storage commit does not stop an
old resolver from changing a document used by a replacement runtime.

Applied revision: host effects return data; the current runtime validates
operation identity, execution incarnation and lifecycle state before applying
outcomes. Mutable job strategies stay inside the runtime. Cancel, rewind, park
and ownership loss revoke affected mutation authority; dispatched work may drain
under an explicit obligation without reviving a turn. QA covers replacement on
the same live document as well as a fresh restored document.

## Follow-up scope

Astra agreed that ScopePlane hardening can remain independent until a consumer
relies on its ownership/context guarantees. Kley does not need to adopt its
storage API. The package-generation, registration and upgrade-window work remains
necessary; an import-only migration is insufficient.

The settlement and lifecycle findings are blockers before qualifying Kley child
execution on the new runtime. Source confinement blocks replacement of the
loader. These requirements do not prevent an early extraction/integration proof
that remains explicitly short of full lifecycle qualification.

## Implementation review

Astra independently reviewed the implemented candidate and approved it after
the following fixes:

- Effect-result commits recheck operation cancellation inside the serialized
  queue, before applying either a new result or a retried mutation.
- Local and Kley adapters fence asynchronous results, finalizers, hooks, policy
  checks and Scheme execution against the current document binding. Separate
  execution and ownership signals preserve retained work during a normal park.
- Scheme can bind a replacement host after the previous host loses ownership.
- Kley reconciles failed admission, intent and result persistence in the same
  process. A covering receipt permits durable interruption of abandoned work;
  later requests no longer require a process restart.
- Local callback settlement holds parent admission through the receipt, retains
  the worker during normal park, and completes its own receipt before releasing
  the last obligation. A retry after a lost acknowledgement reconciles the
  first result without replacing it. Recovered local documents are flushed
  before activation, and `turn/retry` retries a pending checkpoint.

Independent checks included shared lifecycle, Scheme rebinding, tool streams,
local replacement and parked work, policy checks and the actual Kley durability
suite against packed candidates. The approval covers the documented single
executor and trusted internal strategies. Final packaging and full-suite checks
remain required; Electric stream qualification needs a real server. This review
does not qualify distributed session execution.

## Grok implementation follow-up

The 2026-11-02 review raised three correctness findings and a packaging
suggestion. Two correctness failures reproduced and were fixed:

- Cancellation during a compaction checkpoint now holds admission and records
  `cancelRequested` before aborting the interpreter. It preserves the pending
  checkpoint and persists the newer cancellation state before releasing the
  hold. The daemon regression uses the actual compaction actor and separately
  delays both checkpoints; the queued prompt cannot start between them. The
  lifecycle regression also covers a lost acknowledgement and a failed retry.
- Completion ownership loss now reaches the provider as `"park"`, preserving
  the open attempt for recovery. The forwarding controller checks ownership
  even when closing the runtime's scope synchronously aborts the caller signal
  first. Actual provider-actor regressions cover replacement, disposal, a
  scope-derived caller signal, a late parsed body, and ordinary caller cancel.
  Ownership loss leaves the document unchanged and recovery observes an unknown
  attempt; an explicit caller cancellation still records cancellation.

The Electric legacy-ID finding does not apply to persisted PostgreSQL state.
The old composite keys contained U+0000, which PostgreSQL `text` rejects. A real
database test constructs those bytes on the server and confirms rejection in
all five composite-key tables. Another verifies updates, deletions and a
concurrent duplicate roster insertion. All five real PostgreSQL tests pass.
TinyBase can persist the old IDs and retains its migration. See the
[SQL adapter qualification](../../packages/scope-plane-electric/README.md).

The TypeScript dependency remains necessary for the current package graph.
`harness-model/session` reaches `program-kind`, which imports `BASE_ROSTER` from
`arrival/lsp-internals`; that barrel imports `type-layer/diagnose`, which imports
TypeScript. Scheme execution also uses that barrel's tokenizer. Arrival exposes
no supported narrower entry for these utilities and declares TypeScript only
as a development dependency. Removing only the runtime dependency from the
isolated packed consumer causes `ERR_MODULE_NOT_FOUND` in `diagnose.js` during
runtime import. The unchanged packed consumer passes. A smaller upstream import
surface is required before the compiler can leave the published runtime graph.

Follow-up verification passed the focused runtime/daemon/provider regressions,
runtime and daemon type checks, targeted lint, all five real PostgreSQL checks,
and the isolated packed consumer. Kley was refreshed from the 25 local package
directories: 46 focused integration tests and execution/client type checks
passed. Its first server type check reported errors in concurrent API changes;
an isolated retry passed without further runtime changes.
