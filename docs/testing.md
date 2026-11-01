# Test lanes

Run the workspace wrappers from the repository root. They build the workspace dependency graph before testing public package entries; running a package's Vitest command against stale `dist` can test a different implementation from the source open in the editor.

| Command | Scope |
| --- | --- |
| `pnpm test` | Default logic gate, including owned local HTTP contracts and wire compatibility fixtures |
| `pnpm test:process` | Serialized subprocess smoke tests: daemon loading, hypervisor and lifetime locks, real stdio MCP, CLI loader/reconnect lifecycle, Git-backed prompt-prefix compatibility |
| `pnpm test:visual` | Terminal structural frame approvals and browser computed appearance/focus approvals |
| `pnpm verify:logic` | Packaging boundaries, build, types, lint, and default logic |
| `pnpm verify` | All verification lanes |

Logic and visual projects use separate directory whitelists. Place appearance approvals in `__visual__`; put tests that launch child processes in a sibling `__process__` directory so relative imports keep their depth. Pure tape grouping decisions live in `__tests__`. Paint transport byte fixtures remain logic because they lock the protocol consumed by the replica.

Visual CI runs when the TUI, web client, transcript, paint substrate, model or SDK changes. A manual workflow dispatch can request it explicitly. It builds qd only in the visual job. Process smoke runs in its own job without the renderer.

Browser approvals use actual Chromium, the real application/components and compiled CSS. Set `CHROME_BIN` if Chrome/Chromium is not in a conventional macOS or Linux location. The fixture checks real focus, `:focus-visible`, and computed outlines, then compares computed appearance with checked-in structural snapshots. These frames cover typography, colors, borders and focus state; they do not replace screenshot review of layout and clipping. CI fails on missing or changed snapshots. Refresh intentionally with `pnpm --filter @inhuman.tools/harness-web-app exec vitest run --project visual --update` after reviewing the change.

Terminal approvals compare structural frames (bands, roles, content, draft, annotation and picker state). `RECORD_PRESENT=1` additionally writes the qd journey for visual review; recording never substitutes for snapshot comparison. The two existing expected failures for thought-clock presentation and the slash-click TODO remain visible in the present-visual suite.

Duplicate tests are seated with their implementation: diagnostics owns DEBUG gating; extensions owns persistent plugin state; Nous owns borrowed bootstrap and device-code OAuth. Public peer browser safety is checked by bundling the built public entry, rather than parsing import text. The UI barrel export inventory and same-prop forwarding tests were retired; interaction and accessibility tests import the public controls as consumers do.
