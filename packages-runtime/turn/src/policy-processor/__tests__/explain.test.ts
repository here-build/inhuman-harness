/**
 * policy/explain asks the same code the real license path asks. For each probe the outcome it reports
 * must equal what a real leaf does in the same session: runs, denied, prompts, or goes to a judge.
 */
import type { GrantRow } from "@inhuman.tools/harness-model";
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { explainCall, type ExplainProbe } from "../explain.js";
import { scopes } from "../scope.js";
import { read, shell, TIMEOUT, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = reasonableDefaultsSource;
const MODES = ["manual", "auto", "yolo"] as const;

type Case = { readonly name: string; readonly probe: ExplainProbe; readonly job: () => ReturnType<typeof shell> };
const CASES: Case[] = [
  { name: "ls", probe: { kind: "shell", command: "ls" }, job: () => shell("ls") },
  { name: "npm test (ask)", probe: { kind: "shell", command: "npm test" }, job: () => shell("npm test") },
  {
    name: "npm publish (soft-deny)",
    probe: { kind: "shell", command: "npm publish" },
    job: () => shell("npm publish"),
  },
  { name: "sudo (soft-deny privilege)", probe: { kind: "shell", command: "sudo ls" }, job: () => shell("sudo ls") },
  { name: "cat .env (block)", probe: { kind: "shell", command: "cat .env" }, job: () => shell("cat .env") },
  {
    name: "cat .e{nv,x} (block by brace)",
    probe: { kind: "shell", command: "cat .e{nv,x}" },
    job: () => shell("cat .e{nv,x}"),
  },
  { name: "rm -rf / (block)", probe: { kind: "shell", command: "rm -rf /" }, job: () => shell("rm -rf /") },
  { name: "read outside", probe: { kind: "path", cluster: "read", path: "/etc/hosts" }, job: () => read("/etc/hosts") },
  { name: "write in tree", probe: { kind: "path", cluster: "write", path: "src/a.ts" }, job: () => write("src/a.ts") },
  {
    name: "write lockfile",
    probe: { kind: "path", cluster: "write", path: "pnpm-lock.yaml" },
    job: () => write("pnpm-lock.yaml"),
  },
  {
    name: "write hook (block)",
    probe: { kind: "path", cluster: "write", path: ".git/hooks/pre-commit" },
    job: () => write(".git/hooks/pre-commit"),
  },
];

function observed(job: ReturnType<typeof shell>): string {
  if (job.policyResult === "block") return "blocked";
  if (job.policyResult === "policyApprove") return "runs";
  if (job.licenseDecision === true) return "runs";
  if (job.licenseDecision === false) return "denied";
  if (job.needsHuman) return "prompts-you";
  if (job.autoClassifierPending) return job.judgeKind === "soft-deny" ? "judge-soft-deny" : "judge-ask";
  return `waiting:${job.policyResult}`;
}

describe("explain parity with the real path", () => {
  for (const mode of MODES) {
    for (const unattended of [false, true]) {
      if (unattended && mode === "manual") continue;
      it(`${mode}${unattended ? " unattended" : ""}`, async () => {
        for (const c of CASES) {
          using bag = setup({ policy: mode, unattended, policyProgram: FLOOR, judgeAskProgram: "" });
          const job = c.job();
          bag.enqueue(job);
          await when(() => job.policyResult !== null, { timeout: TIMEOUT });
          const explained = await explainCall(scopes.get(bag.root), c.probe, { mode, unattended });
          const real = observed(job);
          // The classifier program here is empty, so a judged call has fallen through to the cell's
          // fail policy by the time we look: a person when watching, a denial when unattended.
          const allowed = new Set<string>([explained.outcome]);
          if (explained.outcome.startsWith("judge")) allowed.add(unattended ? "denied" : "prompts-you");
          expect([c.name, allowed.has(real)]).toEqual([c.name, true]);
          expect([c.name, explained.tier]).toEqual([
            c.name,
            { block: "block", deny: "soft-deny", ask: "ask", policyApprove: "allow" }[job.policyResult!],
          ]);
        }
      });
    }
  }
});

describe("explain: what it says", () => {
  it("names tier, classes, rules and resolver; a soft-deny is not grantable", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    const out = await explainCall(scopes.get(bag.root), { kind: "shell", command: "npm publish" });
    expect(out).toMatchObject({
      tier: "soft-deny",
      outcome: "prompts-you",
      resolver: { kind: "human", layer: "dist" },
      grant: null,
      grantable: [],
    });
    expect(out.classes).toEqual([{ id: "publish", label: "Publishes" }]);
    expect(out.votes[0]).toMatchObject({ tier: "soft-deny", class: "publish", ruleId: "bash:npm/publish" });
    expect(out.reason).toContain("nothing is remembered");
  });

  it("an ask offers its family and reports the grant that covers it", async () => {
    const grant: GrantRow = {
      id: "g1",
      scope: "session",
      scopeKey: "s-lic",
      subject: { kind: "command", argv0: "make", spine: [], args: ["deploy"] },
      createdAtMs: 0,
      expiresAtMs: null,
      source: "prompt",
      label: "`make deploy`",
    };
    using bag = setup({ policy: "manual", policyProgram: FLOOR });
    const before = await explainCall(scopes.get(bag.root), { kind: "shell", command: "make deploy" });
    expect(before).toMatchObject({ tier: "ask", grant: null, outcome: "prompts-you" });
    expect(before.grantable).toEqual([{ kind: "command", argv0: "make", spine: [], args: ["deploy"] }]);
    bag.root.replaceGrantsJson(JSON.stringify([grant]));
    const after = await explainCall(scopes.get(bag.root), { kind: "shell", command: "make deploy" });
    expect(after).toMatchObject({ outcome: "runs", grant: { id: "g1" } });
    // another family is not covered
    const other = await explainCall(scopes.get(bag.root), { kind: "shell", command: "make test" });
    expect(other.outcome).toBe("prompts-you");
    // a grant never changes a soft-deny
    const soft = await explainCall(scopes.get(bag.root), { kind: "shell", command: "sudo make deploy" });
    expect(soft.tier).toBe("soft-deny");
    expect(soft.grant).toBeNull();
  });

  it("a block is blocked in yolo too, and says nothing lifts it", async () => {
    using bag = setup({ policy: "yolo", policyProgram: FLOOR });
    const out = await explainCall(scopes.get(bag.root), { kind: "shell", command: "cat .e{nv,x}" });
    expect(out).toMatchObject({ tier: "block", outcome: "blocked", resolver: null });
    expect(out.classes).toEqual([{ id: "credential", label: "Touches credentials" }]);
    expect(out.reason).toContain("Nothing lifts a block");
  });

  it("an MCP probe is classified by name and carries the account", async () => {
    using bag = setup({
      policy: "manual",
      policyProgram: FLOOR,
      user: { rules: [{ match: { mcp: "gmail", account: "work", tool: "send_email" }, resolve: { manual: "deny" } }] },
    });
    const send = await explainCall(scopes.get(bag.root), {
      kind: "mcp",
      server: "gmail",
      account: "work",
      tool: "send_email",
    });
    expect(send).toMatchObject({ tier: "ask", outcome: "denied", resolver: { kind: "deny", layer: "user" } });
    expect(send.classes[0]?.id).toBe("mcp-action");
    const lookup = await explainCall(scopes.get(bag.root), {
      kind: "mcp",
      server: "gmail",
      account: "home",
      tool: "list_threads",
    });
    expect(lookup.classes[0]?.id).toBe("mcp-lookup");
    expect(lookup.outcome).toBe("prompts-you");
  });

  it("an invalid policy blocks everything and says so", async () => {
    using bag = setup({ policy: "manual", policyProgram: "(not json" });
    const out = await explainCall(scopes.get(bag.root), { kind: "shell", command: "ls" });
    expect(out).toMatchObject({ tier: "block", outcome: "blocked" });
    expect(out.classes[0]?.id).toBe("policy-fault");
  });

  it("session read roots make an outside folder an in-workspace read", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, readRoots: ["/opt/shared"] });
    const out = await explainCall(scopes.get(bag.root), { kind: "path", cluster: "read", path: "/opt/shared/a.txt" });
    expect(out).toMatchObject({ tier: "allow", outcome: "runs" });
    const outside = await explainCall(scopes.get(bag.root), {
      kind: "path",
      cluster: "read",
      path: "/opt/other/a.txt",
    });
    expect(outside.tier).toBe("soft-deny");
  });
});
