/**
 * The class taxonomy is closed and owned by `@inhuman.tools/policy`. The model and the contract each keep
 * a copy (neither may depend on the policy package); this pins that the three never drift, and that the
 * wire's grant and tier shapes accept exactly what the model produces.
 */
import {
  contract,
  CLASS_IDS as CONTRACT_CLASS_IDS,
  grantRowSchema,
  grantSubjectSchema,
} from "@inhuman.tools/harness-contract";
import {
  CLASS_IDS as MODEL_CLASS_IDS,
  grantRowSchema as modelGrantRow,
  grantSubjectSchema as modelSubject,
} from "@inhuman.tools/harness-model";
import { CLASS_IDS, CLASSES, isClassId, TIER_NAMES } from "@inhuman.tools/policy/floor";
import { describe, expect, it } from "vitest";

describe("taxonomy parity", () => {
  it("policy, model and contract name the same classes in the same order", () => {
    expect([...MODEL_CLASS_IDS]).toEqual([...CLASS_IDS]);
    expect([...CONTRACT_CLASS_IDS]).toEqual([...CLASS_IDS]);
    expect(Object.keys(CLASSES)).toEqual([...CLASS_IDS]);
  });

  it("tier names are soft-deny and ask; risky and general are nothing", () => {
    expect([...TIER_NAMES]).toEqual(["soft-deny", "ask"]);
    expect(isClassId("risky")).toBe(false);
    expect(isClassId("general")).toBe(false);
  });

  it("the wire and the model agree on grant subjects and rows", () => {
    const subjects = [
      { kind: "command", argv0: "git", spine: ["push"], args: [] },
      { kind: "path", cluster: "write", path: "src", depth: "subtree" },
      { kind: "mcp", server: "gmail", account: "work", tool: "send" },
      { kind: "tool", name: "web_extract" },
    ];
    for (const subject of subjects) {
      expect(grantSubjectSchema.safeParse(subject).success).toBe(true);
      expect(modelSubject.safeParse(subject).success).toBe(true);
    }
    const bad = [
      { kind: "cluster", cluster: "bash" },
      { kind: "command", argv0: "" },
      { kind: "path", cluster: "exec", path: "x" },
    ];
    for (const subject of bad) {
      expect(grantSubjectSchema.safeParse(subject).success).toBe(false);
      expect(modelSubject.safeParse(subject).success).toBe(false);
    }
    const row = {
      id: "g",
      scope: "bot",
      scopeKey: "b",
      subject: subjects[0],
      createdAtMs: 1,
      expiresAtMs: null,
      source: "settings",
      label: "l",
    };
    expect(grantRowSchema.safeParse(row).success).toBe(modelGrantRow.safeParse(row).success);
    expect(grantRowSchema.safeParse({ ...row, source: "migration" }).success).toBe(false);
    expect(modelGrantRow.safeParse({ ...row, source: "migration" }).success).toBe(false);
  });

  it("every contract method of the policy engine is declared once", () => {
    expect(Object.keys(contract.kernel.grant).toSorted()).toEqual(["add", "list", "revoke"]);
    expect(Object.keys(contract.session.policy).toSorted()).toEqual(["configGet", "explain", "overlay", "set"]);
  });
});
