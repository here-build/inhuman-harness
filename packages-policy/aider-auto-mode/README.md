# `@inhuman.tools/policy-aider`

Aider has no third-party pre-tool verdict API. This package exports `evaluateCall` so a wrapper can call it. The function cannot be installed as an Aider plugin today.

`evaluateCall` uses `defaultPolicy`. Bash strings use `bash`. Path writes use `write`. Floor `block` denies without the judge. Floor `approve` allows. Floor `ask` and `deny` call `judge`. A null judge, a null vote, and a thrown judge deny.

`judgeWith` binds a decide capability. `@inhuman.tools/policy-aider-sage` and `@inhuman.tools/policy-aider-jev` import it. This package judges with structured output.
