# `@inhuman.tools/plugin-tasks`

Session notebook on the behavior surface, plus a project owner for promotion.

| Module | Owner | Methods |
|--------|--------|---------|
| `behavior/session.scm` | session | `incomplete`, `create`, `page`, `start`, `drop`, `after`, `stamp`, `validate` |
| `behavior/project.scm` | project | `accept`, `accepted`, `complete` |
| `behavior/tools.scm` | model ABI | `task__create`, `task__start`, `task__drop`, `task__after`, `task__validate` |
| `behavior/foreground.scm` | foreground bot | round-end recitation |

`create` keeps the exam text only when it inspects the tree and names `tasks/write-completion-verdict`. `validate` proposes `limbo` and `stamp` proposes `verdict`. Both actions are host-sealed, so a plugin call cannot freeze the exam. Acceptance on the project owner is not completion. Rolling the session back does not retract that acceptance.

Recitation is the foreground hook's `self/notify`. An open page is `activating`, a pending-only notebook is `ambient`, and an empty notebook is silent.

The kernel installs this package as a default plugin, not as a builtin. `behavior/tools.scm` is loaded when the plugin is enabled. There is no JS tool or trajectory projection.
