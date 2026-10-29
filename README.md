# @inhuman.tools/harness

An agent harness. A daemon (kernel and session planes) holds sessions as
documents. Any client shell meets the daemon on the session document over
`@inhuman.tools/harness-peer` (browser) or `@inhuman.tools/harness-sdk`
(Node). The terminal UI in `packages/harness-tui` is one such client shell: it
evaluates named actions and paints open work.

The repository also contains the packages the harness is built from: the
RPC contract, the session transcript, the Scheme runtime, the plugin SDK, the
turn and policy runtime, and the `quickdraw` terminal paint package. The RPC
contract is documented in
[`packages/harness-contract/spec/README.md`](packages/harness-contract/spec/README.md).

## Install and first run

This checkout is self-contained. It does not require sibling arrival, plexus,
commons, or foundation repositories.

Requirements: Node.js 22 or newer and pnpm 10.33 (`corepack enable` will make
the pinned pnpm version available). From this directory:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @inhuman.tools/harness-cli dev
```

The first useful session needs one completion connection and a model. In the
TUI, use `/connect` to adopt a built-in provider (ChatGPT subscription,
OpenRouter, Grok, or an OpenAI-compatible endpoint), complete that provider's
sign-in or API-key step, then use `/model` to choose one of its advertised
models. MCP servers, plugins, and an explicit model override are optional.
The default kernel lives at `~/.harness`; pass `--kernel PATH` when a separate
kernel directory is needed.

Before calling a checkout releasable, run the complete local gate:

```sh
pnpm verify
```

It covers build, typecheck, lint, logic tests, process tests, and TUI visual tests.

## Packages

| Path | Package | Role |
|------|---------|------|
| [`packages/harness`](packages/harness) | `@inhuman.tools/harness` | Core: the daemon (kernel + session planes), runtime, providers, Yjs sync plane. Bins `harness-daemon`, `harness-yjs-server`. Ships `compact.scm`, `compact.prompt`, `src/server/defaults` |
| [`packages/harness-cli`](packages/harness-cli) | `@inhuman.tools/harness-cli` | The `harness` command: `ensure()` the daemon, then attach a shell; `daemon`, `eval`, `mcp`, `install`, completion. The TUI and the web app are optional peers loaded on demand |
| [`packages/harness-tui`](packages/harness-tui) | `@inhuman.tools/harness-tui` | Terminal shell (`attachTui`): interpreter, frames. Mac real-terminal screenshot driver in `src/e2e` (not a CI gate) |
| [`packages/harness-web-app`](packages/harness-web-app) | `@inhuman.tools/harness-web-app` | Browser shell and the loopback door (`./server`) |
| [`packages/harness-transcript`](packages/harness-transcript) | `@inhuman.tools/harness-transcript` | The session transcript (the tape), rendered by the browser shell |
| [`packages/harness-sdk`](packages/harness-sdk) | `@inhuman.tools/harness-sdk` | Node client: `Client` over the unix socket, daemon paths, launch helpers, plain-text work projections |
| [`packages/harness-peer`](packages/harness-peer) | `@inhuman.tools/harness-peer` | Browser-safe dial: Yjs rooms, frames, awareness, JSON-RPC port |
| [`packages/harness-scheme`](packages/harness-scheme) | `@inhuman.tools/harness-scheme` | Scheme runtime faces; `./keywords` and `./replay` are browser-safe |
| [`packages/harness-diagnostics`](packages/harness-diagnostics) | `@inhuman.tools/harness-diagnostics` | Debug gate and process log |
| [`packages/harness-model`](packages/harness-model) | `@inhuman.tools/harness-model` | Plexus documents (KernelPlexus, ProjectPlexus, SessionPlexus) and model schemas. No client transport |
| [`packages/harness-contract`](packages/harness-contract) | `@inhuman.tools/harness-contract` | The daemon's RPC contract: zod schemas and the oRPC router |
| [`packages/harness-provider-sdk`](packages/harness-provider-sdk) | `@inhuman.tools/harness-provider-sdk` | Driver-provider registration and capability contracts on top of PEW |
| [`packages/harness-plugin-sdk`](packages/harness-plugin-sdk) | `@inhuman.tools/plugin-sdk` | InhumanPlugin barrel |
| [`packages/tool-call-normalize`](packages/tool-call-normalize) | `@inhuman.tools/tool-call-normalize` | Model-native tool dialects → OpenAI/Anthropic |
| [`packages-runtime/turn`](packages-runtime/turn) | `@inhuman.tools/turn` | Generation-holder laws: session commands, context, catalog, call acceptance, tool admit, policy processor. Shipped remainder assets in `policy/` |
| [`packages/plexus-expectations`](packages/plexus-expectations) | `@inhuman.tools/plexus-expectations` | PEW substrate (PEW/Expectation, claim-owner executor) |
| [`packages-runtime/substrate`](packages-runtime/substrate) | `@inhuman.tools/substrate` | Doors, session replay, futility — Scheme REPL teaching apparatus |
| [`extras/arrival-manifold`](extras/arrival-manifold) | `@inhuman.tools/arrival-manifold` | Collapse N MCP servers into one Scheme REPL tool |
| [`packages/pretty-mcp`](packages/pretty-mcp) | `@inhuman.tools/pretty-mcp` | Human-readable identity for MCP / toolkit calls; retrieve calibration |
| [`packages/quickdraw`](packages/quickdraw) | `@inhuman.tools/quickdraw` | Paint package (`.` / `./input` / `./measure` / `./runtime` / `./widgets`). Catalog and present-path bench live in `src/storybook` and `src/bench` |
| [`plugins/`](plugins/) | `@inhuman.tools/plugin-*` | Shipped packs + sketches |
| [`internal/`](internal/) | `@-internal-/*` | Private config quasi-packages (eslint, tsconfig). Not product |

## License

[MIT](./LICENSE.md) — Copyright 2026 Merkle Bonsai.
