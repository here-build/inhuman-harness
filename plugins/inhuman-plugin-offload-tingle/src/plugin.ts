/**
 * Optional SQLite adapter. The pack behavior is behavior/*.scm. plugin.json
 * declares the private `memory` server and does not load this module.
 * Mounting this default still claims foreground-memory-provider for a host
 * that imports the adapter by hand.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import { InhumanPlugin, InhumanTool } from "@inhuman.tools/plugin-sdk";

import { readUuid, sourceFromContext } from "./prepare.js";
import { offloadInputSchema, recallResultSchema, retentionResultSchema, tingleInputSchema } from "./schemas/memory.js";

const writerInstructions = prompt.system`Retain bounded source excerpts via the private memory MCP tools. Submit commit evidence; do not claim retention without a commit row.`;

const scoutInstructions = prompt.system`Search retained memory with find/read only. Return a cited pack on hit or a miss disposition.`;

export default new InhumanPlugin({
  apiVersion: 1,
  exclusiveSlots: ["foreground-memory-provider"],
  mcpServers: [
    {
      name: "memory",
      visibility: "private",
      scope: "workspace",
      transport: {
        type: "stdio",
        command: "node",
        args: ["./dist/memory-mcp.js"],
        cwd: "plugin",
        env: ({ workspaceRoot }) => ({ MEMORY_WORKSPACE: workspaceRoot }),
      },
    },
  ],
  bots: [
    {
      name: "writer",
      recipeScope: "workspace",
      instructions: writerInstructions,
      mcp: [
        {
          server: "memory",
          tools: ["find", "read", "commit", "read_commit", "get_core"],
          approval: "allow",
        },
      ],
    },
    {
      name: "scout",
      recipeScope: "invocation",
      instructions: scoutInstructions,
      mcp: [{ server: "memory", tools: ["find", "read"], approval: "allow" }],
    },
  ],
  tools: [
    new InhumanTool({
      type: "bot-call",
      name: "offload",
      description: "Transfer retention of this completed unit.",
      target: "writer",
      input: offloadInputSchema,
      output: retentionResultSchema,
      prepare: (input, ctx) => ({
        version: 1,
        requestId: readUuid(ctx.invocation),
        tool: "offload",
        source: sourceFromContext(ctx, "offload", JSON.stringify(input)),
        task: input,
      }),
      background: true,
      lifetime: "call",
      show: "omit",
      supportsNotify: false,
    }) as InhumanTool,
    new InhumanTool({
      type: "bot-call",
      name: "tingle",
      description: "Return relevant retained context, if any.",
      target: "scout",
      input: tingleInputSchema,
      output: recallResultSchema,
      prepare: (input, ctx) => ({
        version: 1,
        requestId: readUuid(ctx.invocation),
        tool: "tingle",
        source: sourceFromContext(ctx, "tingle", JSON.stringify(input)),
        task: input,
      }),
      background: true,
      lifetime: "turn",
      show: "turn",
      deadlineMs: 5000,
      supportsNotify: false,
    }) as InhumanTool,
  ],
});
