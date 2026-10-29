# `@inhuman.tools/policy-crush-sage`

Crush PreToolUse command `policy-crush-sage`. Imports `judgeWith` from `@inhuman.tools/policy-crush` and `programSource` from `@inhuman.tools/policy-crush/hook`, and binds `sageDecideCapability`.

The key is `SAGE_API_KEY` from the process environment. No key denies an ask. A floor block does not call the model.
