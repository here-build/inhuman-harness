/** Cancel writes `cancelled`, not `approved`. Deny-side stamps a receipt. */
import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { FailureOutcome } from "../jobs/CallOutcome.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import {
  applyDenyReceipt,
  applyToolOutcomeReceipt,
  CLASSIFIER_DENIED,
  refusalReasonOf,
  POLICY_PROHIBITS,
  cancelUnstarted,
  USER_REFUSED,
} from "../outcome-receipts.js";

beforeEach(() => resetLocalIDs());

describe("refusalReasonOf", () => {
  it("names the actor: user, classifier, policy message, then the floor", () => {
    const leaf = new SystemToolJob({ name: "edit_file", argsJson: "{}" });
    const user = new SystemToolJob({
      name: "edit_file",
      argsJson: "{}",
      humanApprove: false,
    });
    const classifier = new SystemToolJob({ name: "edit_file", argsJson: "{}" });
    classifier.classifierResult = "deny";
    const message = new SystemToolJob({ name: "edit_file", argsJson: "{}" });
    message.policyMessage = "too complex for static analysis";
    expect({
      floor: refusalReasonOf(leaf),
      user: refusalReasonOf(user),
      classifier: refusalReasonOf(classifier),
      message: refusalReasonOf(message),
    }).toEqual({
      floor: POLICY_PROHIBITS,
      user: USER_REFUSED,
      classifier: CLASSIFIER_DENIED,
      message: "too complex for static analysis",
    });
  });
});

describe("applyDenyReceipt / cancelUnstarted", () => {
  it.each([
    {
      name: "user refuse omits policy_denied",
      setup: (leaf: SystemToolJob) => {
        leaf.humanApprove = false;
      },
      act: applyDenyReceipt,
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
      act: applyDenyReceipt,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: CLASSIFIER_DENIED, refusalReason: CLASSIFIER_DENIED, code: "policy_denied" },
      },
    },
    {
      name: "floor block",
      act: applyDenyReceipt,
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: false, text: POLICY_PROHIBITS, refusalReason: POLICY_PROHIBITS, code: "policy_denied" },
      },
    },
    {
      name: "does not overwrite existing receipt",
      setup: (leaf: SystemToolJob) => {
        leaf.receiptJson = JSON.stringify({ ok: true, text: "kept" });
      },
      act: (leaf: SystemToolJob) => {
        applyToolOutcomeReceipt(leaf, "cancelled");
        applyDenyReceipt(leaf);
      },
      out: {
        humanApprove: null,
        cancelled: false,
        completed: false,
        outcome: { ok: true, text: "kept" },
      },
    },
    {
      name: "cancelUnstarted cancelled not approved",
      act: cancelUnstarted,
      out: {
        humanApprove: null,
        cancelled: true,
        completed: true,
        outcome: { ok: false, text: "cancelled" },
      },
    },
    {
      name: "timeout vs cancelled",
      act: (leaf: SystemToolJob) => cancelUnstarted(leaf, new Error("evaluation timed out after 90ms")),
      out: {
        humanApprove: null,
        cancelled: true,
        completed: true,
        outcome: { ok: false, text: "evaluation timed out after 90ms" },
      },
    },
    {
      name: "already-orchestrated stays incomplete",
      setup: (leaf: SystemToolJob) => {
        leaf.orchestrationResult = true;
      },
      act: cancelUnstarted,
      out: {
        humanApprove: null,
        cancelled: true,
        completed: false,
        outcome: { ok: false, text: "cancelled" },
      },
    },
  ])("$name", ({ setup, act, out }) => {
    const leaf = new SystemToolJob({
      toolCallId: "c1",
      name: "edit_file",
      argsJson: "{}",
    });
    setup?.(leaf);
    act(leaf);
    expect({
      humanApprove: leaf.humanApprove,
      cancelled: leaf.cancelled,
      completed: leaf.completed,
      outcome: JSON.parse(leaf.receiptJson ?? "null"),
    }).toEqual(out);
  });

  it("Call deny is FailureOutcome denied, cancel is cancelled", () => {
    const denied = new AgentCallJob({ name: "agent__ask", argsJson: "{}" });
    applyDenyReceipt(denied);
    const cancelled = new AgentCallJob({ name: "agent__send", argsJson: "{}" });
    cancelUnstarted(cancelled);
    expect({
      denyCode: denied.outcome instanceof FailureOutcome ? denied.outcome.code : null,
      denyMessage: denied.outcome instanceof FailureOutcome ? denied.outcome.message : null,
      cancelCode: cancelled.outcome instanceof FailureOutcome ? cancelled.outcome.code : null,
      cancelMessage: cancelled.outcome instanceof FailureOutcome ? cancelled.outcome.message : null,
      cancelled: cancelled.cancelled,
      completed: cancelled.completed,
    }).toEqual({
      denyCode: "denied",
      denyMessage: POLICY_PROHIBITS,
      cancelCode: "cancelled",
      cancelMessage: "cancelled",
      cancelled: true,
      completed: true,
    });
  });
});
