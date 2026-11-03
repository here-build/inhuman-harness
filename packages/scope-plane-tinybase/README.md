# ScopePlane TinyBase adapter

This adapter owns a single-process TinyBase store. Reads capture all tables
synchronously before evaluating the scope tree, so `read` and `readSnapshot`
report `consistency: "snapshot"`. Owned overview and agent-call mutations check
the complete claim and target ownership in one TinyBase transaction.

Writes update memory. An optional file persister also saves automatically; use
the opened handle's `flush()` when an explicit persistence outcome is needed.
It returns `memory`, `file-saved`, or `failed`. `file-saved` means the persister
completed its file write and atomic rename; it does not promise fsync or survival
of power loss. `close()` flushes and rejects a failed save. No multi-process
ownership or external side-effect fencing is provided.

File loading upgrades the earlier NUL-separated composite row IDs to JSON tuple
IDs. Retained generation rows prevent reuse after future releases; generations
already deleted by an older version cannot be reconstructed from that file.
