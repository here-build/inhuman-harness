import { resetLocalIDs } from "@here.build/plexus";
import {
  AgentCallJob,
  GLANCE_ASK_LINE_MAX_CHARS,
  McpToolExpectation,
  MCPToolJob,
  ProgrammaticJob,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, expect, test } from "vitest";

import { glanceAskLine } from "../glance-ask-line.js";

beforeEach(() => resetLocalIDs());

function shell(args: Record<string, unknown> = {}): SystemToolJob {
  return new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    policyResult: "ask",
    argsJson: JSON.stringify(args),
  });
}

test("glanceAskLine is family plus optional description", () => {
  const mcpNamed = new MCPToolJob({
    toolCallId: "m1",
    name: "mcp__github__create_issue",
    serverToolName: "create_issue",
    policyResult: "ask",
    expectation: new McpToolExpectation({
      connectionId: "github",
      serverToolName: "create_issue",
    }),
  });
  const mcpWire = new MCPToolJob({
    toolCallId: "m2",
    name: "mcp__github__create_issue",
    serverToolName: "",
    policyResult: "ask",
    expectation: new McpToolExpectation({
      connectionId: "github",
      serverToolName: "mcp__github__create_issue",
    }),
  });
  const agent = new AgentCallJob({
    toolCallId: "a1",
    name: "agent__ask",
  });
  const inner = shell();
  const bag = new ProgrammaticJob({ toolCallId: "p1", toolName: "scheme_repl" });
  bag.pushInvocation(inner);
  const long = "x".repeat(GLANCE_ASK_LINE_MAX_CHARS + 20);
  expect({
    empty: glanceAskLine(null),
    shell: glanceAskLine(shell()),
    described: glanceAskLine(shell({ description: "rotate the cookie" })),
    describedWins: glanceAskLine(shell({ description: "rotate the cookie", command: "rm -rf /" })),
    agent: glanceAskLine(agent),
    mcpNamed: glanceAskLine(mcpNamed),
    mcpWire: glanceAskLine(mcpWire),
    bagHead: glanceAskLine(bag.approvalHead),
    edit: glanceAskLine(new SystemToolJob({ toolCallId: "e", name: "edit_file", policyResult: "ask" })),
    write: glanceAskLine(new SystemToolJob({ toolCallId: "w", name: "write_file", policyResult: "ask" })),
    other: glanceAskLine(new SystemToolJob({ toolCallId: "r", name: "read_file", policyResult: "ask" })),
    clamped: glanceAskLine(shell({ description: long })).length <= GLANCE_ASK_LINE_MAX_CHARS,
  }).toEqual({
    empty: "",
    shell: "confirm shell command?",
    described: "approve rotate the cookie?",
    describedWins: "approve rotate the cookie?",
    agent: "confirm agent?",
    mcpNamed: "confirm create_issue?",
    mcpWire: "confirm mcp__github__create_issue?",
    bagHead: "confirm shell command?",
    edit: "confirm edit?",
    write: "confirm write?",
    other: "confirm read_file?",
    clamped: true,
  });
});
