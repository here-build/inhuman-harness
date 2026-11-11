# `@inhuman.tools/plugin-tasks`

Session notebook on the behavior surface, plus a project owner for promotion.

| Module | Owner | Methods |
|--------|--------|---------|
| `behavior/session.scm` | session | `incomplete`, `create`, `page`, `start`, `drop`, `after`, `stamp`, `validate` |
| `behavior/project.scm` | project | `accept`, `accepted`, `complete` |
| `behavior/tools.scm` | model ABI | `task__create`, `task__start`, `task__drop`, `task__after`, `task__validate` |
| `behavior/foreground.scm` | foreground bot | round-end recitation |

`task__create` captures Scheme source without running it. The caller chooses a unique task ID, then calls `task__start` and `task__validate`. The program checks current project state through file or shell ports and finishes with `(tasks/write-completion-verdict ok comments)`. A true verdict completes the task; a false verdict returns it to pending. The captured program cannot be replaced: drop the task and create a new ID to change its checks. `task__after` records a prerequisite for planning; it does not block starting a task.

For example, a task whose requirement is that `status.txt` contains exactly `ready` can save:

```scheme
(tasks/write-completion-verdict
  (equal? (read_file "status.txt") "ready")
  "status.txt must contain exactly ready")
```

The tool argument is a JSON string containing this Scheme source. Creation errors leave the task ID available for a corrected retry. A name error during validation refers to an already-saved program; its recovery message explains how to replace that task. The first error of each kind in a live session includes an example; repeats keep the reason and recovery action. Exam door rejection and subsequent successful create/validate calls are traced by the host.

Validation's `limbo` and `verdict` actions are host-sealed. Acceptance on the project owner is not completion. Rolling the session back does not retract that acceptance.

Recitation is the foreground hook's `self/notify`. An open page is `activating`, a pending-only notebook is `ambient`, and an empty notebook is silent.

The kernel installs this package as a default plugin, not as a builtin. `behavior/tools.scm` is loaded when the plugin is enabled. There is no JS tool or trajectory projection.
