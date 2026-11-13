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

For budget investigations, `ELISION_EVAL_REASONING` selects the production
reasoning dialect (for example `none`). `ELISION_EVAL_SEED` makes the synthetic
source reproducible, and `ELISION_EVAL_REPORT_DIR` saves per-case JSON containing
token counts, response sizes, recall ranges, tool outcomes, and the final report.
These reports exclude source text, reasoning text, arguments, and credentials.
Use the same seed when comparing reasoning settings.

The 8192-token limit belongs to this evaluation. The production chat actor does
not currently set `max_tokens`; an evaluation budget failure alone does not show
that production imposes the same limit.

In a Qwen4-Max-Preview investigation on 2026-11-13, both modes recalled the full
5816-character original argument JSON. With the same source and 8192-token cap,
default thinking spent 6354 tokens on reasoning in the write round and returned
truncated write arguments. Explicit `none` produced a complete write using 2863
output tokens and verified the exact 5663-byte file. These are individual runs;
default thinking also passed in another run, and rate limits interrupted others.
The experiment identifies budget pressure, not a guarantee about model behavior.

The investigation also found that `qwencloudapi.com` was absent from provider
recognition, so explicit reasoning settings had no Qwen request fields. The host
regression now covers the Token Plan and regional endpoints plus a spoof suffix.
See the [official endpoint](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart)
and [Qwen4 output-budget notes](https://docs.qwencloud.com/developer-guides/getting-started/latest-model).
