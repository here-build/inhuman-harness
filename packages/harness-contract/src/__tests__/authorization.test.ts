import { describe, expect, it } from "vitest";

import { contract } from "../contract.js";
import {
  ackAnswerInput,
  ackListInput,
  ackRequestSchema,
  askAnswerInput,
  askAnswerOutput,
  grantAddInput,
  grantRowSchema,
  grantSubjectSchema,
  policyExplainInput,
  policyExplainOutput,
  policyOverlayInput,
} from "../schemas/authorization.js";
import { configSetInput } from "../schemas/shapes.js";

const row = {
  id: "g1",
  scope: "project",
  scopeKey: "/p",
  subject: { kind: "command", argv0: "git", spine: ["push"], args: [] },
  createdAtMs: 1,
  expiresAtMs: 2,
  source: "prompt",
  label: "git push",
};

describe("policy v2 wire", () => {
  it("the old cluster flags are gone from the wire", () => {
    const names = JSON.stringify(Object.keys(contract.session)) + JSON.stringify(Object.keys(contract.kernel));
    expect(names).not.toContain("autoAllow");
    expect(contract.kernel.config).not.toHaveProperty("autoAllow");
    expect(contract.session).not.toHaveProperty("config");
    // `persist` is kept for refusing an MCP look-up; allowing is `store`
    expect(askAnswerInput.parse({ sessionId: "s", jobId: "j", allow: false, persist: "always" }).persist).toBe(
      "always",
    );
    expect(askAnswerInput.safeParse({ sessionId: "s", jobId: "j", allow: false, persist: "forever" }).success).toBe(
      false,
    );
  });

  it("ask/answer takes a store with scope, subject and ttl", () => {
    const store = { scope: "project", subject: row.subject, ttlMs: 60_000 };
    expect(askAnswerInput.parse({ sessionId: "s", jobId: "j", allow: true, store }).store).toEqual(store);
    expect(
      askAnswerInput.safeParse({ sessionId: "s", jobId: "j", allow: true, store: { ...store, scope: "forever" } })
        .success,
    ).toBe(false);
    expect(
      askAnswerInput.safeParse({ sessionId: "s", jobId: "j", allow: true, store: { ...store, ttlMs: null } }).success,
    ).toBe(true);
    expect(
      askAnswerInput.safeParse({ sessionId: "s", jobId: "j", allow: true, store: { ...store, extra: 1 } }).success,
    ).toBe(false);
    expect(askAnswerOutput.safeParse({ ok: false, reason: "soft-deny-not-storable" }).success).toBe(true);
    expect(askAnswerOutput.safeParse({ ok: false, reason: "block" }).success).toBe(true);
  });

  it("grant subjects are closed families", () => {
    expect(grantSubjectSchema.safeParse(row.subject).success).toBe(true);
    expect(grantSubjectSchema.safeParse({ kind: "cluster", cluster: "bash" }).success).toBe(false);
    expect(grantSubjectSchema.safeParse({ kind: "command", argv0: "", spine: [], args: [] }).success).toBe(false);
    expect(grantSubjectSchema.safeParse({ kind: "mcp", server: "gmail", account: "work", tool: "send" }).success).toBe(
      true,
    );
    expect(grantRowSchema.safeParse(row).success).toBe(true);
    expect(grantRowSchema.safeParse({ ...row, scope: "machine" }).success).toBe(false);
    expect(grantAddInput.safeParse({ scope: "global", subject: row.subject }).success).toBe(true);
    expect(grantAddInput.safeParse({ scope: "global", subject: row.subject, ttlMs: 0 }).success).toBe(false);
  });

  it("explain takes a probe and answers tier, classes, resolver and outcome", () => {
    expect(policyExplainInput.safeParse({ probe: { kind: "shell", command: "npm publish" } }).success).toBe(true);
    expect(policyExplainInput.safeParse({ probe: { kind: "path", cluster: "exec", path: "x" } }).success).toBe(false);
    expect(policyExplainInput.safeParse({ probe: { kind: "shell", command: "ls" }, mode: "full" }).success).toBe(false);
    const out = {
      tier: "soft-deny",
      classes: [{ id: "publish", label: "Publishes" }],
      votes: [{ tier: "soft-deny", class: "publish", ruleId: "bash:npm/publish" }],
      resolver: { kind: "judge", layer: "dist", onDeny: "human", onFail: "human" },
      grant: null,
      grantable: [],
      ack: null,
      outcome: "judge-soft-deny",
      reason: "r",
    };
    expect(policyExplainOutput.safeParse(out).success).toBe(true);
    expect(policyExplainOutput.safeParse({ ...out, tier: "deny" }).success).toBe(false);
    expect(policyExplainOutput.safeParse({ ...out, classes: [{ id: "risky", label: "x" }] }).success).toBe(false);
  });

  it("overlay and config/set carry an authorization block", () => {
    expect(policyOverlayInput.safeParse({ overlay: { auto: {} } }).success).toBe(true);
    expect(policyOverlayInput.safeParse({ overlay: null }).success).toBe(true);
    expect(configSetInput.safeParse({ authorization: { yolo: {} } }).success).toBe(true);
  });

  it("the new methods exist on the right hosts", () => {
    const meta = (p: { "~orpc": { meta: unknown } }) => p["~orpc"].meta;
    expect(meta(contract.session.policy.explain)).toEqual({ method: "policy/explain", host: "session" });
    expect(meta(contract.session.policy.overlay)).toEqual({ method: "policy/overlay", host: "session" });
    expect(meta(contract.kernel.grant.list)).toEqual({ method: "grant/list", host: "kernel" });
    expect(meta(contract.kernel.grant.add)).toEqual({ method: "grant/add", host: "kernel" });
    expect(meta(contract.kernel.grant.revoke)).toEqual({ method: "grant/revoke", host: "kernel" });
  });

  it("acknowledgements: ack/answer needs the ids and a verdict, and store is one offered subject", () => {
    const base = { sessionId: "s", jobId: "j", ackId: "j", accept: true };
    expect(ackAnswerInput.safeParse(base).success).toBe(true);
    expect(ackAnswerInput.safeParse({ ...base, accept: undefined }).success).toBe(false);
    const store = { scope: "project", subject: { kind: "mcp", server: "gmail", tool: "send_email" } };
    expect(ackAnswerInput.safeParse({ ...base, store }).success).toBe(true);
    expect(ackAnswerInput.safeParse({ ...base, store: { ...store, scope: "tenant" } }).success).toBe(false);
    // The wire accepts no field that would let a client write the stamp.
    expect(ackAnswerInput.safeParse({ ...base, ackState: "satisfied" }).success).toBe(false);
    expect(ackAnswerInput.safeParse({ ...base, humanApprove: true }).success).toBe(false);
  });

  it("an ack subject may be a class; a grant list takes no ack filter on ack/list", () => {
    expect(grantSubjectSchema.safeParse({ kind: "class", class: "publish" }).success).toBe(true);
    expect(grantSubjectSchema.safeParse({ kind: "class", class: "risky" }).success).toBe(false);
    expect(ackListInput.safeParse({ scope: "project" }).success).toBe(true);
    expect(ackListInput.safeParse({ kind: "grant" }).success).toBe(false);
    expect(grantRowSchema.safeParse({ ...row, kind: "ack" }).success).toBe(true);
    expect(grantRowSchema.safeParse({ ...row, kind: "maybe" }).success).toBe(false);
  });

  it("ack/pending reports the call, the flags and what may be remembered", () => {
    const request = {
      ackId: "j",
      sessionId: "s",
      jobId: "j",
      tool: "mcp__gmail__send_email",
      summary: "gmail · send_email",
      detail: "{}",
      flags: [{ label: "gmail · send_email", why: "emails leave the company", layer: "user" }],
      verdict: { tier: "allow", classes: [], licensedBy: "floor" },
      storeOptions: [
        {
          scope: "project",
          subject: { kind: "mcp", server: "gmail", tool: "send_email" },
          label: "x",
          defaultTtlMs: 1,
        },
      ],
      createdAtMs: 1,
    };
    expect(ackRequestSchema.safeParse(request).success).toBe(true);
    expect(
      ackRequestSchema.safeParse({ ...request, verdict: { ...request.verdict, licensedBy: "client" } }).success,
    ).toBe(false);
  });

  it("the ack RPCs are in the contract: ack/pending and ack/answer on the session, ack/list|add|revoke on the kernel", () => {
    expect(JSON.stringify(Object.keys(contract.session))).toContain("ack");
    expect(Object.keys(contract.session.ack)).toEqual(["pending", "answer"]);
    expect(Object.keys(contract.kernel.ack)).toEqual(["list", "add", "revoke"]);
  });
});
