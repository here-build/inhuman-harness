# `@inhuman.tools/policy-pi`

Pi extension on `tool_call`. There is no ask verdict: the tool runs, or it returns `{ block: true, reason }`.

Every pi tool is gated. `bash` / `powershell` use the bash floor, `write` / `edit` the write floor, and `read` / `grep` / `find` / `ls` the read floor. Any other tool (an extension or an MCP bridge) is put to the judge by name and arguments; `trustedTools` skips the judge for named tools. Paths are normalised before the floor (`..`, case, absolute in-project paths), so `src/../.git/hooks/x` and `.GIT/hooks/x` are a `block`. A judge that has not answered in 20 s is a deny.

A floor `block` does not reach a model. `ask` and `deny` run the dist authorization program. Only `allow` runs. A judged call goes to pi's current model (`ctx.model` through `ctx.modelRegistry`, so pi's own credentials), prompted for a JSON `{value}` answer. It denies when pi has no model, when the call fails, or when the answer is not a vote. It does not read an API key.

`@inhuman.tools/policy-pi-sage` reads `SAGE_API_KEY`, then `<agentDir>/secrets/policy-pi-sage-api-key` (mode `0600`). `@inhuman.tools/policy-pi-jev` reads `TYPESAFE_API_KEY`, then `<agentDir>/secrets/policy-pi-typesafe-api-key`. Jev also reads `JEV_API_KEY` after `TYPESAFE_API_KEY` (the same order as the other Jev adapters). Neither file is `auth.json`. `<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.

`/policy-pi` on this package is `status` and `program edit|clear`. The sage and jev packages add `login` and `logout`. The user program is `<agentDir>/policy-pi-authorize.scm`. Clearing it returns to the dist script. A project cannot replace that file.

`<agentDir>/policy-pi.json` may set `{ "enabled": false }`. The same file at `<cwd>/.pi/policy-pi.json` applies only when `ctx.isProjectTrusted()` is true, and it may turn the gate off. The project file is not read at all before the project is trusted. An unreadable settings file (a directory, a permission error) counts as absent, and a trusted project's one is reported once; an unreadable program file blocks the call.

Install with `pi install` from one of these packages. Do not install two of them: each listens to `tool_call`.
