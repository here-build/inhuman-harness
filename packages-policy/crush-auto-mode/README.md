# `@inhuman.tools/policy-crush`

Crush has no in-process plugin API. It runs a command hook. This package ships that command as `policy-crush`.

Enable it from `~/.config/crush/crushrc` or the project `.crushrc`:

```bash
hook add PreToolUse \
  --name policy-crush \
  --matcher '^(bash|edit|write|multiedit)$' \
  --timeout 45 \
  --command "policy-crush"
```

The command reads the hook JSON on stdin and prints `{ "decision": "allow" }` or `{ "decision": "deny", "reason": "..." }`. Crush only honors `allow` and `deny`. A timeout, a crash, or any other string is no opinion, and with `--yolo` the tool then runs. The command therefore denies itself after 20 seconds, inside the 45 second hook timeout.

This package is structured output. A judged call denies when no model is connected. `@inhuman.tools/policy-crush-sage` ships `policy-crush-sage` and reads `SAGE_API_KEY`. `@inhuman.tools/policy-crush-jev` ships `policy-crush-jev` and reads `TYPESAFE_API_KEY`, then `JEV_API_KEY`. Put those variables in Crush's `env` map. A hook does not see provider `api_key` fields. `POLICY_AUTHORIZE` is a path to a user program. Unset runs the dist script. A missing file denies.

`view` is not matched, so Crush's prompt for paths outside the working directory stays. Category grants and `--yolo` are not part of this setup.
