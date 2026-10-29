# `@inhuman.tools/policy-opencode-sage`

OpenCode permission hook on Sage. Plugin id `inhuman.policy-opencode-sage`. Imports `prepareCall`, `programOf`, and `voteDocuments` from `@inhuman.tools/policy-opencode` and binds `sageDecideCapability`.

The key is `sageApiKey`, then `SAGE_API_KEY`. An empty string is missing. `JEV_API_KEY` and `TYPESAFE_API_KEY` are not read. A missing key denies an ask. A literal allow program does not call the model.
