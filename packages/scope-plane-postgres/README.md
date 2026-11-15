# `@inhuman.tools/scope-plane-postgres`

PostgreSQL driver for [`@inhuman.tools/scope-plane`](../scope-plane) (`PostgresKvStore` implementing `HarnessKvStore` and `PostgresSecretsBackend` implementing `AsyncSecretsStoreBackend`).

- 1-RTT batch upserts via PostgreSQL `UNNEST(...)` with primary-key deduplication
- `monotonicRevision`, `ifAbsent`, `retainOnly`, and transactional `CommitDiff` emission
- Cascading `sessions` delete across all five child tables returning deleted rows
- Configurable PostgreSQL schema isolation (`{ schema }`) for harness tables and connection secrets
