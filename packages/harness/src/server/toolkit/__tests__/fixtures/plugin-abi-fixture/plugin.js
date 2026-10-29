import { InhumanPlugin, InhumanTool, z } from "@inhuman.tools/plugin-sdk";

const seen = { guidance: null, prompt: null, turn: null, completion: null, invocation: null };

export function resetFixtureSeen() {
  seen.guidance = null;
  seen.prompt = null;
  seen.turn = null;
  seen.completion = null;
  seen.invocation = null;
}

export function fixtureSeen() {
  return { ...seen };
}

export default new InhumanPlugin({
  apiVersion: 1,
  mcpServers: [
    {
      name: "memory",
      visibility: "private",
      scope: "workspace",
      transport: {
        type: "stdio",
        command: "node",
        args: ["./memory-mcp.js"],
        cwd: "plugin",
      },
    },
  ],
  bots: [
    {
      name: "worker",
      scope: "session",
      instructions: "fixture worker",
      mcp: [{ server: "memory", tools: ["find", "read"], approval: "allow" }],
    },
  ],
  tools: [
    new InhumanTool({
      name: "fixture_echo",
      description: "echo with graph context",
      class: "read",
      input: z.object({ guidance: z.string().optional() }),
      output: z.object({ ok: z.boolean(), guidance: z.string().nullable() }),
      run: (input, ctx) => {
        seen.guidance = input.guidance ?? null;
        seen.turn = ctx.turn ?? null;
        seen.completion = ctx.completion ?? null;
        seen.invocation = ctx.invocation ?? null;
        return { ok: true, guidance: input.guidance ?? null };
      },
    }),
    new InhumanTool({
      type: "bot-call",
      name: "fixture_bot_call",
      description: "fixture bot call",
      target: "worker",
      input: z.object({ prompt: z.string() }),
      output: z.object({ ok: z.boolean() }),
      prepare: (input, ctx) => {
        seen.prompt = input.prompt;
        seen.turn = ctx.turn ?? null;
        seen.completion = ctx.completion ?? null;
        seen.invocation = ctx.invocation ?? null;
        return { preparedPrompt: input.prompt };
      },
      supportsNotify: false,
    }),
    new InhumanTool({
      type: "bot-call",
      name: "fixture_offload",
      description: "fixture call-lifetime offload",
      target: "worker",
      input: z.object({ guidance: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      prepare: (input, ctx) => {
        seen.guidance = input.guidance ?? null;
        seen.turn = ctx.turn ?? null;
        seen.completion = ctx.completion ?? null;
        seen.invocation = ctx.invocation ?? null;
        return { preparedGuidance: input.guidance ?? "" };
      },
      background: true,
      lifetime: "call",
      show: "omit",
      supportsNotify: false,
    }),
    new InhumanTool({
      type: "bot-call",
      name: "fixture_silent",
      description: "generic silent bot-call (not memory marker projection)",
      target: "worker",
      input: z.object({ note: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
      prepare: (input, ctx) => {
        seen.guidance = input.note ?? null;
        seen.turn = ctx.turn ?? null;
        seen.completion = ctx.completion ?? null;
        seen.invocation = ctx.invocation ?? null;
        return { note: input.note ?? "" };
      },
      background: true,
      lifetime: "turn",
      show: "omit",
      supportsNotify: false,
    }),
    new InhumanTool({
      type: "bot-call",
      name: "fixture_tingle",
      description: "fixture turn-lifetime tingle",
      target: "worker",
      input: z.object({ prompt: z.string() }),
      output: z.object({ ok: z.boolean() }),
      prepare: (input, ctx) => {
        seen.prompt = input.prompt;
        seen.turn = ctx.turn ?? null;
        seen.completion = ctx.completion ?? null;
        seen.invocation = ctx.invocation ?? null;
        return { preparedPrompt: input.prompt };
      },
      background: true,
      lifetime: "turn",
      show: "turn",
      deadlineMs: 5_000,
      supportsNotify: false,
    }),
  ],
});
