# `@inhuman.tools/policy-openclaw`

OpenClaw loads this package as a plugin. The entry is `{ id: "policy-openclaw", register(api) }`. `register` listens on `before_tool_call` for `exec`, `write`, `edit`, and `apply_patch`.

A floor `block` returns `{ block: true, blockReason }` and does not call a model. A known tool with no command or path does the same. Code-mode `exec` (`toolKind: "code_mode_exec"`) returns no decision, so the host's code-mode policy stays in charge. `apply_patch` is one `policy.write` per `derivedPaths` entry. The patch body is not sent.

This package calls `api.runtime.decisions.evaluate` when that method exists. `disabled` and `not-configured` fall through to structured output. Any other unavailable result denies. Structured output denies when no model is connected.

`@inhuman.tools/policy-openclaw-sage` (`policy-openclaw-sage`) reads `sageApiKey`, and reads `SAGE_API_KEY` only when that field is omitted. An empty `sageApiKey` does not read the environment. `@inhuman.tools/policy-openclaw-jev` (`policy-openclaw-jev`) reads `jevApiKey`, then `TYPESAFE_API_KEY`, then `JEV_API_KEY`, with the same empty-field rule. Those packages do not call `decisions.evaluate`.

`authorizationPath` is the user's program. Unset runs the dist script. `POLICY_AUTHORIZE` is the same path when the config field is omitted. A missing file denies.

The hook budget belongs to OpenClaw (15 seconds unless the operator raises it). This package asks the decision runtime for 10 seconds and passes `ctx.abortSignal`.

Category grants are not offered. `requireApproval` is not returned.

Install is `openclaw plugins install` plus `plugins.entries.policy-openclaw.enabled`. This package does not install itself.
