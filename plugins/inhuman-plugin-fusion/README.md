# `@inhuman.tools/plugin-fusion`

A session planner in the Devin shape. At round end it reads two granted receivers and emits one note. The host ORs that note with every other bot's continuation and admits at most one next round.

| Piece | Role |
|-------|------|
| `behavior/session.scm` | Plan text, remaining steps, last recall. `open`, `advance`, `recall`, `block`, `clear`, `get` |
| `behavior/foreground.scm` | `hook/round` `:post` searches project memory and notifies `activating` with one fused line. `:post-fail` sets `blocked` |
| `tools/inhuman/commands/plan.scm` | `/plan <objective>` calls `open`; rows show `get` and call `clear`. Same shape as `/goal` |

The memory grant is `get-memory` and `search` on the offload project owner. The planner cannot commit. It does not subscribe to tasks, goal, or offload. A silent search still leaves the plan as the note. An empty plan emits nothing.

This program registers no guard. A guard belongs on a pack that stands on a tool argument, and that registration is consent-bound.
