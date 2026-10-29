# `@inhuman.tools/pretty-mcp`

Per-server catalog of tool identity. Each tool is an explicit row — no
prefix families, no Scheme. Templates are Mustache; output is markdown.

A catalog file holds, for every `serverToolName`:

- `opts` — JSON Schema for arguments
- `question` — Mustache (ask / live). First line ends with `?`.
  Extra objects continue on following lines (the block).
- `effect` — Mustache (sealed); same shape, stem swapped, no `?`
- `result.schema` + `result.serializer` — result shape and a Mustache
  pretty-printer when we have one. View is `{ ok, text?, value? }`.
  Toolkit text tools print `{{text}}`. MCP success is `{{value}}` (a
  string when `content` is one text block). Render lifts JSON strings
  and text-block arrays so named fields print. Image / mixed `content`
  lifts to `{ images: [{ src }], texts }` and prints `![]({{src}})` —
  a file or URL when the text names one, else a data URL.

`splitIdentity(markdown)` is the compact/expanded cut: `{ line, block }`.
One template, two presentations. The TUI transcript paints the line
(question while live/ask, effect when sealed) and the serializer on
expand. Gutter chrome is not this package.

Schemas come from the MCP server (or a reconstruction from slimmed args).
Templates are filled later. Compute is cheap; coverage is a residual
queue.

```
pnpm --filter @inhuman.tools/pretty-mcp retrieve
pnpm --filter @inhuman.tools/pretty-mcp generate
pnpm --filter @inhuman.tools/pretty-mcp uncovered -- --json --limit 20
pnpm --filter @inhuman.tools/pretty-mcp uncovered -- --serializers --json --limit 20
```

`retrieve` rebuilds `calibration.json` from the Smithery cache.
`generate` writes `catalog/<id>.json` (schemas refresh; question / effect
/ serializer are never overwritten). `uncovered` lists tools still
missing both templates — the residual identity job. `--serializers`
lists identity-covered tools still missing a result template.

Covered servers are committed (`git add -f catalog/<id>.json` if
gitignored). Schema-only candidates stay local.

Template law: [pretty-mcp-cover](../../.cursor/skills/pretty-mcp-cover/SKILL.md).
Pretty-print every distinguishing arg. Do not drop arrays.

Not `tool-call-normalize`. Not `arrival-manifold`.
