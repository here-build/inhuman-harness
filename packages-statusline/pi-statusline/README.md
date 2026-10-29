# `@inhuman.tools/statusline-pi`

Pi extension that paints the git status clause in pi's footer: `rebasing 2/5, conflicts`, `uncommitted`, `3 local commits`. A clean, level branch shows nothing.

It omits the branch. Pi already paints `cwd (branch)`.

It refreshes on session start, after each tool execution, and at turn and agent end. It also watches the git files, so a commit made in another terminal shows up. Runs are coalesced: one at a time, one more if something changed meanwhile. A failure or a 5 s timeout clears the status. The footer key is `git`.

Install with `pi install` from this package.

`<agentDir>/statusline-pi.json` may set `{ "enabled": false }`. `<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
