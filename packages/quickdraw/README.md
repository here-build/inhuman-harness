# quickdraw

**Terminal rendering substrate** for the harness — internal framework (cells,
CSI, layout, theme, caps, input, present).

In climbing, a **quickdraw** clips the *harness* into the bolt. Same wordplay:
the product is the harness (`../harness/`); this tree is how it meets the
terminal’s brutal reality.

One package: `@inhuman.tools/quickdraw`. Grain stages (`src/{measure,lexicon,…}`) are folders, not
npm names.

| | |
|---|---|
| **Product** | The harness (`../harness/`). Not this renderer. |
| **This tree** | Measure, layout, theme, caps, input, damage buffer, host present, paint widgets. |
| **License** | [MIT](./LICENSE.md) |

## Product home

Quickdraw lives **inside the harness product root** (`../` — process packages in
`../harness/`). Dual-mode is at the product root:

```bash
cd ..   # harness product root
pnpm build
pnpm test
pnpm typecheck
pnpm test:umbrella          # pnpm --filter @inhuman.tools/quickdraw test
pnpm check:color-parity
```

From this package:

```bash
pnpm --filter @inhuman.tools/quickdraw storybook   # interactive catalog
pnpm --filter @inhuman.tools/quickdraw visual      # mac terminal goldens (not CI)
```

## Tiers

**Load-bearing core**

- Cell buffer + dirty rows + ANSI emit + content guard
- Layout tree → `Frame` → paint / hit / selection
- Role & prominence theme (ground-aware, depth ladder)
- TTY capability probe
- One pure input decoder
- Optional host present (mailboxes, TTY enter/exit order)

**Paint widgets**

- Streaming markdown, syntax highlight, structured diff
- Thinking stream / composer chrome

**Optional canary — not product chrome**

- `src/internals/bgfx` + storybook `fx`: procedural cell wash to prove present-path
  headroom under load. Cool if it runs; interactive paint still owns the loop.
  Don’t build features on shaders.

```bash
pnpm --filter @inhuman.tools/quickdraw fx
```

## Package (`@inhuman.tools/quickdraw`)

One package. Grain stages live in `src/` folders. Out-of-package code imports
named subpaths below — never `src/` or `dist/` filesystem paths.

| Export | Role |
|--------|------|
| `.` | `startRender` (UI thread; handle: `silenceInput` / `drainInput` / `stop` / `restore`) |
| `./input` | Draft and key decode |
| `./measure` | Display-column width |
| `./runtime` | Worker paint seam, mailbox, raster, thought birth and collapsed |
| `./widgets` | Light constructors (`Markdown`, `Diff`, `ComposerFrame`, …) |
| `./widgets/*` | Granular constructors |
| `./buffer` | Cell grid, dirty rows, ANSI emit |
| `./lexicon` | Roles, prominence, quarantine brands |
| `./layout` | Flex/grid tree → Frame, paint / hit / selection |
| `./theme` | Ground-aware color solve |
| `./capabilities` | TTY probe result |
| `./internals/bgfx` | Present-path canary (not product chrome) |
| `./internals/bgfx-worker` | Worker entry only |

The catalog (`src/storybook`) and the present-path bench (`src/bench`) live in this package. Terminal screenshot driving lives in [`../harness-tui/src/e2e`](../harness-tui/src/e2e).

```bash
pnpm --filter @inhuman.tools/quickdraw storybook
pnpm --filter @inhuman.tools/quickdraw fx
pnpm --filter @inhuman.tools/quickdraw visual
pnpm --filter @inhuman.tools/quickdraw bench
pnpm --filter @inhuman.tools/quickdraw test
```

**Boundary:** substrate + paint widgets stay here. The agent product is
`../harness/` (`@inhuman.tools/harness-*`).

## License

[MIT](./LICENSE.md).
