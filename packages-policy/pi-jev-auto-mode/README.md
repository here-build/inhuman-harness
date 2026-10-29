# `@inhuman.tools/policy-pi-jev`

Pi extension on Jev. Imports `register` from `@inhuman.tools/policy-pi` and binds `jevDecideCapability`.

`TYPESAFE_API_KEY`, then `JEV_API_KEY`, then `<agentDir>/secrets/policy-pi-typesafe-api-key` (mode `0600`). No key denies a judged call. `SAGE_API_KEY` is not read. `/policy-pi` adds `login` and `logout`. Do not install it beside another policy-pi package.
