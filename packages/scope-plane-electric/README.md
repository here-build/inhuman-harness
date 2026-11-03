# ScopePlane SQL adapter

This optional host adapter writes through `ElectricSql` and uses Electric shapes
for invalidation. A query promise must resolve after its transaction commits.
Ordinary `read` reports `consistency: "observed"` unless the host supplies
`ElectricSql.snapshot`, which must keep all callback queries in one repeatable
read or stronger transaction. `readSnapshot` rejects when that port is absent.

Execution hosts use `GenerationClaim` with `writeOverviewOwned`,
`writeAgentCallOwned` and `removeAgentCallOwned`. Each mutation checks and locks
the ownership row in the SQL statement that writes the target. The existing
unfenced methods remain available for authorized control-state writers. A prior
ownership read does not make an unfenced write safe. `takeoverGeneration` checks
the previous holder as well as its generation. Released generations are retained
so a later claim cannot reuse an old token.

`ScopeView.revision` identifies captured dependency content, including ancestors;
it is neither an ordered cursor nor an ownership token. Watch registration must
deliver an initial catch-up invalidation and another after reconnect. The URL
adapter forwards the Electric client's shape notifications; real Electric
disconnect/reconnect behavior still needs qualification against an owned server.

Composite IDs use JSON tuples. The previous NUL-separated IDs could not be
written to this adapter's PostgreSQL `text` primary keys: PostgreSQL
[rejects the code-zero character](https://www.postgresql.org/docs/14/datatype-character.html).
There are consequently no persisted NUL IDs to migrate here. TinyBase files can
contain those IDs and are upgraded by that adapter's loader. The SQL schema also
enforces uniqueness of each scope/key, scope/name and scope/connection pair.

`pnpm --filter @inhuman.tools/scope-plane-electric test` runs the statement double
and portable contracts. `pnpm --filter @inhuman.tools/scope-plane-electric test:postgres`
requires `initdb`, `pg_ctl` and `psql` on PATH. It creates and deletes its own
temporary cluster, listens only on a Unix socket, and never uses a supplied
database URL. It tests PostgreSQL's rejection of legacy NUL IDs, composite-row
updates and removals, actual roster/insert/claim races, stale ownership after a
blocked write, and target ownership. It passed against PostgreSQL 14.17 locally.
This does not qualify a production database configuration or Electric deployment.
