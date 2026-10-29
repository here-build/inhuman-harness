# `@inhuman.tools/policy-openclaw-jev`

OpenClaw plugin on Jev. Id `policy-openclaw-jev`. Imports the floor helpers from `@inhuman.tools/policy-openclaw` and binds `jevDecideCapability`.

`jevApiKey` is a secret input. A set value, including an empty string, does not fall through to the environment. Omitting the field reads `TYPESAFE_API_KEY`, then `JEV_API_KEY`. `SAGE_API_KEY` is not read. This package does not call `decisions.evaluate`.
