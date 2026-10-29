# Skill compiler IR

The compiler now has two structured intermediate representations.

`analyze.prompt` emits **semantic IR**: entrypoints, phases, inference units, loops,
branches, parallel regions, persistent actors, effects, state, human gates, reactive
conditions, constraints, and explicit uncertainties.

`lower.prompt` emits **lowering IR**: Scheme functions/entrypoints, Dotprompt leaves,
persistent actor calls, effect bindings, watches, re-entry points, library needs,
runtime gaps, source→target decisions, and preservation checks.

Neither IR contains a monolithic `semanticSpec` or `plan` string. Prose remains only
inside local descriptive fields where the underlying semantic fact is naturally textual
(e.g. a stop condition or invariant). Codegen and audits consume the structured values
directly.

## Audit policies are data

Audit policies are not encoded in Scheme and not hard-coded into `audit.prompt`.
`audit-lenses.yaml` is required as ordinary Arrival data; the returned vector is mapped
directly. Each lens is a dict containing its purpose, checks, rejection conditions, and
pass condition.

Adding or editing a lens therefore changes data, not compiler control flow.

## Kwargs and path access

Compiler prompts do not repeat nested `input:` schemas for values produced by earlier
stages. Arrival invokes `.prompt` imports through kwargs, and Dotprompt/Handlebars can
address nested paths directly (`analysis.loops`, `lowering.prompts`, `bundle.program`, ...).

The output contract is owned by the producing stage; consumers simply receive that value.

## Small functional control plane

The Scheme control plane uses the polyglot surface where it improves readability:

- `cute` captures immutable audit context while leaving the lens as the varying slot.
- `->` is used for the trivial Markdown → files → compile adapter.
- YAML/JSON/TOML resources remain ordinary values and can be mapped/filtered/reduced directly.
