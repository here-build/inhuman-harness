# `@inhuman.tools/env-capability-meta-reactivity`

Identity list diff for Arrival programs. The baseline is this capability's resource, one per `job`. The bag clock is `scheme_watch`: `begin` / `commit` / `abandon` on the capability. Not MCP jobs.

Who this is for: a host that re-invokes the same Scheme `expr` on a period and needs last-successful baselines plus a done flag.

## Surface

| Symbol | Contract |
|---|---|
| `meta-reactivity/added` / `removed` / `changed` | Identities vs the last committed list at a path-stable access. `added` is data; the body walks it. |
| `meta-reactivity/done-condition` | `(pred [result])`. Last-write this period. The form returns `result` if given, else `pred`. |
| `begin` / `abandon` / `commit` | On the capability, keyed by the same `job` the runtime puts on config. `commit` seals the period and returns `{ done, result }`. |

A list argument is a pair or a JS array (`AJSArray` / raw). Do not cdr-walk a vector.

The program can still return a Scheme value. `doneResult` is the bag outcome when the host completes from this flag. `self/notify` is not in this pack.
