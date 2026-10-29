import { resetLocalIDs } from "@here.build/plexus";
import {
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { abortParkableWork, liveEvalWork, mcpJobOnWire } from "../index.js";
import { sessionOf } from "./fixtures.js";

beforeEach(() => resetLocalIDs());

describe("park", () => {
  it("on-wire MCP and live eval hold; other in-flight work aborts with park", () => {
    const plexus = sessionOf("park");
    const pew = new McpToolExpectation({ connectionId: "mcp1" });
    pew.dispatched = true;
    const mcp = new MCPToolJob({
      toolCallId: "m1",
      name: "mcp",
      argsJson: "{}",
      expectation: pew,
    });
    mcp.dispatched = true;
    const program = new ProgrammaticJob({
      toolCallId: "program",
      argsJson: JSON.stringify({ expr: "1", description: "eval" }),
    });
    const echo = new SystemToolJob({
      toolCallId: "e1",
      name: "echo",
      argsJson: "{}",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [mcp, program, echo],
      evalSpec: new SessionTurnEvalSpec({ requestId: "r1", permissionMode: "auto" }),
    });
    turn.pushChild(mcp);
    turn.pushChild(program);
    turn.pushChild(echo);
    plexus.root.head = turn;

    expect(mcpJobOnWire(mcp)).toBe(true);
    expect([...liveEvalWork(plexus.root)]).toContain(program);
    const aborted: Array<{ job: unknown; reason: unknown }> = [];
    abortParkableWork(plexus.root, {
      inFlightJobs: () => [mcp, program, echo],
      abortJob: (job, reason) => {
        aborted.push({ job, reason });
      },
    });
    expect(aborted).toEqual([{ job: echo, reason: "park" }]);
    expect(
      abortParkableWork(plexus.root, {
        inFlightJobs: () => [mcp, program, echo],
        abortJob: () => undefined,
      }),
    ).toEqual({
      mcpPending: true,
      evalPending: true,
    });
  });
});
