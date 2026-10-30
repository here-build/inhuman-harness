# inhuman harness

A local agent harness. A background daemon keeps every session as a document on
your machine; a browser or terminal client attaches to it, and you can close the
client without stopping the work. Models, MCP servers and plugins connect to the
daemon, and a permission policy decides which tool calls run on their own and
which wait for you.

## Quick start

Requirements: Node.js 22 or newer, macOS or Linux.

```sh
npx inhuman web
```

What happens:

1. If the daemon is not running, it starts in the background.
2. A small local web server starts next to it, also in the background, on
   `http://127.0.0.1:8787/` (or a free port when 8787 is taken).
3. The URL is printed and your browser opens on it.
4. The command exits. Daemon and web server keep running.

Run `npx inhuman web` again at any time: it finds the running daemon and web
server and opens the same URL. `npx inhuman start` does the same without
opening a browser. `npx inhuman` with no arguments attaches the terminal client.

### First session

1. Open **Settings → Connections** and connect a model provider: a ChatGPT
   subscription, OpenRouter, Grok, or any OpenAI-compatible endpoint. Finish the
   provider's sign-in or paste an API key.
2. Pick a model in the composer's model picker.
3. Optional: add MCP servers (`npx inhuman mcp ...`) and plugins
   (`npx inhuman install <package>`).

### Permissions

Each session runs in one of three modes, switchable from the client:

| Mode | Behaviour |
|------|-----------|
| `manual` | Every tool call that is not on the allow list asks you first |
| `auto` | A policy and a judge model approve routine calls; risky ones ask |
| `yolo` (shown as "always approve") | Everything runs, except calls the policy blocks outright |

### Everyday commands

```sh
npx inhuman                       # terminal client
npx inhuman start                 # daemon and web server in the background, print the URL
npx inhuman web                   # same, then open the browser
npx inhuman web --no-browser      # print the URL only
npx inhuman web --port 9000       # preferred web port
npx inhuman login                 # start the above if needed, then sign in for remote access
npx inhuman logout
npx inhuman remote status
npx inhuman daemon stop           # stop the daemon; the web server exits by itself
npx inhuman daemon restart
npx inhuman eval -e '(+ 1 2)'     # run a program once and print the result
npx inhuman mcp ...               # manage MCP servers
npx inhuman install <package>     # install a plugin into the kernel
npx inhuman --help
```

State lives in the kernel directory, `~/.harness` by default. Pass
`--kernel PATH` to any command to use another one. The web server records itself
in `<kernel>/web.json` and logs to `<kernel>/web.log`.

## Remote access

```sh
npx inhuman login
```

Sign in with your WorkOS account in the browser window that opens, then visit
<https://harness.inhuman.tools>, pick your machine and use the regular web app
against this machine's daemon from anywhere.

How it works: the daemon dials out to a Cloudflare relay, so no inbound port is
opened. The relay keeps documents in memory only, as a speed-up; your machine
stays the source of truth. Idle connections cost nothing.

Security: this is an experimental sandbox. Anyone signed in as you can drive
this machine's harness, including tools that run commands. Access is limited to
an email allowlist. `npx inhuman logout` turns it off, and
`npx inhuman remote status` shows the current state. See
[docs/proposals/remote-access.md](docs/proposals/remote-access.md).

## How it fits together

```
 browser ──http/ws──▶ web server ──unix socket──▶ daemon ──▶ model providers
 (127.0.0.1)          (inhuman web-door)          (kernel)    MCP servers, tools, plugins
                                                     ▲
 terminal client ─────────────unix socket───────────┘
```

- The **daemon** owns the kernel directory and one live document per session.
  Turns, tool calls, approvals and their outcomes are entries in that document.
- **Clients** (web or terminal) sync the document and send named actions over
  JSON-RPC. The contract is described in
  [`packages/harness-contract/spec/README.md`](packages/harness-contract/spec/README.md).
- The **web server** only listens on loopback and forwards to the daemon's
  socket.

## Develop from source

Requirements: Node.js 22+, pnpm 10.33 (`corepack enable` provides it), and a
Rust toolchain for the terminal renderer (`qd`).

```sh
git clone https://github.com/here-build/inhuman-harness.git
cd inhuman-harness
corepack enable
pnpm install --frozen-lockfile
pnpm build
cargo build --release --manifest-path packages/quickdraw/rust/qd/Cargo.toml
pnpm --filter inhuman dev                         # terminal client
node packages/inhuman/bin/inhuman.mjs web         # web client, as npx inhuman web
```

The full local gate, as CI runs it:

```sh
pnpm verify
```

It covers package boundaries, build, typecheck, lint, unit tests, process tests
and terminal visual tests.

### Packages

| Path | Package | Role |
|------|---------|------|
| [`packages/inhuman`](packages/inhuman) | `inhuman` | The `inhuman` command (`npx inhuman`): terminal client, `start`, `web`, `login`, `daemon`, `eval`, `mcp`, `install`, completion |
| [`packages/harness`](packages/harness) | `@inhuman.tools/harness` | Core: the daemon (kernel and session planes), runtime, providers, Yjs sync. Ships `compact.scm`, `compact.prompt`, `src/server/defaults` |
| [`packages/harness-tui`](packages/harness-tui) | `@inhuman.tools/harness-tui` | Terminal client: interpreter, frames, visual tests |
| [`packages/harness-web-app`](packages/harness-web-app) | `@inhuman.tools/harness-web-app` | Browser client and its loopback server (`./server`) |
| [`packages/harness-transcript`](packages/harness-transcript) | `@inhuman.tools/harness-transcript` | The session transcript, rendered by the browser client |
| [`packages/harness-sdk`](packages/harness-sdk) | `@inhuman.tools/harness-sdk` | Node client over the unix socket, daemon paths, launch helpers |
| [`packages/harness-peer`](packages/harness-peer) | `@inhuman.tools/harness-peer` | Browser-safe sync: Yjs rooms, frames, awareness, JSON-RPC port |
| [`packages/harness-scheme`](packages/harness-scheme) | `@inhuman.tools/harness-scheme` | Scheme runtime for `scheme_repl` and commands |
| [`packages/harness-model`](packages/harness-model) | `@inhuman.tools/harness-model` | Kernel, project and session documents and their schemas |
| [`packages/harness-contract`](packages/harness-contract) | `@inhuman.tools/harness-contract` | The daemon's RPC contract (zod schemas, oRPC router) and its generated OpenRPC/OpenAPI spec |
| [`packages/harness-provider-sdk`](packages/harness-provider-sdk) | `@inhuman.tools/harness-provider-sdk` | Model-provider registration and capability contracts |
| [`packages/harness-plugin-sdk`](packages/harness-plugin-sdk) | `@inhuman.tools/plugin-sdk` | Plugin SDK |
| [`packages/harness-diagnostics`](packages/harness-diagnostics) | `@inhuman.tools/harness-diagnostics` | Debug gate and process log |
| [`packages/plexus-expectations`](packages/plexus-expectations) | `@inhuman.tools/plexus-expectations` | Work-and-outcome substrate the runtime is built on |
| [`packages/tool-call-normalize`](packages/tool-call-normalize) | `@inhuman.tools/tool-call-normalize` | Model-native tool-call dialects to OpenAI/Anthropic shapes |
| [`packages/pretty-mcp`](packages/pretty-mcp) | `@inhuman.tools/pretty-mcp` | Human-readable summaries of MCP and toolkit calls |
| [`packages/quickdraw`](packages/quickdraw) | `@inhuman.tools/quickdraw` | Terminal paint package and the `qd` Rust renderer |
| [`packages-runtime/turn`](packages-runtime/turn) | `@inhuman.tools/turn` | Turn loop: context, tool catalog, call admission, policy processor |
| [`packages-runtime/substrate`](packages-runtime/substrate) | `@inhuman.tools/substrate` | Scheme REPL doors, session replay |
| [`packages-policy/policy`](packages-policy/policy) | `@inhuman.tools/policy` | Permission policy: floor rules, path and bash classification |
| [`packages-policy/*-auto-mode`](packages-policy) | `@inhuman.tools/policy-*` | The same auto mode for other coding agents: aider, Continue, Crush, OpenClaw, OpenCode, pi |
| [`packages-statusline`](packages-statusline), [`packages-activity`](packages-activity), [`packages-continuation`](packages-continuation) | `@inhuman.tools/statusline`, `activity`, `continuation` | Git statusline, session titles, and the continue-vote, with adapters for other agents |
| [`extras/arrival-manifold`](extras/arrival-manifold) | `@inhuman.tools/arrival-manifold` | Collapse many MCP servers into one Scheme REPL tool |
| [`packages/harness-relay`](packages/harness-relay) | `@inhuman.tools/harness-relay` | The Cloudflare Worker behind harness.inhuman.tools (private, deployed from `main`) |
| [`packages/qd-*`](packages) | `@inhuman.tools/qd-<os>-<arch>` | Prebuilt `qd` binaries, one package per platform, built by CI at release |
| [`plugins/`](plugins/) | `@inhuman.tools/plugin-*` | Shipped plugins |
| [`internal/`](internal/) | `@-internal-/*` | Shared eslint and tsconfig presets (not published) |

### Releasing

Publishing is done by the **Release** GitHub Actions workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)). It builds the
four `qd` binaries, runs `pnpm release:check` (everything `inhuman` needs at
runtime must be public) and runs `pnpm -r publish`, which skips versions already
on npm.

1. Bump the `version` of every package that changed (and anything that depends
   on it, `inhuman` included).
2. Publishing uses npm trusted publishing (OIDC), no token. Each package needs
   a trusted publisher on npmjs.com: repository `here-build/inhuman-harness`,
   workflow `release.yml`. npm only accepts that for a package that already
   exists, so a brand-new package gets one manual placeholder publish first.
3. Run the Release workflow from the Actions tab with `dry_run` on, check the
   package list, then run it again with `dry_run` off.

## Security

The web server binds to `127.0.0.1` only. Report vulnerabilities to
[security@here.build](mailto:security@here.build); see [SECURITY.md](SECURITY.md).

## License

[MIT](./LICENSE.md) — Copyright 2026 Merkle Bonsai.
