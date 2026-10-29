# `@inhuman.tools/activity-pi`

Pi extension that gives the model `update_metadata` (and `context_need`, below): it reports what is going on in the session, a title and a short description of the current state. It is not a per-action description like bash's `description`.

It costs no extra round when the model speaks. Same rule as the harness:

- call plus spoken text: the run ends after the batch (`terminate`);
- call alone, no text: one more round, and the result carries the note to call it in the same completion as other tool calls, last among them;
- call beside real tools: pi continues as usual.

It shows as the session name (title), the working message (title) and the footer status `activity` (description). The transcript row is one dim line, `title — description`, drawn by the tool's own renderer, so nothing enters the model context twice. A system-prompt guideline asks the model to call it when the state changes.

Install with `pi install` from this package.

`<agentDir>/activity-pi.json` may set `{ "enabled": false }`, which skips registering the tool. `<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.

## `context_need`

The same package registers `context_need`, the one-way signal with which the model says what the next stretch of work needs from context: `min_remaining_tokens`, `preserve {user_turns, rounds}`, `focus`, `current_phase_settled`. The name, wording and schema come from `@inhuman.tools/activity`, the same text the harness shows its models. The latest valid need is kept per session and dropped once a compaction has run.

Run control is the same as for `update_metadata`, minus the nudge: with spoken text the run ends after the batch; without it nothing is owed and pi simply continues. The transcript row is one dim line, for example `context: keep 3 rounds · focus the auth refactor`.

What it does on pi:

- **Compaction on request.** When the phase is settled (`current_phase_settled`), `min_remaining_tokens` is set and `ctx.getContextUsage()` shows less free context than that, the extension calls `ctx.compact()` once the run has settled (`agent_settled`; calling it inside the tool would abort the running turn). `focus` goes in as `customInstructions`, which pi appends to its summary prompt as "Additional focus".
- **No `current_phase_settled`, or no `min_remaining_tokens`:** nothing is compacted. A need without a floor cannot be compared against free context. Free context is unknown right after a compaction (`tokens` is null), and then nothing happens either.

What is not supported, because pi offers no hook for it:

- **`preserve`.** pi sizes the kept tail by `compaction.keepRecentTokens` and computes the cut before `session_before_compact` fires. The event's result can only cancel or supply a complete summary with its own `firstKeptEntryId`, which would mean writing a summarizer. So the extension only checks: if the cut keeps fewer user turns or tool rounds (assistant messages with tool calls) than asked for, and the history had more, it shows a warning. To keep more, raise `compaction.keepRecentTokens` in pi's settings.
- **`focus` for compactions pi starts itself** (threshold, overflow, `/compact` without instructions). pi gives extensions no way to add summary instructions there. A warning is shown instead.

Turns and rounds are counted on the active branch: a turn is a user message, a round an assistant message that issued tool calls.
