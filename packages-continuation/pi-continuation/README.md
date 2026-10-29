# `@inhuman.tools/continuation-pi`

Pi extension for an agent that says it will do something, then stops. "I'll write the tests now." and the run ends with text and no tool call.

When a run is about to settle on a text-only final message, a small judge reads the message and decides:

- it declared work it has not done: pi continues once more with a short nudge ("call that tool now"), at most twice in a row;
- it asks you to approve or choose: pi settles and waits for you;
- it is a finished answer: pi settles.

Two cheap rules need no judge: an answer cut off by the output limit continues with "continue where you stopped" (up to 3 times in a row), and a round that only reasoned and produced no answer continues with "answer, or call a tool" (up to 8 times). A judge that fails, times out (30 s) or answers badly settles. It never keeps the agent running.

The nudge is appended at pi's `agent_before_settle` boundary as a hidden `custom_message` entry (not shown in the transcript). Pi has no system role there, so the model receives it as a user-role message. Counts are read from the session context, so a new prompt resets them.

Install with `pi install` from this package.

`<agentDir>/continuation-pi.json`, where `<agentDir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`:

```json
{ "enabled": true, "judgeModel": "provider/model-id" }
```

`enabled: false` skips the extension. `judgeModel` picks the model that classifies the message; by default it is the model you are chatting with. A small, cheap model is the reason for the setting: the call is one short classification, and a fast model does it as well as a large one. An unknown `judgeModel` falls back to the current model with a warning.

Cost: one small call each time a run ends on text with no tool call, which is most runs. The two cheap rules cost nothing extra.
