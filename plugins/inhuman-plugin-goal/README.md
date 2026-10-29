# `@inhuman.tools/plugin-goal`

One session goal. It dies with the session. There is no project file and no child profile.

| Piece | Role |
|-------|------|
| `behavior/session.scm` | `get`, `set`, `tick`, `block`, `clear` |
| `behavior/foreground.scm` | `hook/round` `:post` ticks and notifies `activating` while the goal is active. `:post-fail` sets `blocked` |
| `tools/inhuman/commands/goal.scm` | `/goal <objective>` calls `set`; rows show `get` and call `clear`. It does not mint a completion |

`/goal` is that command file, not a kernel default and not a model tool. The client evaluates it like a kernel default command; its leaves call the session verb `plugin/method` on this plugin's session state. A child bot does not inherit this hook. Setting the goal does not wake anyone by itself; the round-end hook does, and only while loops remain.
