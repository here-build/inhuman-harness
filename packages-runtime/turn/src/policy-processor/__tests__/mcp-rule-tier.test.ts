/**
 * Per-server, per-tool granularity: a rule `{match: {mcp, tool}, tier, describe}` moves the floor tier of
 * the call and gives the judge the owner's words. The real path and `policy/explain` must agree.
 */
import { MCPToolJob, McpToolExpectation, SystemToolJob } from "@inhuman.tools/harness-model";
import { reasonableDefaultsSource } from "@inhuman.tools/policy/floor";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { explainCall } from "../explain.js";
import { scopes } from "../scope.js";
import { buildSoftDenySections } from "../soft-deny.js";
import { TIMEOUT } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = reasonableDefaultsSource;
const PROBE = { kind: "mcp", server: "kley", tool: "delete_table" } as const;
const rules = (tier: string | undefined, describe?: string) => ({
  rules: [{ match: { mcp: "kley", tool: "delete_table" }, ...(tier === undefined ? {} : { tier }), ...(describe === undefined ? {} : { describe }) }],
});

function kleyTool(name = "delete_table"): SystemToolJob {
  return new SystemToolJob({ toolCallId: `k-${name}`, name, mcpServer: "kley", argsJson: JSON.stringify({ id: "t1" }) });
}

describe("explain with a rule tier", () => {
  it("soft-deny: the tier moves, the class stays the name-based one, nothing is grantable", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, user: rules("soft-deny", "drops a table and its rows") });
    const out = await explainCall(scopes.get(bag.root), PROBE);
    expect(out).toMatchObject({ tier: "soft-deny", outcome: "prompts-you", grant: null, grantable: [] });
    expect(out.classes[0]?.id).toBe("mcp-action");
    expect(out.reason).toContain("nothing is remembered");
    // a sibling tool of the same server is untouched
    const other = await explainCall(scopes.get(bag.root), { ...PROBE, tool: "list_tables" });
    expect(other).toMatchObject({ tier: "ask" });
    expect(other.grantable).toHaveLength(1);
  });

  it("allow runs; block is blocked in yolo too", async () => {
    using allow = setup({ policy: "manual", policyProgram: FLOOR, user: rules("allow") });
    expect(await explainCall(scopes.get(allow.root), PROBE)).toMatchObject({ tier: "allow", outcome: "runs" });
    using block = setup({ policy: "yolo", policyProgram: FLOOR, user: rules("block") });
    expect(await explainCall(scopes.get(block.root), PROBE)).toMatchObject({ tier: "block", outcome: "blocked" });
  });

  it("a project file cannot loosen, but can tighten", async () => {
    using loosen = setup({ policy: "manual", policyProgram: FLOOR, project: JSON.stringify(rules("allow")) });
    expect((await explainCall(scopes.get(loosen.root), PROBE)).tier).toBe("ask");
    using tighten = setup({ policy: "manual", policyProgram: FLOOR, project: JSON.stringify(rules("block")) });
    expect((await explainCall(scopes.get(tighten.root), PROBE)).tier).toBe("block");
  });
});

describe("the real path", () => {
  it("a SystemToolJob under a server matches {mcp, tool} rules and stamps the rule's tier", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, user: rules("soft-deny", "drops a table") });
    const job = kleyTool();
    expect(job.callSubject).toMatchObject({ mcp: { server: "kley", account: "kley", tool: "delete_table" } });
    bag.enqueue(job);
    await when(() => job.policyResult !== null, { timeout: TIMEOUT });
    expect(job.policyResult).toBe("deny");
    expect(job.grantOptions).toEqual([]);
    expect(job.policyClasses).toEqual(["mcp-action"]);
  });

  it("without a server the same name does not match the {mcp, tool} rule", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, user: rules("block") });
    const job = new SystemToolJob({ toolCallId: "plain", name: "delete_table", argsJson: "{}" });
    expect(job.callSubject.mcp).toBeUndefined();
    bag.enqueue(job);
    await when(() => job.policyResult !== null, { timeout: TIMEOUT });
    expect(job.policyResult).toBe("ask");
  });

  it("an MCPToolJob follows the same rule; allow runs without a prompt", async () => {
    using bag = setup({ policy: "manual", policyProgram: FLOOR, user: rules("allow") });
    const job = new MCPToolJob({
      toolCallId: "m",
      name: "mcp__kley__delete_table",
      argsJson: "{}",
      connectionKey: "kley",
      serverToolName: "delete_table",
      expectation: new McpToolExpectation({ connectionId: "kley", serverToolName: "delete_table", argsJson: "{}" }),
    });
    bag.enqueue(job);
    await when(() => job.policyResult !== null, { timeout: TIMEOUT });
    expect(job.policyResult).toBe("policyApprove");
  });
});

describe("the judge sees the description", () => {
  it("soft-deny floor section carries ownerDescription, on one line", () => {
    const s = buildSoftDenySections({
      classes: ["mcp-action"],
      votes: [{ ruleId: "host:mcp-rule:soft-deny" }],
      userMessages: ["delete the table"],
      agentAnswer: "",
      allowAgentAnswer: false,
      tool: "delete_table",
      cluster: "mcp",
      args: {},
      describe: "drops a table\nand its rows",
    });
    expect(s.floorJson).not.toContain("\n");
    expect(JSON.parse(s.floorJson)).toMatchObject({ ownerDescription: "drops a table\nand its rows" });
    const none = buildSoftDenySections({ ...{ classes: [], votes: [], userMessages: [], agentAnswer: "", allowAgentAnswer: false, tool: "t", cluster: "mcp", args: {} } });
    expect(JSON.parse(none.floorJson)).not.toHaveProperty("ownerDescription");
  });
});
