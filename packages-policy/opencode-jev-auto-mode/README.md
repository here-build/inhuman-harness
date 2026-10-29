# `@inhuman.tools/policy-opencode-jev`

OpenCode permission hook on Jev. Plugin id `inhuman.policy-opencode-jev`. Imports `prepareCall`, `programOf`, and `voteDocuments` from `@inhuman.tools/policy-opencode` and binds `jevDecideCapability`.

The key is `jevApiKey`, then `TYPESAFE_API_KEY`, then `JEV_API_KEY`. An empty string is missing. `SAGE_API_KEY` is not read. A missing key denies an ask. A literal allow program does not call the model.
