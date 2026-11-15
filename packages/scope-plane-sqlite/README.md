# `@inhuman.tools/scope-plane-sqlite`

Local SQLite storage adapter implementing `@inhuman.tools/scope-plane` `HarnessKvStore` (`SqliteKvStore`) and `SqliteSecretsBackend`.

Automatically uses optional native `better-sqlite3` when available in the host/CLI dependency graph, falling back cleanly to Node's built-in `node:sqlite` `DatabaseSync` (zero native dependencies required).
