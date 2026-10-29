# `@inhuman.tools/policy-openclaw-sage`

OpenClaw plugin on Sage. Id `policy-openclaw-sage`. Imports the floor helpers from `@inhuman.tools/policy-openclaw` and binds `sageDecideCapability`.

`sageApiKey` is a secret input. A set value, including an empty string, does not fall through to `SAGE_API_KEY`. Omitting the field reads `SAGE_API_KEY`. This package does not call `decisions.evaluate`.
