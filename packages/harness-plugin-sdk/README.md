# `@inhuman.tools/plugin-sdk`

Tools, actions, bots, and bundled MCP. Not the host, not `plugin.json`.

## Public surface

Bot `instructions` is `SystemPrompt` from `@inhuman.tools/harness-commons` — `` prompt.system`…` ``. User-turn text is `UserPrompt`.

```ts
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
  bots: [{ name: "scout", scope: "invocation", instructions: "…" }],
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

The daemon parses `extensions.tools.inhuman` and `import`s this module. This package does not import harness-server or harness-sdk at runtime.
