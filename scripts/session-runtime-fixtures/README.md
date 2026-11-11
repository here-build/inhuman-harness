`kley-0.1-session.json` contains a synthetic completed conversation encoded as normalized `session_nodes` rows (`SessionNodeRestoreState`). Its constructors created a session, system prompt, turn, and settled completion with no user conversation or credentials.

The installed-consumer test restores these rows using the candidate package’s session-only registration, continues the conversation, commits an effect, and verifies idempotent recovery from exported node rows.
