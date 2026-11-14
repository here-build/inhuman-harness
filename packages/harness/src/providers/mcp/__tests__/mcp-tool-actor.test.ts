/**
 * MCP BODY is the connection actor. Stdio paints stderr; HTTP declines needs-auth.
 */
import { prompt } from "@inhuman.tools/harness-commons";
import {
  MCPToolJob,
  McpToolExpectation,
  SessionDocument,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import "@inhuman.tools/harness-model/register";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { McpStdioToolActor, McpToolActor } from "../actor.js";
import { McpHttpDriverConnection } from "../http-driver.js";
import { McpDriverConnection } from "../mcp-connection.js";

const TIMEOUT = 2_000;

class TestMcpConnection extends McpDriverConnection {
  protected override createToolActor(expectation: McpToolExpectation): McpToolActor {
    return new McpToolActor(expectation, this);
  }

  override async bootstrap(): Promise<void> {}
}

class StderrMcpConnection extends McpDriverConnection {
  tail = "";

  override stderrTail(): string {
    return this.tail;
  }

  protected override createToolActor(expectation: McpToolExpectation): McpStdioToolActor {
    return new McpStdioToolActor(expectation, this);
  }

  override async bootstrap(): Promise<void> {}
}

function homeCall(args: {
  readonly connectionKey: string;
  readonly serverToolName?: string;
  readonly argsJson?: string;
}): {
  readonly doc: SessionDocument;
  readonly parent: MCPToolJob;
  readonly leaf: MCPToolJob;
} {
  const doc = SessionDocument.create(`mcp-actor-${args.connectionKey}-${args.serverToolName ?? "ping"}`, "/ws");
  onTestFinished(() => doc.destroy());
  const job = new MCPToolJob({
    toolCallId: `call_${args.connectionKey}_${args.serverToolName ?? "ping"}`,
    name: `mcp__${args.connectionKey}__${args.serverToolName ?? "ping"}`,
    argsJson: args.argsJson ?? "{}",
    connectionKey: args.connectionKey,
    serverToolName: args.serverToolName ?? "ping",
    expectation: new McpToolExpectation({
      connectionId: args.connectionKey,
      serverToolName: args.serverToolName ?? "ping",
      argsJson: args.argsJson ?? "{}",
    }),
  });
  doc.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  job.humanApprove = true;
  job.orchestrationResult = true;
  return { doc, parent: job, leaf: job };
}

function mcpExpectation(job: MCPToolJob): McpToolExpectation {
  return job.expectation;
}

function ready(connection: McpDriverConnection, client: Partial<Client>): void {
  connection.readyState = "ready";
  connection.bootstrapDone = true;
  connection.client = client as Client;
}

describe("MCP tool actor", () => {
  it("exclude without tools/call; call seals receipt; stdio stderr / HTTP needs-auth", async () => {
    const excluded = homeCall({
      connectionKey: "mail",
      serverToolName: "send_message",
    });
    const excludeConn = new TestMcpConnection("mail", { tools: ["!send_*"] });
    const excludeRequests: unknown[] = [];
    ready(excludeConn, {
      // @ts-expect-error stub is not Client.request (generic SchemaOutput<T>)
      request: async (req: unknown) => {
        excludeRequests.push(req);
        return { content: [{ type: "text", text: "sent" }] };
      },
    });
    const excludedExpectation = mcpExpectation(excluded.leaf);
    excludeConn.handle(excludedExpectation);
    await when(() => excludedExpectation.isDone, { timeout: TIMEOUT });
    expect({
      requests: excludeRequests,
      dispatched: excludedExpectation.dispatched,
      outcome: excluded.parent.receiptJson,
    }).toEqual({
      requests: [],
      dispatched: false,
      outcome: JSON.stringify({
        ok: false,
        text: 'unknown MCP tool "send_message"',
      }),
    });

    const called = homeCall({
      connectionKey: "mail",
      serverToolName: "search",
      argsJson: '{"q":"hi"}',
    });
    const callConn = new TestMcpConnection("mail");
    const callRequests: unknown[] = [];
    ready(callConn, {
      // @ts-expect-error stub is not Client.request (generic SchemaOutput<T>)
      request: async (req: unknown) => {
        callRequests.push(req);
        return { content: [{ type: "text", text: "pong" }] };
      },
    });
    const call = mcpExpectation(called.leaf);
    callConn.handle(call);
    await when(() => call.isDone, { timeout: TIMEOUT });
    expect({
      requests: callRequests,
      dispatched: call.dispatched,
      outcome: called.parent.receiptJson,
      job: { outcome: call.outcome, completed: called.leaf.completed },
    }).toEqual({
      requests: [
        {
          method: "tools/call",
          params: { name: "search", arguments: { q: "hi" } },
        },
      ],
      dispatched: true,
      outcome: JSON.stringify({ ok: true, value: "pong" }),
      job: { outcome: "successful", completed: false },
    });

    const stdio = homeCall({ connectionKey: "stdio" });
    const stdioConn = new StderrMcpConnection("stdio");
    stdioConn.tail = "boom on stderr";
    ready(stdioConn, {
      // @ts-expect-error stub is not Client.request (generic SchemaOutput<T>)
      request: async () => ({
        isError: true,
        content: [{ type: "text", text: "nope" }],
      }),
    });
    const stdioExpectation = mcpExpectation(stdio.leaf);
    stdioConn.handle(stdioExpectation);
    await when(() => stdioExpectation.isDone, { timeout: TIMEOUT });

    const http = homeCall({ connectionKey: "http" });
    const httpConn = new McpHttpDriverConnection("http", {
      url: "http://127.0.0.1:1/",
    });
    httpConn.readyState = "ready";
    httpConn.bootstrapDone = true;
    httpConn.state.auth = "needs-auth";
    const httpExpectation = mcpExpectation(http.leaf);
    httpConn.handle(httpExpectation);
    await when(() => httpExpectation.isDone, { timeout: TIMEOUT });

    expect({
      stdio: stdio.parent.receiptJson,
      http: {
        outcome: httpExpectation.outcome,
        detail: httpExpectation.endDetail,
        receipt: http.parent.receiptJson,
      },
    }).toEqual({
      stdio: JSON.stringify({
        ok: false,
        text: "nope\n--- stderr ---\nboom on stderr",
        value: "nope",
      }),
      http: {
        outcome: "failed",
        detail: "mcp: connection needs auth",
        receipt: JSON.stringify({
          ok: false,
          text: "mcp: connection needs auth",
        }),
      },
    });
  });
});
