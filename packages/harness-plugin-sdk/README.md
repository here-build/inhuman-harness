# `@inhuman.tools/plugin-sdk`

Build validated JavaScript tools, actions, bots, and bundled MCP definitions for programmatic host integrations. Use Node.js 22 or newer, matching the CLI and repository baseline.

For an installable plugin that works with the current CLI, start with the [hello plugin](https://github.com/here-build/inhuman-harness/blob/HEAD/examples/hello-plugin/README.md). The daemon loads Scheme tools through `extensions["tools.inhuman"].abi`; it currently does **not** import JavaScript modules advertised through `plugins[].importPath`. Installing a package containing an `InhumanPlugin` export alone will not register its tools.

## First SDK tool

In a new directory, install the SDK:

```sh
npm init -y
npm install @inhuman.tools/plugin-sdk
```

Save this as `hello.mjs` (the `.mjs` extension enables ES modules):

```js
import { InhumanPlugin, InhumanTool, z } from "@inhuman.tools/plugin-sdk";

const hello = new InhumanTool({
  name: "hello",
  description: "Return a friendly greeting",
  class: "read",
  representation: "both",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  run: ({ name }) => ({ greeting: `Hello, ${name}!` }),
});

export default new InhumanPlugin({ tools: [hello] });

console.log(await hello.execute({ name: "Ada" }, { root: process.cwd() }));
```

Run `node hello.mjs`. It prints `{ greeting: 'Hello, Ada!' }`. This calls the tool directly; no daemon, model connection, or API key is needed. `execute` validates both input and output. Read/write tools require `ctx.root`; the host supplies that context during normal execution.

`representation: "both"` requests a model tool and a Scheme symbol. Function tools default to `"symbol"`; use `"tool"` for model exposure only. Defining a tool does not install it into a running host.

## Continuation policy

Tools declare whether their result requests another model round:

```js
continuation: { kind: "observation" } // Default: let the model consume the result.
continuation: { kind: "auxiliary", note: "Continue the user's task." }
continuation: { kind: "none" }
```

Auxiliary calls request bounded repair only when the completion has neither a spoken answer nor observation work. Their optional notes are deduplicated on the follow-up. Successful auxiliary calls do not reset repair budgets. `none` makes no continuation request; other tools, incoming input, or session obligations can still request a round.

The host freezes the policy on each admitted invocation. Continuation does not grant tool access or change approval or transcript visibility. `triggersReactLoop` is a deprecated compatibility input: `false` maps to `none`, and an explicit `continuation` takes precedence.

Scheme declarations use `:continuation 'auxiliary :continuation-note "Continue the user's task."`; the other modes are `'observation` and `'none`.

## Installing and loading a CLI plugin

The [hello example](https://github.com/here-build/inhuman-harness/blob/HEAD/examples/hello-plugin/README.md) includes the complete `package.json`, `plugin.json`, and Scheme tool source, with install and invocation commands. `inhuman install` installs a package into the selected kernel and enables its `plugin.json` name. The manifest points the current host at its supported behavior surface. See [exemplar packs](https://github.com/here-build/inhuman-harness/blob/HEAD/plugins/README.md) for bots, scoped state, and MCP integrations.

## Public surface

Bot `instructions` is `SystemPrompt` from `@inhuman.tools/harness-commons` — `` prompt.system`…` ``. User-turn text is `UserPrompt`.

```ts
import { prompt } from "@inhuman.tools/harness-commons";
import {
  InhumanAction,
  InhumanPlugin,
  InhumanTool,
  normalizeDefinitions,
  resolveReferences,
  validateSupportedVersion,
  z,
  type BotDefinition,
  type McpServerDefinition,
  type PluginCallContext,
  type ToolDefinition,
} from "@inhuman.tools/plugin-sdk";

const search = new InhumanTool({
  type: "function",
  name: "example_search",
  class: "read",
  input: z.object({ q: z.string() }),
  output: z.object({ ok: z.boolean() }),
  async run(input, ctx) {
    return { ok: true };
  },
});

const recall = new InhumanTool({
  type: "bot-call",
  name: "tingle",
  target: "scout",
  input: z.object({ prompt: z.string() }),
  output: z.object({ kind: z.literal("miss") }),
  prepare: (input, ctx) => ({ prompt: input.prompt }),
  background: true,
  lifetime: "turn",
  show: "turn",
  deadlineMs: 5_000,
  supportsNotify: false,
});

export default new InhumanPlugin({
  apiVersion: 1,
  tools: [search, recall],
  bots: [{ name: "scout", recipeScope: "session", instructions: prompt.system`Find relevant facts.` }],
  actions: [new InhumanAction({ name: "simplify", run: async () => ({ ok: true }) })],
});
```

## Tool kinds

| `type` | Body | Host admit path |
|--------|------|-----------------|
| `"function"` (default when `run` only) | `run(input, ctx)` | `tool.execute(raw, ctx)` |
| `"bot-call"` | `prepare(input, ctx)` optional; `target` names a local bot | licensed AgentCall; no public `call__…` wrapper |

## Plugin bag fields

| Field | Role |
|-------|------|
| `tools` | catalog verbs (`function` or `bot-call`) |
| `bots` | named workers compiled into internal recipes |
| `mcpServers` | bundled stdio MCP; `visibility: "private"` \| `"public"` |
| `exclusiveSlots` | mutual exclusion (e.g. one foreground memory provider) |
| `actions` | named JSON-RPC actions |
| `envCapabilities` | rare Arrival env extensions |
| `projection` | reducer + loop-end hooks over trajectory metadata |

Tool flags (not `class`):

| Flag | Default | Role |
|------|---------|------|
| `triggersReactLoop` | `true` | `false` = not work (same-round, not a ReACT continuer). Only host side-channel names skip the license |
| `tapeHidden` | `false` | off the tape. Separate bit. |
| `question` / `effect` / `caption` | — | Mustache tape faces. Kernel projects them onto `PluginSpec`. Empty = uncovered. |
| `exam` | — | admit as a frozen ProgrammaticJob; host seals `admit`, then `settle` on close |

`ctx.storage` is the prefix projection for this plugin. `propose(action)` writes metadata onto **this** job. The next state is the computed projection, not a field.

## Callbacks (named points only)

- `run` — native function tool body
- `prepare` — bot-call input derivation with graph context (`turn`, `completion`, `invocation`)
- `transport.env` — bundled MCP child environment

Rejected: routing closures (`writer.tool()`), object-identity targets, treating `show: "omit"` as a marker hint.

## Load boundary

Constructors and plain records normalize identically:

```text
validateSupportedVersion → normalizeDefinitions → resolveReferences → install
```

Also: `defineTool` / `defineAction`, brand guards, re-export of `z`. `envCapabilities` is optional (`@here.build/arrival` peer).

The current daemon reads the `extensions["tools.inhuman"]` manifest surface, including Scheme `abi` programs. It does not automatically import SDK modules from `plugins[].importPath`. This package does not import the host or harness-sdk at runtime.
