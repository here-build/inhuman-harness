# Portable session runtime rework

Status: implemented candidate; release qualification is recorded below. Date: 2026-11-02.

Architecture and QA review: [Astra review and Grok follow-up](session-runtime-isolation-review.md).

The local Inhuman daemon and Kley should run the same released session runtime
while supplying their own identity, authorization, storage, providers, tools and
scheduling. Kley is a required second consumer: completion includes replacing its
copied sequencing and compaction code with supported package exports.

The rework establishes both an embedding API for the shared engine and a contract
between a session and its core/project host. Exporting the iterator is an early
milestone; the full boundary also includes session lifecycle and ownership.

## Implementation

The public embedding surface lives in
[`@inhuman.tools/turn/runtime`](../../packages-runtime/turn/README.md). It includes
`SessionRuntime`, the shared interpreter, explicit durability receipts, guarded
data-returning effects, recovery policy and session summaries. Session-only
registration preserves the persisted constructors without loading a kernel.
`@inhuman.tools/turn/resources` supplies the bundled strategy and confined,
captured module content. Local filesystem discovery remains in the host.

The local daemon delegates lifecycle and commands to this runtime. Project and
kernel preference writes go through owner operations. Kley's Agentic composition
uses the same lifecycle and resource exports; its old table assistant remains a
separate profile. Kley's development overrides use `file:` references to the
sibling package directories. Its preparation command builds and installs those
directories by default; `--packed` or `--artifacts` selects packed qualification.

Runtime ownership revokes an earlier incarnation bound to the same live
document. This is an in-process guard, not a distributed lease. The first hosts
retain one executor per session. Internal mutable strategies are trusted and
must honor their abort signal after asynchronous work; remote effects use the
data-only boundary. A committed result with a lost acknowledgement remains
held until a covering receipt, including newer document changes, is received.

ScopePlane now has monotonic generation tombstones, atomic fenced writes,
explicit snapshot consistency, content revisions and subscribe-before-read
watches. TinyBase distinguishes memory persistence from a saved file. Real
PostgreSQL checks cover SQL races and stale writers. Electric stream reconnect
is covered by controlled notifications; qualification against an Electric
server remains required before relying on that service in deployment.

Use `pnpm test:session-runtime` for the clean packed consumer check. It restores
a genuine model-0.1 Kley document in a fresh process, accepts another turn,
reconciles a committed effect and runs the bundled strategy while rejecting
kernel registration and local filesystem loader imports. The candidate is not
a published release or a cloud infrastructure rollout.

The qualified upgrade direction is from Kley's model-0.1 persisted conversation
to the candidate model/runtime generation. Constructor tags and document GUIDs
remain stable. Runtime command/effect sidecars carry version 1; an unknown
runtime version is refused before revoking an existing binding. Running an old
writer against newly written state is not qualified. Upgrade server and browser
dependencies together, stop old executors, and retain a pre-upgrade storage
snapshot. Rollback restores that snapshot with the matching old package set;
it must not reopen new state with an older writer.

## Candidate verification

| Check | Result |
| --- | --- |
| Workspace build, typecheck and lint | Passed: 66 build, 115 typecheck and 69 lint tasks |
| Shared turn package | 494 tests passed |
| Local daemon and providers | 1,154 tests passed across the full run and isolated retry |
| Web logic and stories | 949 tests passed |
| Clean packed consumer | Passed: strict public types, cold model-0.1 restore, another turn, effect reconciliation, bundled compaction and import guards |
| Crash, restart and process ownership | 12 tests passed |
| Applied Kley runtime | 61 tests and server typecheck passed; client typecheck and production build passed |
| Fresh PostgreSQL | Kley 79 tests and ScopePlane 5 tests passed in disposable clusters |
| Candidate consistency | All 48 migrated Kley source paths and 25 package archives matched the reviewed copy; archive integrity checks passed |

The final `pnpm verify:logic --concurrency=2` run passed its build, type and lint
stages and every test assertion it executed. One daemon test worker failed to
start for `settings-files.test.ts`; that file's seven tests passed in an isolated
retry. The aggregate command therefore exited nonzero for the worker failure.
An earlier web-story failure under higher parallelism also passed both alone and
in the final bounded run. Neither failure was hidden or converted into a passing
aggregate result.

The Grok follow-up added regressions for cancellation during a compaction
checkpoint and completion ownership loss. Focused runtime, daemon, provider,
type and lint checks pass; the clean packed consumer also passes after these
fixes. The SQL adapter now additionally qualifies legacy NUL-key rejection and
composite updates/deletions against real PostgreSQL. The
[review dispositions](session-runtime-isolation-review.md#grok-implementation-follow-up)
record the reproduced failures and the dependency import proof.

Kley's 25 directory overrides were refreshed after the fixes. Its six focused
Agentic integration files pass all 46 tests, and the installed runtime matches
the rebuilt package. Execution-service and client type checks pass. The initial
server type check reported errors in concurrently changed API route/filter
types; its isolated retry passed without further runtime changes. The first
aggregate type-check command therefore remains a failed run, followed by a
passing server retry.

The changes are an unpublished candidate. Kley's checked-in dependency overrides
refer to the sibling Inhuman package directories. Packed qualification remains
available through its preparation script. Replace those overrides with released
packages and regenerate the lockfile for a registry-only release. Real Electric stream
reconnection remains unverified; this candidate does not qualify a distributed
executor rollout.

## Scope and completion

The initial execution target is local and cloud Node hosts, matching Kley today.
Tools can execute locally, be bridged to another environment, or be unavailable.
The runtime preserves the same turn and receipt semantics in each case.

Completion requires all of the following:

- Both consumers use one released session implementation and its compatible model
  and resource set, with no copied iterator or compaction implementation.
- The shared session can hydrate, recover, admit commands, activate, park and
  dispose without importing kernel/project implementations or physical workspace
  discovery.
- The session owns its document. Core/project services own their state and accept
  explicit operations rather than exposing mutable parent roots.
- Both consumers preserve their supported behavior, authorization and recovery
  policies, and pass qualification against the same packed candidate artifacts.
- Local and cloud storage mechanics remain host choices. Kley can keep its
  existing organization/user stores without adopting ScopePlane.

Worker compatibility, a distributed scheduler, one process per session, and a
cloud infrastructure rollout are separate follow-up work. Supporting multiple
potential executors requires a qualified ownership implementation before rollout.
The first migration can retain a host-enforced single executor per session.

## Ownership and contracts

| Shared session runtime | Local or cloud host |
| --- | --- |
| Session document, turns, jobs and command semantics | Authenticated identity, access to a session and execution ownership |
| Sequencing, round decisions and continuations | Authorized provider capabilities, streaming and credentials |
| Context projection and compaction mechanics | Effective context, strategy selection and source/module resolution |
| Tool admission and call/result semantics | Available effects, live authorization, execution and cancellation |
| Recovery mechanisms and persistence barriers | Durable storage and an explicit recovery policy |
| Call obligations and session facts | Child acquisition/delivery, scheduling and core/project projections |

There are two API surfaces:

1. The embedding API may use the shared session/job types inside one process.
   Its baseline is the current `TurnIteratorHost` and `TurnResolvers`. The runtime
   owns mutation of its document. Strategies that receive mutable jobs remain
   inside that runtime boundary; they do not grant the host unrestricted access
   to a document.
2. The session-to-host service boundary carries scoped requests, immutable data,
   outcomes, receipts and events. It does not expose `KernelDaemon`,
   `ProjectDaemon`, mutable parent roots, database clients, driver instances or
   credential bags. A remote adapter serializes these operations; in-process
   hosting does not require a network hop.

Host effects return data. The runtime validates the operation identity, execution
incarnation and current lifecycle state before applying an outcome or admitting
dependent work. Cancellation, rewind, parking or ownership loss revokes the
authority of affected operations to mutate the active document. Dispatched work
may drain under an explicitly retained obligation, but cannot revive a cancelled
turn or authorize a successor. Existing job-mutating resolvers require adapters
or internalization before the full lifecycle boundary is qualified.

| Contract area | Required behavior |
| --- | --- |
| Context | Supply versioned effective settings, authorization layers, instructions, skills and capability descriptions; deliver updates and support resynchronization |
| Resources | Resolve identified, versioned program/module content and blob bytes; source identity need not be a readable local path |
| Effects | Execute authorized model/tool requests, stream results and propagate cancellation; distinguish refusal, unavailability and uncertain dispatched outcomes |
| Durability | Restore state and acknowledge a defined committed checkpoint before dependent work proceeds |
| Coordination | Bind execution ownership, idempotent command/call delivery, child acquisition, callbacks, wakeups and lifecycle facts |
| Core/project operations | Remember preferences, persist grants and invoke permitted project/global state operations through their owner |

Resource resolution preserves the current module confinement. A source identity
grants only an explicit versioned module closure or scoped namespace; nested
loads inherit that restriction. Normalize requests before lookup, deny traversal
and cross-namespace access, and pin the resolved content used by an admitted
program. Local adapters retain their realpath/symlink escape checks. Remote and
bundled adapters enforce the corresponding namespace or allowlist without
falling back to arbitrary host files or another tenant's resources.

Scope identity is opaque. A local workspace path is a capability binding, not a
requirement for a project or session to exist. Kley's team, user and navigation
context remain distinct dimensions of authorization. Config inheritance does
not replace resource membership, ownership checks or authorization-layer rules.

Context updates have explicit application boundaries: turn-frozen inputs retain
their recorded values, while live authorization is checked before the next
effect. An eventual overview is never the source of execution authority.

## Existing seams and compatibility

The current iterator already describes sequencing in terms of session data and
explicit ports: [turn-iterator.ts](../../packages/harness/src/server/daemon/session/turn-iterator.ts)
and [turn-resolvers.ts](../../packages/harness/src/server/daemon/session/turn-resolvers.ts).
The [round lifecycle](../react-round-lifecycle.md) defines the current durable
decision and recovery semantics. This rework must preserve that contract.

Kley implements the same broad seam in
[its Agentic driver](../../../kley/server/kley/src/agentic/driver.ts), with
[copied runtime provenance](../../../kley/server/kley/src/agentic/inhuman/PROVENANCE.md).
Its session envelope uses team/session/owner IDs and creates a `SessionPlexus`
without a filesystem path. Its persistent conversation host and its separate
`server/execution` service are different consumer profiles; the bounded execution
API does not define the entire conversation lifecycle.

Kley's installed `0.1.0` model/runtime generation and copied continuation-verdict
API differ from this repository's `0.2.0` generation and structured
`IntentAssessment`/round decisions. Adoption is a dependency and behavior
migration, not an import-only substitution.

Preserve existing persisted class tags and document GUID rules during extraction.
Version any persisted additions separately. Align runtime, model, PEW, Plexus,
Yjs, MobX and Arrival dependencies so each server process or browser bundle has
the constructor and registration identities it requires. Separate session
registration must still materialize old persisted classes.

Kley source links assume a sibling `../kley` checkout.

## Delivery stages

### 1 Define contracts and capture compatibility fixtures

Write the ownership rules, port semantics, supported feature profiles and
failure outcomes before moving implementation. Use the current host interfaces
as evidence, without reproducing every method of the daemon or Kley driver.
Resolve durable receipt coverage, cross-document call acknowledgement and late
result mutation authority in this stage; they determine the lifecycle API.

Capture synthetic or existing fixtures for completed conversations, interrupted
model/tool/program/compact jobs, pending approvals and child callbacks. Record
Kley's installed package set and copied-source revision. Define the supported
reader/writer upgrade window and rollback conditions before introducing new
persisted state.

Gate: both consumers' expected behavior and intentional differences are stated,
and the fixtures can be restored by the relevant baseline implementations.

### 2 Publish the shared turn runtime and resources

Add an intentional `@inhuman.tools/turn/runtime` entry point in the existing
`packages-runtime/turn` package. Move the current iterator, round-boundary logic,
stop/continuation logic, resolver support and required helpers into its source
closure. Keep internal decision helpers private and export only the consumer API.

Remove accidental imports of daemon/plugin composition and broad barrels that
load filesystem or tool-host code. Supply structural notes, diagnostics and
resource ports. The notes contract includes the current activating/ambient
semantics; it must not be reduced to Kley's older text-only shape.

Compaction already has a shared implementation. Replace its hardwired filesystem
module loader and kernel-root assumptions with supplied program content and
module resolution. Give `compact.scm` and `compact.prompt` one canonical shared
home and offer a bundled strategy for embedders. Keep local file resolution in
the daemon adapter. Preserve existing configuration tokens and required package
asset paths through compatibility resolution or generated assets, rather than
two manually maintained copies.

Specify asynchronous blob materialization or an explicit host cache before
using remote storage; a synchronous bucket interface is not satisfied merely by
naming a remote implementation. The runtime import path must not silently load
the entire local tool implementation to externalize prompt content.

Gate: a clean packed installation runs a real turn and the shipped compaction
strategy using supplied model/tool ports and an in-memory resource bundle, with
no daemon composition, source aliases or filesystem loader dependency.

Before stabilizing that API, run a small integration proof through Kley's actual
Agentic driver with the candidate runner and bundled strategy. Retain its own
host services. This proof validates the proposed ports early; it does not yet
qualify shared lifecycle adoption or removal of its copied implementations.

### 3 Complete session lifecycle isolation

Build the portable lifecycle around the shared runner: hydrate, recover, admit
commands, activate, park, cancel, dispose and publish summaries. Reuse existing
commands and recovery mechanisms. Remove session/kernel model cross-imports
through neutral vocabulary and session-owned projection extraction. Add a
complete session-only registration entry while retaining aggregate compatibility.

Replace session access to parent state and cross-root writes with explicit
operations for context, remembered choices, grants, permitted effects, children
and callback delivery. Core/project services consume session facts and handles.
They do not inspect arbitrary session fields to derive display projections.

Gate: a restored session executes its public lifecycle against a controlled
control host without importing kernel/project implementations. Its persisted
state and effect observations satisfy the laws below.

### 4 Move the local daemon onto the shared APIs

Make `SessionDaemon` and `SessionOrchestrator` adapters around the shared runtime.
Keep provider interning, credentials, project discovery, configuration watchers,
Git/statusline work, plugin installation and local tool bodies in the local
host. Route public RPC explicitly while preserving request cancellation and
parked UI ownership.

Replace kernel session inspection with summary publication and authoritative
lifecycle facts. Replace session writes into project/kernel objects with owner
operations. Delete moved implementations after callers use their replacements.

Gate: local sequencing, approval, continuation, compaction, rewind, recovery,
effect draining and process-lifecycle checks pass through the shared runtime.
Existing local configuration and document identities remain usable.

### 5 Migrate Kley as the second consumer

Upgrade Kley's server and browser dependency set to one validated candidate.
Adapt host signatures to current structured assessments and verify old document
fixtures through fresh registration. Preserve these host choices:

| Kley behavior | Migration requirement |
| --- | --- |
| Identity and access | Preserve team/user ownership, membership, entitlement and resource checks |
| Capabilities | Preserve per-turn catalogs, authorization, connection cleanup and credential containment |
| Continuation | Represent the unconfigured judge explicitly; retain shared length/thought/callback continuation |
| Optional features | Preserve empty plugin notes and disabled ambient summarization through supported configuration |
| Compaction | Preserve host threshold, retained floor, retry-after-growth and open-request requirements |
| Children | Preserve deterministic identity, one-shot recipes, inherited ceilings, shared budgets and parent cancellation |
| Recovery | Preserve interruption handling rather than silently adopting daemon resume behavior |
| Memory | Preserve owner-bound sources, citations, revisions, receipts and idempotency as a domain capability |

Fix the persistence acknowledgement used at durable barriers: Kley's current
`Persister.flushNow()` catches storage failure and retries, so awaiting it does
not establish durable success. Preserve background retry where appropriate, and
provide an explicit durable outcome where effect/callback ordering requires it.

Replace the surrounding cross-document settlement protocol too. Use a stable
delivery/settlement identity and recoverable acknowledgement across caller,
worker and host lineage records. A covering durable parent receipt is required
before callback cleanup, including exception, cancellation, interruption and
`finally` paths. Provisional in-memory completion cannot make a parent eligible
to continue before that receipt. An interruption policy may terminate execution
while retaining or reconciling an outstanding delivery obligation. Retrying after
a lost storage acknowledgement must discover a committed result rather than
repeating the effect or erasing its obligation.

Replace the copied iterator/compaction closure and assets with installed exports.
Keep Kley's storage, authorization, memory, transport, UI and provider
implementations. Its older table-assistant behavior is a separate profile;
sharing additional product logic is not required for this migration.

Kley's Agentic conversation host must enter through the shared
hydrate/recover/admit/activate/cancel/park/dispose lifecycle. Host policy selects
stop-on-interruption; shared mechanisms apply it and reconcile outstanding call
obligations. Kley's session envelope can retain storage and access adapters, but
must not retain a second implementation of execution recovery or settlement.

Gate: old conversations restore and accept a subsequent turn; approval,
revocation, child callbacks, cancellation, compaction and reconnect work; the
replaced vendored runtime code is gone. The integration test proves that the
actual Kley composition calls the shared lifecycle, including interruption and
failed parent/child persistence, rather than only importing the shared iterator.

### 6 Harden ScopePlane behind the host boundary

Keep ScopePlane as a control-state implementation choice. Fix ownership-token
reuse, authoritative stale-writer checks, effective-context revision semantics,
subscription establishment and durability acknowledgement before relying on
those guarantees. Validate SQL constraints/concurrency and subscription recovery
against real owned infrastructure, beyond the current SQL double.

Gate: each implementation satisfies the guarantees it advertises. Local TinyBase
adoption and Kley's existing stores can coexist. A cloud deployment with multiple
potential executors remains blocked on qualified ownership and effect handling,
not on a passing in-memory compare-and-set test.

After stage 1, runtime extraction, resources, model registration and ScopePlane
hardening can proceed in parallel with disjoint ownership. ScopePlane hardening
does not block the first shared-runner proof. Local and Kley migrations follow
the stabilized API. Both consumer gates are required for the runtime release.

## Behavioral laws

- Loading/hydration does not start effects. Recovery finishes before activation.
- A command ID identifies its input. Repeated identical delivery returns the
  existing receipt; reuse with different input is refused.
- Persist an effect intent before dispatch and its result before dependent work.
  Distinguish accepted, committed/durably acknowledged, and uncertain outcomes.
- A failed durable barrier cannot release dependent work. A storage retry is not
  a successful acknowledgement.
- Storage commit and delivery of its acknowledgement are independent events.
  Recovery reads committed storage, including writes whose acknowledgement was
  lost. A retry reconciles committed command/result identities before dispatch.
- Ownership identity cannot be reused across incarnations. Validate ownership at
  authoritative commit/effect admission, rather than relying on a prior check.
- Ownership loss stops new work and cancels what can be cancelled. Already
  dispatched external work may have an unknown outcome; do not blindly replay it.
- Caller/worker delivery and callback identities are stable. Persist the caller
  result before releasing the worker callback obligation. Retain a recoverable
  delivery/settlement identity across document commits and cleanup failures.
  Provisional completion is not durable eligibility. Duplicate delivery or
  callback cannot create another child or successor round.
- Context revisions cover the inputs they describe, including relevant ancestor
  changes. Snapshot/subscription establishment and reconnection cannot leave a
  subscriber permanently stale. Display projections can lag; authority cannot
  be inferred from them.
- A session publishes facts about its own state. Only the owning host writes
  project/global state, credentials and grants through its authorized operations.
- A deadline that must survive suspension becomes a persisted wakeup intent;
  the host chooses a local timer or durable scheduling mechanism.

These laws do not promise universal exactly-once external effects. Endpoint
idempotency or outcome-query capabilities must be declared and tested separately.

## Testing strategy

The primary behavioral target becomes the public runtime running a real
`SessionPlexus` and Yjs document. Injection controls external events while the
tests exercise real commands, admission, jobs, catalogs, interpreter, compaction
and recovery. Existing contracts must not be weakened to make tests easier.

### Test ownership

| Test family | Real components | Failure owned by the test |
| --- | --- | --- |
| Runtime workflows | Runtime, document, commands, catalog, interpreter and shipped strategy | Lost work, invalid sequencing, repeated dispatch, incorrect continuation/compaction/recovery |
| Pure decision rules | Production decision or validation functions | Combinatorial arbitration, permission and path errors |
| Host conformance | Actual host adapter and relevant filesystem/database | Broken durability, ownership, context delivery or capability semantics |
| Consumer integration | Local/Kley composition using packed runtime artifacts | Incorrect configuration, provider mapping or lifecycle wiring |
| Compatibility and recovery | Persisted bytes, clean package installation and fresh processes | Old-document failure, incomplete registration, duplicate constructors or cold-start failure |
| Browser and process | Actual app/transport/launcher | Command, replica, approval, stop/reconnect or process-boundary failures |

Run the full shared behavior suite once upstream. Run focused contract scenarios
against each implementation of a particular host port, plus compact integration
workflows in both consumers. Avoid a full host/storage/provider/transport cross
product. Keep Kley's actual database and authority checks, and the local host's
actual persistence, connection and process tests.

### Runtime workflows and observations

Seat cases around unique production failures: prompt/tool/result/successor flow;
input arriving during judgment or shutdown; approval/denial and dispatch;
parent/child settlement and cancellation; compaction preserving the open request
and tool pairing; restore without re-consuming committed decisions or replaying
settled/uncertain effects. Native and Scheme calls exercise the same production
admission and execution path where applicable.

Script model/remote-tool responses at production ports. Control async ordering
with deferred responses and storage acknowledgements, rather than sleeps or
private-method hooks. Do not mock session replicas or invent production exports
solely to inspect tests. The current lightweight iterator fixture's handwritten
admission and unconditional successful work resolution cannot be the main
integration fixture.

Use one structured oracle per named phase:

| Phase | Observation |
| --- | --- |
| Waiting | Pending approval/work, current input and externally observed effects |
| Settled | Receipts, consumed input, decision and actual successor model request |
| Restored | Retained identities, remaining obligations and newly dispatched work |
| Finished | Terminal reason, outstanding callbacks and projected conversation |

Normalize incidental IDs consistently while preserving references and ordering.
Use independently authored expected outcomes, persisted state read by a fresh
consumer and an owned endpoint's effect ledger. Do not derive the expected
decision from the same production reducer under test. Internal callback counts
and constructor-name dumps are secondary to observable behavior.

### Failure ordering and adapter proof

| Controlled event | Required observation |
| --- | --- |
| Intent persistence fails or remains pending | No dependent effect starts |
| Intent/result/command/callback storage commits but acknowledgement is lost | Restore the committed record; retry reconciles it without duplicate dispatch or settlement |
| Effect commits but its reply is lost before durable result | Recovery records uncertainty and does not blindly replay |
| Ownership changes during old work | Stale completion cannot advance authoritative state |
| A late resolver returns after a replacement runtime binds the same live document | The old result cannot mutate active state or admit dependent work |
| Context changes during subscription setup/reconnect | The subscriber receives the current supported revision |
| Callback arrives twice or after cancellation | One legal settlement and successor; no revived cancelled work |
| Parent result persistence fails while child cleanup could succeed | Keep or reconcile the callback obligation; parent cannot advance from provisional completion |
| Cancellation occurs before dispatch | No external effect |

For deterministic recovery tests, control storage commit separately from delivery
of its acknowledgement. Restore actual committed bytes, including
committed-but-unacknowledged writes; distinguish those from writes that failed
before commit. Discard the runtime, hydrate a fresh document and invoke normal
recovery and public retries. Exercise each parent/child commit and cleanup
boundary, including exception and interruption paths. Separately bind a
replacement runtime to the same live document and release old responses, so
fresh-object isolation cannot hide stale mutation authority. Add bounded seeded
command/event sequences around independent invariants, reporting reproducible
seeds and minimized failing sequences. Preserve a small real process crash test
for guarantees that in-process reconstruction cannot establish.

A scripted persistence port proves that the runtime waits. Real adapter tests
prove that acknowledgement means the promised storage commit. Local persistence
uses actual disposable filesystem state. Kley tests use an isolated real
PostgreSQL database for owner/team isolation, transactions, revisions, child
lineage and memory receipts. Owned protocol endpoints exercise provider/bridge
streaming, cancellation, duplicate requests and lost replies. An in-memory SQL
double does not establish real database or subscription parity.

Resource adapter qualification covers the positive bundled strategy load and
denial of local traversal/symlink escape and remote cross-namespace loads. Replay
uses the admitted versioned module content rather than silently resolving a
newer resource with the same name.

### Consumer and release qualification

Install the unpublished candidate dependency closure outside the workspace, with
no source aliases or accidental workspace links. Run the actual local and Kley
composition against the same candidate artifact set. Check session-only
registration in a fresh process so aggregate imports cannot mask a missing
class. Load baseline Kley `0.1.0` fixtures and supported local fixtures, render
them through the current reader, and accept a subsequent turn where supported.

Kley retains tests for entitlement revocation, delegated capability lifetime,
owner-bound effects/memory, shared child budgets and interrupted-turn policy.
Resetting an in-memory session registry proves a narrower guarantee than a cold
process; reloading a browser proves client reconnection. Neither substitutes for
fresh-process restore or crash-window qualification.

Keep browser checks for real command/sync behavior, approval, streaming stop,
reconnect and product navigation. Split unrelated document, child-consent and
memory-editor workflows rather than growing a single browser journey. Keep
appearance approvals in the visual lane; screenshots saved only for diagnosis
are not an approval oracle. Runtime correctness uses scripted model behavior;
prompt/strategy quality has a separate evaluation corpus when those resources
change.

| Change or gate | Required checks |
| --- | --- |
| Default logic | Runtime workflows, pure rules, bounded interleavings, types and ordinary adapter checks |
| Runtime release candidate | Clean packed installation, cold compatibility, local integration and Kley integration |
| Persistence/ownership/context changes | Relevant real adapter concurrency, durability and resubscription checks |
| Bridge/provider changes | Owned protocol endpoint and applicable duplicate/lost-reply/cancellation checks |
| Process lifecycle changes | Launcher/crash/restart lane |
| UI changes | Browser interaction and applicable visual approvals |
| Scheduled deeper checks | Larger seeded event sequences and relevant real-model quality evaluations |

A required qualification job that cannot run remains unverified; it must not
silently count as a successful consumer release gate. Repository-wide checks
still follow [test lanes](../testing.md) and [contribution guidance](../../CONTRIBUTING.md).

Review existing tests by the unique production failure they own. Move shared
laws with their implementation, retain host-specific guarantees, and fuse phases
of the same workflow with clear phase observations. Keep old checks until the
replacement exercises their failure through the new boundary, then remove the
duplication in that change. There is no target test count or coverage quota.

## Contract choices in this candidate

1. The Node embedding surface is `SessionRuntime` with trusted in-process model
   strategies. External effects use data-only requests and guarded application.
   Each trusted adapter must fence its own asynchronous model mutations.
2. A checkpoint carries Yjs bytes, session identity, incarnation and revision.
   A receipt must cover it before dependent work proceeds. Both initial hosts
   enforce one executor; ScopePlane's storage fences are a separate capability.
3. Hosts retain live authorization and turn-specific context rules. ScopePlane
   labels snapshot versus observed reads explicitly, derives revisions from the
   captured dependencies and rereads after subscription establishment.
4. Resources use versioned content and confined module loaders. Compaction
   checkpoints captured bytes before evaluation. Local file resolution retains
   its jail; remote blobs must be materialized through the host's async service
   or supplied cache before use by a synchronous strategy.
5. The upgrade window is forward reading of the qualified model-0.1 state with
   the matched candidate package graph. Older writers require the pre-upgrade
   snapshot for rollback; mixed writer generations are not qualified.
