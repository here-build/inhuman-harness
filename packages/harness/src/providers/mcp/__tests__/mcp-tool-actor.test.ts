/**
 * MCP BODY is the connection actor. Stdio paints stderr; HTTP declines needs-auth.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  MCPToolJob,
  McpToolExpectation,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import "@inhuman.tools/harness-model/register";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

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
  readonly plexus: SessionPlexus;
  readonly parent: MCPToolJob;
  readonly leaf: MCPToolJob;
} {
  const plexus = SessionPlexus.create(`mcp-actor-${args.connectionKey}-${args.serverToolName ?? "ping"}`, "/ws");
  onTestFinished(() => plexus.destroy());
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
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  job.humanApprove = true;
  job.orchestrationResult = true;
  return { plexus, parent: job, leaf: job };
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
  beforeEach(() => resetLocalIDs());

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
    const excludedPew = mcpExpectation(excluded.leaf);
    excludeConn.handle(excludedPew);
    await when(() => excludedPew.isDone, { timeout: TIMEOUT });
    expect({
      requests: excludeRequests,
      dispatched: excludedPew.dispatched,
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
    const stdioPew = mcpExpectation(stdio.leaf);
    stdioConn.handle(stdioPew);
    await when(() => stdioPew.isDone, { timeout: TIMEOUT });

    const http = homeCall({ connectionKey: "http" });
    const httpConn = new McpHttpDriverConnection("http", {
      url: "http://127.0.0.1:1/",
    });
    httpConn.readyState = "ready";
    httpConn.bootstrapDone = true;
    httpConn.state.auth = "needs-auth";
    const httpPew = mcpExpectation(http.leaf);
    httpConn.handle(httpPew);
    await when(() => httpPew.isDone, { timeout: TIMEOUT });

    expect({
      stdio: stdio.parent.receiptJson,
      http: {
        outcome: httpPew.outcome,
        detail: httpPew.endDetail,
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
