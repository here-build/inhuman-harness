# PEW — Plexus Expectation Workflow

**Package:** `@inhuman.tools/plexus-expectations`

Durable work on Plexus documents. One noun for open work — **Expectation** (harness docs: **PEW/Expectation**) — demand with an
outcome. The entity itself is the whole API: the claim-owner host writes PEW/Expectation bodies (Client queues the named action);
observers read it; Actors honor it; the process holding the live PEW/Connection starts or declines it.

This README is the contract.

---

## Three entry points, three roles

| Import                               | Role                                                                            | Contents                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@inhuman.tools/plexus-expectations` | **Vocabulary** — any process holding the doc (claim-owner host, observers, UIs) | `WorkExpectation`, `Job`, `WorkContainer`, `ConnectionSpec`, `DriverSpec`, outcome type |
| `…/driver`                           | **Fulfillment** — PEW/Driver packages                                           | `PEWDriver`, `ExpectationActor`, bootstrap contexts                                                              |
| `…/executor`                         | **Supervision** — the process that has the live connections                     | `Orchestrator` (PEW honor + Job executors; plus everything in `/driver`)                                                   |

Observers and claim-owner hosts never import `/executor`; driver packages never need it either.

---

## The entity is the API

Live `report` is the scan; settlement is the `outcome` / `outcomeReport` write on the entity; the next read is instant.

Everything scoped to a unit of work lives on the `Expectation` model — there is no client
object, no session parameter, and a cross-session mistake is unrepresentable (the entity locates
its own document, plexus, and PEW/Awareness):

| Face                                      | Surface                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Author** (claim-owner host, not Client) | `new Kind({ …fields })` — the subclass fields ARE the request                                                                                                                                                                               |
| **Observer**                              | `await E` (settles with `"successful"` / `"failed"` when `isDone`; `failed` fulfills), `E.outcome` (`null` / `successful` / `failed`), `E.workerPresent`, `E.report` (outcome frame or live awareness), `E.endCause` / `E.endDetail`; catalog liveness is process-local on the spec entities' `.readyState` / `.live` |
| **Actor**                                 | `this.expectation` (the request), `this.signal`, `admitTermination()`, `report()` / `complete()` / `fail()`; `ConnectionNotReady` / `DemandIncomplete` from `run()` settle fail, not crash                                                                                                                                                                        |
| **Connection**                            | leftover attach PEW is honored; new work is kicked from origin (`complete` / Job BODY interned methods); catalog drivers load themselves; `PEWDriver.handle` remains the leftover door                                                                                                                                                                                                           |

Role occupancy is one `role:expectations` map keyed by uuid. A role write requires a
doc-homed entity — occupancy not propagated over awareness is no occupancy, so
touching the role map on an unhomed entity throws loudly rather than publishing
into the void.

### Outcome

```text
null        = not done
successful  = done as expected
failed      = done otherwise (error, crash, cancel)
```

There is no expectation state machine and no durable `running`. "Someone is working
to satisfy this" is actor presence (`workerPresent` / the role map), gone when the
teller goes. Last progress this process saw stays on `progressAwareness` after the
uuid retracts. The writers `succeed` / `fail` are first-writer-wins (`fail` with
`endCause: cancel` is how cancel is recorded). `connection` on the expectation and
`driver` on the connection are required — a missing field is a host bug, not an
outcome. Every ending carries `endCause` (`settled` | `cancel` | `crash`) and
`outcomeReport`.

Cancel is host-owned: `admitTermination()` on a live actor, or `fail("cancel", …)` when
nobody is working. No acks, no epochs, no kernel hop.

### Endings are observed, never imposed

There is no fold. Endings are `succeed` / `fail` writes — the actor on its own settlement,
or host `admitTermination` (a settlement captured before admission outranks the cancel).
The actor keeps one reaction on its entity's `isDone`: however the ending arrived — local
settlement, admitted cancel, a peer's write — the process duties are identical: abort the
signal, leave. Children of a done parent are skipped by honor (`isTreeOrphan`), not ended
by a cascade from the parent's stack frame.

---

## Extending: kinds and drivers

**Work vocabulary is global.** A product ships `Expectation` subclasses; the `@syncing` registry
tag IS the kind — derived, never declared. The subclass is the single type carrier:

```ts
@syncing("myapp:tool_call")
class ToolCallExpectation extends Expectation<ToolResult, ToolReport> {
  @syncing accessor name = "";
  @syncing accessor argsJson = "{}";

  override applySettlement(result: ToolResult): void {
    /* typed product-field writes */
  }
}
```

`ResultOf` / `ReportOf` extract the shapes.

**PEW/Driver is claim, not invent — and the claim lives on the catalog, never on code.**
`DriverSpec.can: string[]` is the durable claim surface ("this driver handles these
kinds") — expectation model names, elevated through the process-global `@syncing` class registry.
Dynamically loaded driver code does not get to declare its own authority.

**The loaded class is `PEWDriver`. The instance is the connection.** `DriverSpec` and `ConnectionSpec` stay the inventory rows. A driver module's default export is
a `PEWDriver` subclass: the static side is code identity (`pewBrand`, `offers`),
each instance is one live connection (its own gated `bootstrap()`), and `resolve(expectation)`
mints the actor — which may be a connection-specialized `ExpectationActor` subclass holding the
live runtime directly:

```ts
export default class MyDriverConnection extends PEWDriver<ToolCallExpectation> {
  static override configurationSchema = z.object({ token: z.string() });
  static offers = [];

  override async bootstrap() {
    /* per-connection load */
  }
  protected override resolve(expectation: ToolCallExpectation) {
    return new MyActor(expectation, this /* live runtime */);
  }
}
```

Process facts are `readyState` / `error` / `offers`. Driver extras live on `state`
(`@observable.shallow override accessor state = { … }`); the orchestrator mirrors
them onto `spec.live`. Clients render. A concrete class that should not share the
base extras object declares its own `static state`. Reporting only (no machinery
branches on it; instance bootstrap truth is the gate); `ensureBootstrapStarted` /
`failReady` write the token and siblings.

Settings enter through `configurationSchema` (Zod), secrets through
`secretsSchema`. The constructor takes them as separate arguments;
`parseConfiguration` / `parseSecrets` are the same doors without `new`.
The live `secrets` view may be replaced after construct (reauth).

Bootstrap contexts stay minimal (`{signal, secrets}`); a host hands drivers more by extending
the context object structurally — there is no ports registry.

**The seam.** `Orchestrator` is the boundary between the plexus plane and execution: it notices
open work, maps the expectation's connection to a catalog row ensures the row's driver class and connection instance
(memoized; a rejected memo IS the sticky failure), and hands the expectation to
`connection.handle` — where
everything about executing it lives. Mint is not a claim: `resolve()` throwing
breaks the connection (the work stays unspawned). The actor machine still
requires `START` before `run()`; that is process-local, not a durable claim.

## License

[MIT](./LICENSE.md).
