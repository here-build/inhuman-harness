#!/usr/bin/env node
/**
 * Private workspace memory MCP stdio server (child process only).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  citedPackSchema,
  commitInputSchema,
  coreRowSchema,
  episodeRowSchema,
  findInputSchema,
  getCoreInputSchema,
  memoryCommitRowSchema,
  readCommitInputSchema,
  readInputSchema,
} from "./schemas/memory.js";
import { MemoryStore } from "./store.js";
import { assertWorkspaceDirectory } from "./workspace.js";

function workspaceFromEnv(): string {
  const raw = process.env.MEMORY_WORKSPACE?.trim() ?? "";
  if (raw === "") throw new Error("MEMORY_WORKSPACE is required");
  assertWorkspaceDirectory(raw);
  return raw;
}

function jsonText(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export async function startMemoryMcpServer(workspacePath = workspaceFromEnv()): Promise<MemoryStore> {
  const store = new MemoryStore(workspacePath);
  const server = new Server({ name: "offload-tingle-memory", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "find",
        description: "Lexical search over retained facts.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query", "limit"],
        },
      },
      {
        name: "read",
        description: "Read a retained episode by id.",
        inputSchema: {
          type: "object",
          properties: { episodeId: { type: "string" } },
          required: ["episodeId"],
        },
      },
      {
        name: "commit",
        description: "Commit retention candidate for a request id.",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string" },
            inputDigest: { type: "string" },
            candidate: { type: "object" },
          },
          required: ["requestId", "inputDigest", "candidate"],
        },
      },
      {
        name: "read_commit",
        description: "Read commit evidence for a request id.",
        inputSchema: {
          type: "object",
          properties: { requestId: { type: "string" } },
          required: ["requestId"],
        },
      },
      {
        name: "get_core",
        description: "Read session core at current revision.",
        inputSchema: {
          type: "object",
          properties: { scopeSessionId: { type: "string" } },
          required: ["scopeSessionId"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case "find": {
          const input = findInputSchema.parse(args);
          const lookup = store.find.bind(store);
          return jsonText(citedPackSchema.parse(lookup(input.query, input.limit)));
        }
        case "read": {
          const input = readInputSchema.parse(args);
          const episode = store.readEpisode(input.episodeId);
          return jsonText(episode == null ? null : episodeRowSchema.parse(episode));
        }
        case "commit": {
          const input = commitInputSchema.parse(args);
          const revision = input.contributionRevision?.trim() || process.env.MEMORY_CONTRIBUTION_REVISION?.trim() || "";
          if (revision === "") throw new Error("contributionRevision is required");
          const row = store.commit(input.requestId, input.inputDigest, revision, input.candidate);
          return jsonText(memoryCommitRowSchema.parse(row));
        }
        case "read_commit": {
          const input = readCommitInputSchema.parse(args);
          const row = store.readCommit(input.requestId);
          return jsonText(row == null ? null : memoryCommitRowSchema.parse(row));
        }
        case "get_core": {
          const input = getCoreInputSchema.parse(args);
          const row = store.getCore(input.scopeSessionId);
          return jsonText(row == null ? null : coreRowSchema.parse(row));
        }
        default:
          throw new Error(`unknown tool ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
    }
  });

  process.stdin.on("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
  return store;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMemoryMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
