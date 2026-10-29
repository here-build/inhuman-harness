# Terminal screenshot driver

**Mac-only** real-app screenshots (Terminal.app, iTerm2, kitty, WezTerm,
Ghostty) via `osascript` + `execa`, window capture with `screencapture`,
compare via **pixelmatch**. Lives in `@inhuman.tools/harness-tui` at `src/e2e`.

**Not a CI gate.** Unit tests ride the harness `logic` project. `terminals`
needs a Mac and installed apps. The in-process TUI golden gate stays
`test:visual`.

```bash
UPDATE_SCREENSHOTS=1 pnpm --filter @inhuman.tools/harness-tui terminals
```

## Flow

```
test ──open──► terminal ──► scenario (ANSI paint)
  │◄── TCP control: ready
  ├── screencapture -R bounds
  ├── step over control channel → repaint
  └── pixelmatch vs __screenshots__/<terminal>/<slug>.png
```

The driver runs in a **child process** so CSI cannot corrupt the vitest reporter.
The product build does not emit this tree; the child loads `cli.ts` through `tsx`.

```ts
const { shots } = await runTerminalScenarioDetached({
  terminal: terminal.id,
  command: `node --import tsx src/e2e/fixtures/my-demo.ts --control {{control}}`,
  steps: [{ name: "01-initial" }, { name: "02-update", step: "update" }],
});
expect(shot.png).toMatchTerminalGolden({ suite, terminal: terminal.id, name });
```

## Scenario contract

1. Connect `--control host:port`
2. Paint initial frame to stdout
3. Emit `{ "type": "ready" }` newline JSON
4. Handle `{ "type": "step", "name" }` → repaint → ready
5. Handle `{ "type": "quit" }` → clean teardown → exit 0
