# Package map

Start with `inhuman` to run the product. Choose an SDK or standalone library
when embedding part of it. A package being public in its manifest does not
promise a stable API or independent support; check its README, exports, and
requirements before depending on it. “Private” below means the manifest excludes
it from npm publishing.

## Flagship

| Package | Source | Purpose |
| --- | --- | --- |
| `inhuman` | [CLI](../packages/inhuman) | Terminal and web clients, daemon lifecycle, remote access, MCP and plugin commands |

The [root README](../README.md) covers installation and first use.

## Extension and integration entry points

| Package | Source | Use it for |
| --- | --- | --- |
| `@inhuman.tools/plugin-sdk` | [Plugin SDK](../packages/harness-plugin-sdk) | Plugin tools, actions, and optional environment capabilities |
| `@inhuman.tools/harness-provider-sdk` | [Provider SDK](../packages/harness-provider-sdk) | Model-provider registration and capability contracts |
| `@inhuman.tools/harness-sdk` | [Node SDK](../packages/harness-sdk) | Connect to the daemon over a Unix socket and use launch helpers |
| `@inhuman.tools/harness-client` | [Typed client](../packages/harness-client) | Use the daemon contract with a supplied transport |
| `@inhuman.tools/harness-peer` | [Sync peer](../packages/harness-peer) | Browser-safe document sync, awareness, and JSON-RPC transport |
| `@inhuman.tools/harness-contract` | [RPC contract](../packages/harness-contract) | Wire schemas and generated [OpenRPC/OpenAPI specifications](../packages/harness-contract/spec/README.md) |
| `@inhuman.tools/arrival-manifold` | [MCP manifold](../extras/arrival-manifold) | Present multiple MCP servers through a Scheme REPL tool; released separately |
| `@inhuman.tools/tool-call-normalize` | [Normalizer](../packages/tool-call-normalize) | Normalize streamed and batch model tool-call dialects |

The [policy packages](../packages-policy) include the public policy engine,
`policy-bash-disassembler`, and `policy-tirith`. Their other-agent adapters
(`policy-aider`, `policy-continue`, `policy-crush`, `policy-openclaw`,
`policy-opencode`, `policy-pi`, and Jev/Sage variants) are currently private
source packages. Some are wrappers rather than native host plugins; read the
specific adapter README before using one.

The public `@inhuman.tools/statusline`, `@inhuman.tools/activity`, and
`@inhuman.tools/continuation` libraries live in
[packages-statusline](../packages-statusline),
[packages-activity](../packages-activity), and
[packages-continuation](../packages-continuation). Their pi/OpenCode adapter
packages are currently private.

[plugins](../plugins) contains `@inhuman.tools/plugin-tasks` (public), plus
private CUA, fusion, goal, and offload-tingle plugins. These are source examples
of integrations as well as product features; private packages are not npm
installation entry points.

## Implementation packages

These packages compose the product or support its runtime. Public manifests
allow publishing dependencies needed by `inhuman`; choose them directly only
when their documented interface fits your use case.

| Source | Packages and responsibilities |
| --- | --- |
| [harness](../packages/harness) | `@inhuman.tools/harness`: daemon, runtime, providers, and sync composition |
| [harness-tui](../packages/harness-tui), [harness-web-app](../packages/harness-web-app) | Terminal client and browser client with loopback web server |
| [quickdraw](../packages/quickdraw) | Internal terminal rendering framework: paint, layout, input, and widgets |
| [pretty-mcp](../packages/pretty-mcp) | Human-readable MCP and toolkit call summaries used by the clients |
| [harness-transcript](../packages/harness-transcript) | Browser transcript components; private, bundled into the web client |
| [harness-model](../packages/harness-model), [harness-commons](../packages/harness-commons) | Document models and schemas, shared prompt brands and disposal guard |
| [harness-scheme](../packages/harness-scheme) | Session Scheme runtime; only its documented browser entry points are browser-safe |
| [packages-runtime](../packages-runtime) | `turn`, `substrate`, `scheme-program`, `scheme-watch`: turn processing, REPL teaching/replay, and program/watch tools |
| [plexus-expectations](../packages/plexus-expectations) | Work expectations, jobs, and executor |
| [harness-diagnostics](../packages/harness-diagnostics) | Process logging and debug gates |
| [project-instructions](../packages/project-instructions), [project-skills](../packages/project-skills) | Discover instruction files and skill drawers |
| [env-capabilities](../env-capabilities), [env-capability-module-prompt](../packages/env-capability-module-prompt) | Dotprompt, reactivity, and prompt-module capabilities; decision Jev/Sage/structured adapters are private |
| [chunked-websocket](../packages/chunked-websocket), [error-with-invariant](../packages/error-with-invariant) | WebSocket chunk transport and invariant error helper |
| [qd platform packages](../packages) | `@inhuman.tools/qd-{darwin,linux}-{arm64,x64}`: prebuilt native renderer binaries produced by release CI |
| [harness-relay](../packages/harness-relay) | Private Cloudflare remote-access relay |
| [scope-plane](../packages/scope-plane), [scope-plane-electric](../packages/scope-plane-electric), [scope-plane-tinybase](../packages/scope-plane-tinybase) | Private scope-tree model and storage adapters |
| [internal](../internal) | Private ESLint and TypeScript configuration packages |

For source setup and checks, see [CONTRIBUTING.md](../CONTRIBUTING.md). For the
standard to apply when exposing a package to consumers, see
[package guidelines](package-guidelines.md).
