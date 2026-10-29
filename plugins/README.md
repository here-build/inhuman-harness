# Exemplar packs

These packs are behavior programs. A bot's `.prompt` selects `behavior.program`. Scoped state is a Scheme reducer and its methods. Installation does not register one program for every agent.

Host builtins that still construct `InhumanPlugin` live on the daemon (`packages/harness-server/src/system-plugins`). The notebook catalog (`task__*`) is one of those builtins: it imports `@inhuman.tools/plugin-tasks` into `SYSTEM_ENTRIES`. That module is the trajectory projection, not the pack's `plugin.json` load path.

| Dir | Package | Behavior |
|-----|---------|----------|
| `inhuman-plugin-tasks` | `@inhuman.tools/plugin-tasks` | Session pages (`create` / `start` / `drop` / `after`, host-sealed exam) and a separate project owner for acceptance |
| `inhuman-plugin-offload-tingle` | `@inhuman.tools/plugin-offload-tingle` | Writer commits cited project memory; scout searches. Global promotion is a second receiver. SQLite MCP is optional |
| `inhuman-plugin-goal` | `@inhuman.tools/plugin-goal` | Session goal. `/goal <objective>` sets it through `plugin/method`. The foreground `hook/round` continues or blocks |
| `inhuman-plugin-fusion` | `@inhuman.tools/plugin-fusion` | Session planner. One round-end note fuses the plan with a granted memory read |
