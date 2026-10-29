# Storybook

In-terminal catalog for quickdraw widgets and layout, plus the multi-terminal
visual golden zoo. It lives in this package at `src/storybook`.

| Mode | Command |
|------|---------|
| Interactive catalog | `pnpm --filter @inhuman.tools/quickdraw storybook` |
| Unit | `pnpm --filter @inhuman.tools/quickdraw test` (project `storybook`) |
| Terminal goldens | `pnpm --filter @inhuman.tools/quickdraw visual` (**mac + real apps**; not CI) |

Interactive catalog and goldens
paint through `startRender` → `Renderer` → `RetainedPaintSource`
→ `renderFrame` — the same runtime as the product TUI. Harness has no
storybook; it only keeps the paint tree.

Stories call the package source directly (barrel, tea, widgets, buffer, layout,
theme, bgfx, syntax and markdown expanders). Visual goldens drive the harness
terminal driver (`packages/harness-tui/src/e2e`) and call `paintNode`
(`renderFrame`), not `startRender`.

## Principles

1. Production path only — real builders / layout / theme roles
2. One law per demo (5-second read or golden)
3. No claimed hex, no px literals, no emoji chrome
4. Cell laws golden-first; keymap/overlay stays interactive

## Chapters

Pipeline order, not content types:

**theme** → **layout** → **widgets** → **expand** → **buffer** → **fx**

`Markdown()` / `Diff()` live under widgets (public priors). Token grammar and
syntax highlight live under expand (internals). `paint` is now **buffer**.
**fx** is a bgfx canary, last and labeled not-product
(`pnpm --filter @inhuman.tools/quickdraw fx`).

Retired tags (`markdown` / `highlight` / `diff` / `paint`) still work as
`STORYBOOK_VISUAL_CATEGORY` aliases. There is no 1/2 story split.

## Visual goldens

`expandGoldenMatrix(CATALOG)` → slug `{storyId}__s{sample}__t{tick}` under
`src/storybook/__visual__/__screenshots__/storybook/<terminal>/`. Missing goldens fail.

```bash
UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/quickdraw visual
# filters: STORYBOOK_VISUAL_{STORY,CATEGORY,TERMINALS}
```

Interactive: `j`/`k` stories · `tab` focus · `/` filter · `←`/`→` sample · `q` quit · double Ctrl+C quit (cadence)
