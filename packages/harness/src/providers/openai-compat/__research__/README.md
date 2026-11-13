# Elision behavior evaluation

This opt-in suite uses a configured OpenAI-compatible connection, the production
`viewWire` history projection, and real file tools in a temporary workspace. It
drives the response/tool loop directly; it does not exercise daemon approval or
actor retry behavior. It sends synthetic history, not an existing chat.

Run from `packages/harness`:

```sh
ELISION_EVAL_CONNECTION=CONNECTION_ID ELISION_EVAL_MODEL=MODEL_ID \
  pnpm research src/providers/openai-compat/__research__/elision.test.ts
```

`ELISION_EVAL_KERNEL` defaults to `~/.harness`. Configuration and connection
credentials are read without modifying them. Evidence logs contain case names,
tool outcomes, artifact sizes, and the final source report; they exclude
credentials and document bodies. Without both connection and model variables,
the four cases are explicitly skipped. The ordinary test suite does not run them.

The cases cover generating a new plan after abbreviated history, recovering an
original across recall pages after its file changed, generating new content
after an unreachable reference, and intentionally quoting a marker.

Scoring checks the actual saved file, a successful read after the last write,
and a structured final source claim. Original recovery additionally requires
gap-free recall coverage and exact content containing unpredictable fixture
tokens. The quotation case protects intentional literal text. Each case is
limited to eight response rounds, 8192 output tokens per response, and a
two-minute request timeout. It cleans up its workspace even on failure.

Transport failures (including HTTP 429), output-budget exhaustion, and empty
provider replies fail the live run explicitly. They are not scored as evidence
that the model mishandled elision. This suite does not retry them automatically.

A pass measures these scenarios on the selected model and provider. It is not a
general proof that models will never imitate markers or make unsupported claims.
