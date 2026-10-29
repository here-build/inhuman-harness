# `@inhuman.tools/policy-crush-jev`

Crush PreToolUse command `policy-crush-jev`. Imports `judgeWith` from `@inhuman.tools/policy-crush` and `programSource` from `@inhuman.tools/policy-crush/hook`, and binds `jevDecideCapability`.

The key is `TYPESAFE_API_KEY`, then `JEV_API_KEY`, from the process environment. No key denies an ask. A floor block does not call the model.
