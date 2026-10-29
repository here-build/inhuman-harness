# Classifier research playground

Local-only. Not `pnpm test`.

```
pnpm research
```

Needs LM Studio at `http://127.0.0.1:1234/v1` with `essentialai_rnj-1-instruct@q4_k_s` **loaded**. Floor checks always run; live remainder skips if the server or that exact model id is missing.

Do not omit `model` on the wire — LM Studio with several loaded models will pick a different one (Nemotron/Gemma eat the token budget on reasoning). The research host pins `judgeModel` / connection `model` to RNJ.

- `cases.ts` — cited commands (GitHub / Reddit / X / in-repo). `floor` is dist policy; `hope` is the interesting classifier vote and is not asserted here.
- `red-team.ts` — prompt-injection / instruction-override payloads. Live scoreboard prints misses; it does not fail the suite when the model allows.
- `host.ts` — dist policy + `auto-mode-ask.scm` + openai-compat PEW against LM Studio
- `floor.test.ts` — hermetic labeled floor for the whole corpus
- `lm-studio.test.ts` — one floor-deny control and one remainder vote through RNJ
- `red-team.test.ts` — red-team floor labels + live RNJ scoreboard
