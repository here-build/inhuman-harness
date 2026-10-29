# `@inhuman.tools/plugin-offload-tingle`

Cited project memory. The reducer in `behavior/project.scm` is the owner. A bot does not need the SQLite child to commit or search.

| Bot | Tool | Grant |
|-----|------|--------|
| `behavior/writer.prompt` | `offload` | project `get-memory`, `put-memory`, `search`; global `get-memory`, `put-memory` |
| `behavior/scout.prompt` | `tingle` | project `get-memory`, `search` |

`put-memory` refuses an empty citation. The same call id with the same input commits once. A different input on that id is an error. A stale core revision is a conflict. `search` returns nothing once the body is longer than 800 characters, and nothing when the query is absent. `offload` does not notify and does not wake a bot.

`plugin.json` `mcp` names an optional private workspace server (`memory`, `node ./dist/memory-mcp.js`). That child is the adapter in `src/`. The manifest does not load `src/plugin.ts`. A host that imports that module still claims `foreground-memory-provider`.
