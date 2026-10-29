# @inhuman.tools/statusline-opencode

An OpenCode TUI plugin that shows the quiet part of our git statusline under the prompt, in the
`prompt.footer.status` slot, dimmed: `rebasing 2/5, conflicts`, `uncommitted`, `3 local commits`.

It leaves out the branch on purpose: OpenCode already shows `dir:branch`. A clean, level branch has an empty
clause, and then nothing is rendered.

It refreshes on start, on `vcs.branch.updated`, after tools, shell commands and session turns, and when git's own
files change (debounced, never two runs at once).

## Enable

Needs an OpenCode release with the v2 plugin API (`@opencode/plugin/tui`). The package exposes only a `./tui` part,
so list it in `cli.json`:

```json
{ "plugins": ["@inhuman.tools/statusline-opencode"] }
```

From a checkout, use the directory instead: `"plugins": ["/path/to/packages-statusline/opencode-statusline"]`.
The package is private and ships TSX source; OpenCode compiles it when it loads the plugin.
