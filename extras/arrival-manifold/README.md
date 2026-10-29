# @inhuman.tools/arrival-manifold

An MCP proxy that collapses N upstream MCP servers' per-tool JSON-schema tools into **one**
tool: `scheme-repl-with-all-mcp-tools`. Its single argument (`repl-input-scheme-program`) is a
Scheme program that the real [arrival](https://github.com/here-build/arrival) interpreter evaluates;
every upstream tool becomes a callable symbol `(server/tool :arg value)` inside that program.
Nothing here is a toy interpreter or a regex bridge — it is arrival's actual R7RS-subset
evaluator, wired to a live MCP client fleet.

**Pre-winter AI, in service of the thing that took its name.**

The machinery under this proxy is, without embarrassment, an **expert system**: a bounded set
of recognizer rules that know some response shapes cold and hand back everything else
untouched — the 1970s paradigm, the one that ran on Lisp machines and *was* "artificial
intelligence" before the winter took the word away. Here it is again, doing what it was always
good at — brittle precision, held honestly — one layer beneath a neural model. What was once
the whole field no longer even registers as intelligence. That is not a demotion; it is the
tenure of infrastructure.

The irony completes in both directions. Expert systems died of the knowledge-acquisition
bottleneck — hand-authoring rules never scaled past their authors. This rule base was
surveyed, derived, and adversarially validated across 169 real MCP servers: the new AI
dissolved the old AI's fatal flaw. And LLMs flail exactly where expert
systems are sound — serialized structure, strict boundaries, knowing when you don't know — so
the old AI now supplies what the new one lacks. Each cures the other's cause of death.
Together they are the medium.

## What it replaces

| | Native per-tool calling | arrival-manifold |
|---|---|---|
| Tools exposed to the model | N (one per upstream tool, full JSON Schema, resent every turn) | 1 |
| Composition | one tool call round-trip per step | pipe/compose in one program, one round-trip |
| Tool identity | schema-constrained `name` field | homoiconic symbol inside the program text |
| Error surface | opaque platform "invalid params" | doors: fact + reason + exact retry syntax |

## Why one REPL tool instead of N tools — headline numbers

Measured on **MCP-Atlas**: 89 grounded multi-server tasks, LongCat-2.0 as judge, 15 full runs
per configuration, per-task fixed-effects + paired contrasts (not naive single-run A/B — see
the Methodology section: the noise floor is real and large enough that a single run cannot be
trusted alone).

| Arm | Coverage | Pass | Token cost |
|---|---|---|---|
| Best native (per-tool JSON calling, `native-5k`) | 0.658 | 56.2% | 1.0x (baseline) |
| Best scheme-REPL proxy (strictly neutral client)¹ | 0.72–0.73 | 62–63% | ~1.15–1.25x |
| **Delta** | **+7pt** | **+6pp** | **+15–25%** |

¹ Measured with zero client-side translation and zero coaching. An earlier harness silently
auto-translated native-style tool calls into the REPL; every headline number here postdates
its removal (see the Methodology section's client-neutrality note).

Mechanism: composing multiple tool calls inside one program eliminates round-trips a
schema-constrained native call can't avoid (pipe a result straight into the next call, filter/
reduce before it ever re-enters the transcript) — the token surcharge buys higher task
completion, not just verbosity.

## Design decisions

| Decision | Why | Measured |
|---|---|---|
| Qualified names are `server/tool` (slash) | matches model priors, avoids bare-name collision with snake_case tool names | +6.7pt coverage, +3.4pp pass vs `_`-joined names (sign-test p=0.08) |
| Errors are doors (fact + reason + exact retry syntax) | a rejection with no next action is dead weight — teach on contact, not up front | door-repair batch: +2 to +6pp pass, consistent sign across FE + paired estimates |
| No truncation banner | rendering it added pure token cost with no behavior change | Δcoverage −0.009 [−0.105, +0.086] — null, so the code was deleted |
| Default response budget 20,000 chars | starves below ~8k, plateaus above 20k | 20k vs 8k: +2.8pp pass [0.0, +5.6]; 4k: −5.9pp [−10.1, 0.0]; 40k over 20k: −1.2pp (noise) |
| Server-side unknown-tool catchall stays | every surveyed MCP client forwards `tools/call` without client-side validation | reachable across the whole surveyed client ecosystem; worst case never fires |
| No client-side coaching assumed | real clients give bare "unknown tool" errors | all headline numbers measured under a strictly neutral client (footnote¹) |
| Statement-facts runs on arrival's real parser, not an approximation | a spike/regex stand-in hides crash classes the real reader has | +2.5pt coverage, +2.2pp pass; crash count 3→1 (remaining 1 is an upstream server bug) |
| Package split (binder vs runner) is architecture-only | proves the split didn't change behavior, only where the code lives | pkg_split factor ≈ null once de-aliased: −0.4pp [−4.4, +2.6] |

### 1. Qualified names: `server/tool`, not `server_tool`

`/` is the manifold's own namespace separator and is never legal inside a bare Scheme
identifier, so a qualified name is always unambiguously re-splittable into `(slug, tool)` by
its last `/` (see `src/bind.ts`, and `../../packages-runtime/substrate/src/doors.ts`'s `bareNameOf`). The underscore-joined
alternative was tried and reverted: models already carry strong priors for `namespace/symbol`
addressing, and `_`-joining collides with tool names that already contain underscores
(`server_get_user` vs `server/get_user` — only one of these is unambiguously splittable back
out). Measured: **+6.7pt coverage, +3.4pp pass** for `/` over `_`, sign-test p=0.08 — the
cleanest single-factor paired contrast in the whole design (the fixed-effects estimate agrees
with the paired estimate almost exactly, which is not true of every factor here — see the
Methodology section's de-aliasing note for factors that don't cleanly separate). Both runs in
this contrast use the strictly neutral client (footnote¹), so no era confound rides on it.

The wire boundary (MCP/OpenAI tool names, constrained to `^[a-zA-Z0-9_-]+$`, no `/`) still
needs a de-slashed spelling for a direct ("bypass") call attempt — that translation lives at
the `CallTool` boundary (`src/server.ts`'s `resolveBypass`/`buildBypassResolution`), never in
the Scheme-side join itself.

### 2. Errors are doors

Every rejection surface states the fact, the reason, and the exact retry syntax — never a bare
"invalid" with no path forward. An alert without an alternative gets overridden by the model on
the next turn; a rejection with an embedded fix gets followed. Components measured separately:

| Component | Measured |
|---|---|
| Exact-syntax remedies over vague ones | vague remedy ("filter/map/reduce helps"): 36% follow rate vs concrete remedy ("slice with substring at index N"): 81% follow rate — measured on truncation-message remedies; the banner surface itself was later removed (§3), the concrete-over-vague finding governs every remaining door |
| Synthesized working example calls on validation errors (`-32602` included) | part of the door-repair batch, +2 to +6pp pass |
| Import-form door, did-you-mean everywhere, bracket-balance hint on parse errors | same batch |

The unbound-in-expr door was separately certified against real trajectory garbles (49 unique
garble×task pairs replayed against the actual `unboundInExprDoor`, not a reimplementation):
**100% precision, 100% recall**, zero false explicit wrong-tool claims. A noise sweep of 193
excluded (non-tool-shaped) garbles found the door firing on 8/193 (4.1%) — all hedged
suggest-menu output, never an asserted wrong claim, flagged as a precision caveat (short common
variable names like `file`/`dir` can trigger an unsolicited tool-menu note) rather than a
correctness bug.

### 3. No truncation banner

The reduced-output banner (`#| ⚠ output reduced ... |#`) was A/B'd rendered-vs-silenced with
the underlying truncation mechanism held identical. Result: **null** — Δcoverage −0.009
[−0.105, +0.086], sign-test p=0.76; Δpass +1.1pp [−10.1, +12.4]pp, p=1.0. The banner's mere
announcement bought nothing; it was pure token cost. **The banner code was deleted outright**
(not defaulted off — there is no config knob to bring it back), and the competence
remedy-gradient machinery that generated its per-message remedies was deleted with it.
Reduction stays visible to the model at the exact cut points via inline elision markers, now
the only truncation signal:

- `#| +N more of TOTAL |#` for dropped collection items
- `…(+N chars)` for truncated strings

This is the honest-null case in this doc: a design decision justified by absence of effect, not
presence — see the Methodology section for why we trust a null this size (CI width ~±10pp) at all.

### 4. Response budget: 20,000 chars default

| Budget | vs 20k baseline | Read |
|---|---|---|
| 4,000 | −5.9pp [−10.1, 0.0] | clearly starves |
| 8,000 | −2.8pp [reciprocal of the 20k-vs-8k contrast below] | binds on fat-tail results |
| **20,000 (default)** | — | — |
| 40,000 | −1.2pp (noise) | no gain over 20k |

20k vs 8k: **+2.8pp pass [0.0, +5.6]**. The budget factor's identification spans both
measurement eras (footnote¹); the factor model carries an explicit era term to absorb it.
Configurable four ways, so a deployment or even a single call
can override the default without a code change — deployment-default precedence is
**CLI flag > env var > config file > 20,000** (`src/bin.ts`):

| Surface | Name | Scope |
|---|---|---|
| Per-call tool argument | `response-size` (`RESPONSE_SIZE_ARG_NAME`, clamped to [1,000, 40,000]) | this call only, never mutates the deployment default |
| CLI flag | `--response-character-cap <n>` | deployment default, highest precedence; a non-positive-integer value is a loud usage error, never a silent fallback |
| Env var | `ARRIVAL_RESPONSE_CHARACTER_CAP` | deployment default, container/orchestrator-friendly |
| Config file key | `observation.maxTotalChars` (`mcpServers.json`) | deployment default, lowest-precedence override |

The 40,000 per-call clamp ceiling and the 20,000 default are pinned in one place
(substrate's `calibration.ts`: `responseSizeMaxChars: 40_000`,
`observationMaxTotalChars: 20_000`) — the numbers in this section are those constants, not
prose that can drift from them.

### 5. Server-side unknown-tool catchall

Every surveyed MCP client — the official TypeScript and Python SDKs, Claude Desktop, Claude
Code, Cursor, VS Code Copilot, the OpenAI Agents SDK, LangChain's MCP adapters — forwards
`tools/call` to the server without client-side name validation. That means a server-side
teaching door on an unrecognized tool name is reachable across the entire surveyed client
ecosystem for the tool-drift case (a model hallucinating a bare tool name instead of wrapping
it in the REPL call); in the worst case where a specific client *does* intercept unknown names
first, the door simply never fires — no client integration is required to make it safe to add,
and none is required to benefit from it.

### 6. Neutral-client honesty

No client-side coaching is assumed anywhere in the measured numbers above. All teaching lives
server-side — in the catalog preamble (`src/catalog.ts`) and in the doors — because real MCP
clients give bare, unadorned "unknown tool" / "invalid params" errors with no scaffolding of
their own. Every headline number in this doc is measured under a strictly neutral client —
zero translation, zero coaching — so none of it depends on a specific client's UI or retry
behavior to hold (footnote¹).

### 7. Statement-level analysis on the real reader

Statement-facts (the per-statement analysis pass) runs against arrival's actual parser — not a
regex or spike approximation of Scheme syntax. Running it on the real reader surfaced and fixed
two production crash classes that a regex-based approximation would have hidden entirely:
R7RS `#\"` character literals and `#;` datum comments. Measured: **+2.5pt coverage, +2.2pp
pass**, crash count **3 → 1** (the one remaining crash traced to an upstream server bug, not
this package).

### 8. Package split (binder vs runner) — architecture, not behavior

The doors-steering runner extracted into `@inhuman.tools/substrate` (`../../packages-runtime/substrate`);
this package (`arrival-manifold`) keeps only the binder-owned surface — tool
naming, prompt fields, the `describe()`/`call()` MCP-facing wrapper (`src/manifold-tool.ts`).
The split was explicitly measured for behavior cost so the refactor claim ("this changed
nothing observable") isn't just asserted: **pkg_split factor ≈ null once de-aliased, −0.4pp
[−4.4, +2.6]**. It's a code-organization change, not a benchmark-relevant one.

## Configuration

Config file uses the standard `mcpServers.json` shape (the same convention Claude Desktop /
Claude Code use for `.mcp.json`) plus manifold-specific optional extensions:

| Key | Type | Default | Effect |
|---|---|---|---|
| `mcpServers.<name>.command` / `.url` | string | — | stdio or http upstream (exactly one required) |
| `mcpServers.<name>.tools` | string[] | all tools bind | per-server tool allowlist; a name the server doesn't expose is a loud bind-time error |
| `evalTimeoutMs` | number | 15,000 | per-call wall-clock eval budget |
| `catalog.detail` | `"full"` \| `"summary"` | `"full"` | full renders every bound tool's signature; summary substitutes caller-provided text |
| `attestation` | `"off"` \| `"available"` \| `"required"` | `"available"` | `s/*` type-assertion family: unbound / bound-but-optional / required on every model-authored argument |
| `rendering` | `"braces"` \| `"sexpr"` | `"braces"` | dict/list print as `{:k v}`/`[a b]` vs `(dict ...)`/`(list ...)` |
| `observation.maxTotalChars` | number | 20,000 | response character budget default (§4); lowest-precedence override — CLI flag and env var beat it |
| `promptFields.intent` / `.successCriteria` | boolean | `false` / `false` | opt-in metadata fields on the tool schema — never parsed/executed, measured to help weaker models, dead weight on strong ones |
| `typeHints` | `"off"` \| `"telemetry"` \| `"on-error"` | `"telemetry"` | type-hints lens: off (never runs), telemetry (runs, never renders — the calibration corpus), on-error (renders a trailing hint on an errored statement) |

CLI / environment:

| Surface | Name | Effect |
|---|---|---|
| CLI flag | `--config <path>` | required; path to the `mcpServers.json`-shaped config |
| CLI flag | `--response-character-cap <n>` | deployment-default response budget; precedence CLI > env > config file > 20,000 |
| Env var | `ARRIVAL_RESPONSE_CHARACTER_CAP` | same budget override, one step below the CLI flag |
| Env var | `MANIFOLD_TYPE_HINTS` | overrides `typeHints` at deploy time; unset ⇒ config file value ⇒ `"telemetry"` |

Per-call tool arguments (part of the MCP tool schema itself, not config):

| Argument | Type | Bounds | Default | Effect |
|---|---|---|---|---|
| `repl-input-scheme-program` | string \| string[] | — | required | the program to evaluate |
| `response-size` | integer | [1,000, 40,000] | `observation.maxTotalChars` | this call's response character budget only |
| `response-attachments` | integer | [0, 8] | 3 | how many binary (image/audio/blob) content blocks pass through as real MCP blocks this call |

## Methodology & noise floor (read this before trusting any single number above)

MCP-Atlas variance decomposition (89 tasks × 15 runs, LongCat-2.0 judge):

| Source | Share of variance |
|---|---|
| Task difficulty (between-task) | 43–46% |
| Run-to-run noise (within-task) | 54–57% |

**21 of 89 tasks are flaky** (within-task std > 0.35) and alone carry **53% of all within-task
(run-to-run) variance**. The `git` MCP server is a measured instability driver on flaky tasks
(β=+0.098 to +0.119 depending on spec, p≈0.001–0.0014); network-backed servers are exonerated
as a class (Welch t-test p=0.59; OLS coefficient on server locality not significant).

**Client neutrality (footnote¹):** an earlier harness silently auto-translated native-style
tool calls into the REPL, partially measuring native function-calling behind a translating
proxy. Every headline claim in this doc is grounded in strictly-neutral-client runs made after
that translation was removed; where a factor's identification spans both eras, the factor
model carries an explicit era term to absorb the boundary.

**Why this matters for every number above:** the run-to-run noise floor for a naive
single-run A/B on this benchmark is on the order of **±11pp pass** — wide enough to make a
single comparison run indistinguishable from chance for most of the effects in this doc. That
is why every claim here is backed by within-task fixed-effects regression **and** paired
per-task contrasts **and** a run-cluster bootstrap, not a single pair of runs. Where a CI still
crosses zero (most individual factors in the design), we say so
plainly rather than rounding a noisy point estimate into a confident-sounding claim — the
honesty here is itself part of the signal this doc is trying to send: a package whose docs
hide their noise floor is a package whose numbers you can't trust anywhere else either.

## See also

- `@inhuman.tools/substrate` (`../../packages-runtime/substrate`) — the doors-steering
  runner: session-scoped teaching apparatus (competence window, futility tracking, type-hints
  lens, calibration options). This package constructs one `DoorsRunner` per tool instance and
  delegates every statement-eval / door / session-history mechanism to it.
