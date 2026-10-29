# `@inhuman.tools/policy-pi-sage`

Pi extension on Sage. Imports `register` from `@inhuman.tools/policy-pi` and binds `sageDecideCapability`.

`SAGE_API_KEY`, then `<agentDir>/secrets/policy-pi-sage-api-key` (mode `0600`). No key denies a judged call. `JEV_API_KEY` and `TYPESAFE_API_KEY` are not read. `/policy-pi` adds `login` and `logout`. Do not install it beside another policy-pi package.
