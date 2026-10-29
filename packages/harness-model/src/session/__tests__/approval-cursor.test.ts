/**
 * Leaves license. Sequences project. Cursor walks children, not collectors.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { CompletionExpectation } from "../expectations/CompletionExpectation.js";
import { McpToolExpectation } from "../expectations/McpToolExpectation.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { MCPToolJob } from "../jobs/MCPToolJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";
import { attached } from "./_helpers/fixtures.js";

function leaf(approved: true | false | null = null): SystemToolJob {
  const job = new SystemToolJob();
  job.humanApprove = approved;
  if (approved === null) job.policyResult = "ask";
  return job;
}

describe("approval cursor", () => {
  beforeEach(() => resetLocalIDs());

  it("queue and head flatten pending leaves in tree order; skip deny, PEW, sequences", () => {
    const session = attached({ sessionId: "s-cursor", path: "/tmp/demo" });
    const plexus = Plexus.bootstrap(session);

    const first = leaf();
    const inner = leaf();
    const denied = leaf(false);
    const mcp = new MCPToolJob({
      expectation: new McpToolExpectation({ connectionId: "mail" }),
    });
    mcp.policyResult = "ask";
    const pew = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c1" }) });
    const program = new ProgrammaticJob();
    program.children.push(inner);
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`t`,
      queue: [],
    });
    turn.children.push(first, program, denied, mcp, pew);
    session.head = turn;

    const start = {
      program: program.approvalLeaves,
      programHead: program.approvalHead,
      queue: turn.approvalLeaves,
      head: turn.approvalHead,
      sequenceApproved: "approved" in turn || "approved" in program,
    };
    first.humanApprove = true;
    const afterFirst = { head: turn.approvalHead, queue: turn.approvalLeaves };
    inner.humanApprove = true;
    const afterInner = turn.approvalHead;
    mcp.humanApprove = true;
    expect({
      start,
      afterFirst,
      afterInner,
      done: { head: turn.approvalHead, queue: turn.approvalLeaves },
    }).toEqual({
      start: {
        program: [inner],
        programHead: inner,
        queue: [first, inner, mcp],
        head: first,
        sequenceApproved: false,
      },
      afterFirst: { head: inner, queue: [inner, mcp] },
      afterInner: mcp,
      done: { head: null, queue: [] },
    });

    plexus.destroy();
  });
});
