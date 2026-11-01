# Scheme execution modes

- `scheme_repl` evaluates once. Its schema has no `period`; the interpreter rejects a supplied `period` before executing any forms, with instructions to remove it for ordinary work.
- `scheme_watch` requires `period` and uses the same interpreter, tool permissions, worker APIs, and base symbols. Its description references the REPL's live symbol catalog instead of duplicating it. Only watcher-specific reactivity symbols are documented on the watcher.
- `(require path)` and `(load path)` share the Arrival loader. Interactive runs jail at the workspace root. Combined eval with `sourcePath` stays under that entry file's directory. `.scm` spills; `.json` / `.yaml` return data; `.prompt` returns a callable. Skill inputs still go through licensed `read_file`.

Use a watcher for requested monitoring, such as checking GitHub comments and notifying the user about new activity. The harness schedules each check without requiring another model turn, reducing context and token usage compared with a conversational loop. A slow agent request or background operation is not a reason to schedule repeated execution.

`timeoutMs` limits an execution (one iteration for a watcher) when set; omit it for no time limit. `maxInternalCalls` limits inner tool calls when set; omit it for no call budget. `background` returns control without waiting; it does not schedule repetitions. `period` schedules iterations and belongs only to `scheme_watch`. Limits apply per iteration, not to idle time.

## Notifications and stopping

Both tools share `self/notify`. It sends an update without completing execution. Use `background: true` for conversation notifications while a watcher continues; within a worker request, notifications attach to that request.

A watcher must reach `(meta-reactivity/done-condition stop? [result])`:

- **Wake me when a new comment appears:** detect new activity, call `self/notify`, then set the done condition true.
- **Keep notifying me about new comments:** notify on new activity and keep the done condition false (`#f`); monitoring continues until cancelled or another requested stopping condition occurs.

`meta-reactivity/added`, `removed`, and `changed` retain comparison state across iterations. Ordinary Scheme definitions do not persist across iterations. Quoted done conditions, unapplied lambdas, and unreachable branches do not satisfy validation. Do not manufacture a constant-true condition to make one-shot work fit the watcher API.

## Routing

Both outer tools admit a `ProgrammaticJob`; its persisted `toolName` selects the argument schema and preserves watcher identity. Neither outer tool is exposed as a nested Scheme symbol. Permissions remain on the inner operations. The shared symbol catalog is projected only on `scheme_repl`; the watcher references it.

## Writing agent briefs and continuations

Agent messages are delivered as authored. Use normal word spacing and readable
sentences; concise briefs remove repetition while preserving the relationships
between facts. Include the goal, relevant context and constraints, the worker's
owned scope, and the evidence required for completion. Keep paths, identifiers,
quoted requests, and errors exact. A disposable worker starts without the
caller's conversation history.

For example:

> Fix draft recovery in `src/chat.ts`. Preserve the existing save format. Own
> that file and its recovery tests; another worker owns the UI. Completion means
> the interrupted-draft test passes and existing recovery behavior still works.
> The previous call timed out after 1200000 ms. Its last verified change was the
> recovery parser; test status is unknown. Check that worker's current state and
> the working tree before assigning overlapping work.

A timeout, tool failure, or exhausted budget is an observed event, not proof of
completion or proof that all underlying work stopped. Continuations should name
the worker or task, distinguish verified progress from remaining work, and state
what must be checked before resuming. Report actual test outcomes and unresolved
blockers instead of treating a returned response as a success signal.

The live Scheme tool description and agent communication tool descriptions carry
this guidance. The default compaction prompt preserves it in readable state
snapshots. These instructions influence authoring; they do not repair historical
messages or rewrite user prompts, and custom prompts can choose different rules.
