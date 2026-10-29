/** Cancel writes `cancelled`, not `approved`. Deny-side stamps a receipt. */
import { resetLocalIDs } from "@here.build/plexus";
import {
  CLASSIFIER_DENIED,
  POLICY_PROHIBITS,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  USER_REFUSED,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { stampToolOutcome } from "../approval/approved.js";
import { cancelUnstartedTool, inboundTurnGuard, stampLicenseDeny } from "../index.js";

beforeEach(() => resetLocalIDs());

function deny(leaf: SystemToolJob): void {
  stampLicenseDeny(leaf, "manual");
}

function callWithLeaf(): { leaf: SystemToolJob; call: SystemToolJob } {
  const job = new SystemToolJob({
    toolCallId: "c1",
    name: "edit_file",
    argsJson: "{}",
  });
  return { leaf: job, call: job };
}

describe("deny receipt / cancel", () => {
  it.each([
    {
      name: "user refuse with comment stays a generic refuse",
      setup: (leaf: SystemToolJob) => {
        leaf.humanApprove = false;
        leaf.approvalComment = "use ripgrep";
      },
      act: deny,
      out: {
        humanApprove: false,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: USER_REFUSED, refusalReason: USER_REFUSED },
      },
    },
    {
      name: "user refuse without comment",
      setup: (leaf: SystemToolJob) => {
        leaf.humanApprove = false;
      },
      act: deny,
      out: {
        humanApprove: false,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: USER_REFUSED, refusalReason: USER_REFUSED },
      },
    },
    {
      name: "classifier deny",
      setup: (leaf: SystemToolJob) => {
        leaf.classifierResult = "deny";
      },
      act: deny,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: CLASSIFIER_DENIED, refusalReason: CLASSIFIER_DENIED, code: "policy_denied" },
      },
    },
    {
      name: "floor block",
      setup: (leaf: SystemToolJob) => {
        leaf.policyResult = "block";
      },
      act: deny,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: POLICY_PROHIBITS, refusalReason: POLICY_PROHIBITS, code: "policy_denied" },
      },
    },
    {
      name: "floor block uses policyMessage",
      setup: (leaf: SystemToolJob) => {
        leaf.policyResult = "block";
        leaf.policyMessage =
          "Policy safeguards were unable to classify this shell script's safety. It may be correct to use, but it is too complex for static analysis; try to produce a simpler or more explicit shell script that will do the same thing.";
      },
      act: deny,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: {
          ok: false,
          text: "Policy safeguards were unable to classify this shell script's safety. It may be correct to use, but it is too complex for static analysis; try to produce a simpler or more explicit shell script that will do the same thing.",
          refusalReason:
            "Policy safeguards were unable to classify this shell script's safety. It may be correct to use, but it is too complex for static analysis; try to produce a simpler or more explicit shell script that will do the same thing.",
          code: "policy_denied",
        },
      },
    },
    {
      name: "human refuse wins",
      setup: (leaf: SystemToolJob) => {
        leaf.classifierResult = "deny";
        leaf.humanApprove = false;
      },
      act: deny,
      out: {
        humanApprove: false,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: USER_REFUSED, refusalReason: USER_REFUSED },
      },
    },
    {
      name: "deny-side stamps receipt without writing approved",
      act: deny,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: POLICY_PROHIBITS, refusalReason: POLICY_PROHIBITS, code: "policy_denied" },
      },
    },
    {
      name: "cancelUnstartedTool cancelled not approved",
      act: cancelUnstartedTool,
      out: {
        humanApprove: null,
        cancelled: true,
        completed: true,
        outcome: { ok: false, text: "cancelled" },
      },
    },
    {
      name: "timeout vs cancelled",
      act: (leaf: SystemToolJob) => cancelUnstartedTool(leaf, new Error("evaluation timed out after 90ms")),
      out: {
        humanApprove: null,
        cancelled: true,
        completed: true,
        outcome: { ok: false, text: "evaluation timed out after 90ms" },
      },
    },
    {
      name: "cancel does not copy approvalComment",
      setup: (leaf: SystemToolJob) => {
        leaf.approvalComment = "use ripgrep";
      },
      act: cancelUnstartedTool,
      out: {
        humanApprove: null,
        cancelled: true,
        completed: true,
        outcome: { ok: false, text: "cancelled" },
      },
    },
    {
      name: "already-orchestrated",
      setup: (leaf: SystemToolJob) => {
        leaf.orchestrationResult = true;
      },
      act: cancelUnstartedTool,
      out: {
        humanApprove: null,
        cancelled: true,
        completed: false,
        outcome: { ok: false, text: "cancelled" },
      },
    },
    {
      name: "does not overwrite existing receipt",
      setup: (leaf: SystemToolJob) => {
        leaf.receiptJson = JSON.stringify({ ok: true, text: "kept" });
      },
      act: (leaf: SystemToolJob) => {
        stampToolOutcome(leaf, "cancelled");
        deny(leaf);
      },
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: true, text: "kept" },
      },
    },
  ])("$name", ({ setup, act, out }) => {
    const { leaf, call } = callWithLeaf();
    setup?.(leaf);
    act(leaf);
    expect({
      humanApprove: leaf.humanApprove,
      cancelled: leaf.cancelled,
      completed: leaf.completed,
      outcome: JSON.parse(call.receiptJson ?? "null"),
    }).toEqual(out);
  });
});

describe("inbound turn guard", () => {
  it("passes an inbound turn whose closed predecessors cycle", () => {
    const a = new SessionTurn({ turnTail: new SessionSystemPrompt(), inbound: true, reducerExited: true, queue: [] });
    const b = new SessionTurn({ turnTail: a, inbound: true, reducerExited: true, queue: [] });
    a.turnTail = b;
    const turn = new SessionTurn({ turnTail: b, inbound: true });
    expect(inboundTurnGuard(turn)).toBe(true);
  });
});
