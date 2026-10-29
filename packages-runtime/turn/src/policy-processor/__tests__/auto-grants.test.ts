/**
 * Grants and roots stay narrow: a stored grant only ever turns an ask into allow (never a soft-deny,
 * never a block, never a lifted ask); a single read outside the workspace is soft-deny and is
 * licensed every time; a session root follows the in-workspace rules but never lifts a block; a
 * broken operator policy fails closed; an empty classifier program hands the call to a person.
 */
import type { GrantRow } from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { scopes } from "../scope.js";
import { read, settled, shell, TIMEOUT, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = `{"read_file":[".","!secret"],"write_file":["."],"read_block":[".env"],"write_block":[".env"],"bash":{"policy":"ask","subcommands":{"rm":"deny","ls":"approve","curl":"ask","blocked":"block"}}}`;

const grant = (subject: GrantRow["subject"], id = "g1"): GrantRow => ({
  id,
  scope: "session",
  scopeKey: "s-lic",
  subject,
  createdAtMs: 0,
  expiresAtMs: null,
  source: "prompt",
  label: id,
});
const curl = grant({ kind: "command", argv0: "curl", spine: [], args: [] });
const rm = grant({ kind: "command", argv0: "rm", spine: [], args: [] }, "g2");
const blocked = grant({ kind: "command", argv0: "blocked", spine: [], args: [] }, "g3");

describe("a stored grant stays narrow", () => {
  it("covers a floor ask but never a soft-deny or a block, in any mode", async () => {
    for (const policy of ["manual", "auto"] as const) {
      using bag = setup({
        policy,
        unattended: false,
        policyProgram: FLOOR,
        judgeAskProgram: "",
        grants: [curl, rm, blocked],
      });
      const ask = shell("curl x");
      const deny = shell("rm -rf x");
      const block = shell("blocked now");
      for (const job of [ask, deny, block]) bag.enqueue(job);
      await when(() => [ask, deny, block].every((job) => job.policyResult !== null), { timeout: TIMEOUT });
      expect([ask, deny, block].map((job) => [job.policyResult, job.grantedBy, job.licenseDecision])).toEqual([
        ["ask", "g1", true],
        ["deny", null, null],
        ["block", null, false],
      ]);
    }
  });

  it("does not cover a lifted ask (env prefix, xargs, non-literal) or a different family", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, grants: [curl] });
    const jobs = [shell("FOO=1 curl x"), shell("echo y | xargs curl"), shell("curl $URL"), shell("wget x")];
    for (const job of jobs) bag.enqueue(job);
    await when(() => jobs.every((job) => job.policyResult !== null), { timeout: TIMEOUT });
    expect(jobs.map((job) => [job.policyResult, job.grantedBy])).toEqual([
      ["ask", null],
      ["ask", null],
      ["ask", null],
      ["ask", null],
    ]);
  });

  it("an expired or revoked grant stops covering an unlicensed ask; reconcile picks up a new one", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, grants: [{ ...curl, expiresAtMs: 5 }] });
    const scope = scopes.get(bag.root);
    scope.now = () => 10;
    const expired = shell("curl x");
    bag.enqueue(expired);
    await when(() => expired.policyResult !== null, { timeout: TIMEOUT });
    expect(expired.grantedBy).toBeNull();
    bag.root.replaceGrantsJson(JSON.stringify([curl]));
    scope.reconcileGrants();
    expect(expired.grantedBy).toBe("g1");
    await settled(expired);
    expect(expired.orchestrationResult).toBe(true);
    // revoke before the ask is licensed
    const next = shell("curl y");
    bag.root.replaceGrantsJson("");
    bag.enqueue(next);
    await when(() => next.policyResult !== null, { timeout: TIMEOUT });
    bag.root.replaceGrantsJson(JSON.stringify([curl]));
    scope.reconcileGrants();
    bag.root.replaceGrantsJson("");
    scope.reconcileGrants();
    expect(next.grantedBy).toBeNull();
  });
});

describe("reads outside the workspace", () => {
  it("a single outside read is soft-deny and nothing is remembered after a human allow", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    const first = read("/tmp/other/a.ts");
    bag.enqueue(first);
    await when(() => first.policyResult !== null, { timeout: TIMEOUT });
    expect([first.policyResult, first.needsHuman]).toEqual(["deny", true]);
    first.humanApprove = true;
    await settled(first);
    const second = read("/tmp/other/a.ts");
    bag.enqueue(second);
    await when(() => second.policyResult !== null, { timeout: TIMEOUT });
    expect([second.policyResult, second.needsHuman, second.orchestrated]).toEqual(["deny", true, false]);
    expect(second.grantOptions).toEqual([]);
  });

  it("a session root makes the folder follow the in-workspace rules, and block still blocks", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, readRoots: ["/tmp/other"] });
    const inside = read("/tmp/other/a.ts");
    const secret = read("/tmp/other/.env");
    const sibling = read("/tmp/other2/a.ts");
    for (const job of [inside, secret, sibling]) bag.enqueue(job);
    await when(() => [inside, secret, sibling].every((job) => job.policyResult !== null), { timeout: TIMEOUT });
    expect([inside, secret, sibling].map((job) => job.policyResult)).toEqual(["policyApprove", "block", "deny"]);
  });

  it("a root is not a write root and not an ancestor blanket", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, readRoots: ["/tmp/other"] });
    const out = write("/tmp/other/a.ts");
    bag.enqueue(out);
    await when(() => out.policyResult !== null, { timeout: TIMEOUT });
    expect(out.policyResult).toBe("deny");
    expect(bag.root.addReadRoot("/")).toBe(false);
    expect(bag.root.addReadRoot("/etc")).toBe(false);
  });

  it("an extra-root write stays soft-deny with the envelope class", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    const out = write("/etc/passwd");
    bag.enqueue(out);
    await when(() => out.policyResult !== null, { timeout: TIMEOUT });
    expect([out.policyResult, out.policyClasses]).toEqual(["deny", ["envelope-write"]]);
  });
});

describe("a broken policy", () => {
  it("an operator policy that does not compile blocks every call and says why (policy-fault)", async () => {
    using bag = setup({ policy: "auto", policyProgram: "(not json" });
    const seen: Array<string | null> = [];
    scopes.get(bag.root).onPolicyError = (text) => {
      seen.push(text);
    };
    const j = write("a.ts");
    bag.enqueue(j);
    await when(() => j.policyResult !== null, { timeout: TIMEOUT });
    await settled(j);
    expect({
      policy: j.policyResult,
      classes: j.policyClasses,
      message: j.policyMessage?.includes("invalid"),
      reported: seen.some((t) => t?.includes("invalid")),
    }).toEqual({ policy: "block", classes: ["policy-fault"], message: true, reported: true });
    expect(j.orchestrationResult).toBe(false);
  });

  it("neither an uncompilable program nor a throwing check is run, even with a grant", async () => {
    using broken = setup({ policy: "auto", policyProgram: "(", judgeAskProgram: "", grants: [curl] });
    const a = shell("ls");
    broken.enqueue(a);
    using thrown = setup({ policy: "auto", policyProgram: FLOOR, judgeAskProgram: "", grants: [curl] });
    scopes.get(thrown.root).compiledPolicy = () => Promise.reject(new Error("boom"));
    const b = shell("ls");
    thrown.enqueue(b);
    await when(() => a.policyResult !== null && b.policyResult !== null, { timeout: TIMEOUT });
    expect([a, b].map((job) => [job.policyResult, job.licenseDecision, job.policyClasses])).toEqual([
      ["block", false, ["policy-fault"]],
      ["block", false, ["policy-fault"]],
    ]);
  });
});

describe("an unusable classifier program", () => {
  it("an empty program abstains and the failure falls to a person when one is watching", async () => {
    using bag = setup({ policy: "auto", policyProgram: FLOOR, judgeAskProgram: "", unattended: false });
    const j = shell("curl x");
    bag.enqueue(j);
    await when(() => j.classifierAbstain !== null, { timeout: TIMEOUT });
    expect({ policy: j.policyResult, needsHuman: j.needsHuman, decision: j.licenseDecision }).toEqual({
      policy: "ask",
      needsHuman: true,
      decision: null,
    });
    expect(j.classifierAbstain).toContain("classifier program");
    j.humanApprove = true;
    await settled(j);
    expect(j.orchestrationResult).toBe(true);
  });

  it("a comment-only program abstains too", async () => {
    using bag = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ";; nothing here\n",
      unattended: false,
    });
    const j = shell("curl x");
    bag.enqueue(j);
    await when(() => j.classifierAbstain !== null, { timeout: TIMEOUT });
    expect(j.needsHuman).toBe(true);
  });

  it("unattended, an unusable program denies as interaction_required instead of waiting forever", async () => {
    using bag = setup({ policy: "auto", unattended: true, policyProgram: FLOOR, judgeAskProgram: "" });
    const j = shell("curl x");
    bag.enqueue(j);
    await settled(j);
    expect([j.orchestrationResult, j.licenseDetail.code]).toEqual([false, "interaction_required"]);
  });
});
