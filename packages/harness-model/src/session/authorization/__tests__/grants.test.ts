import { describe, expect, it } from "vitest";

import {
  coveringGrants,
  DEFAULT_PROMPT_TTL,
  fencedSubtree,
  type GrantCall,
  type GrantRow,
  type GrantSubject,
  grantLabel,
  grantOptionsFor,
  parseGrantRows,
  parseTtl,
  sameSubject,
  visibleRows,
} from "../grants.js";

const row = (subject: GrantSubject, over: Partial<GrantRow> = {}): GrantRow => ({
  id: `g-${Math.abs(JSON.stringify(subject).length)}`,
  scope: "session",
  scopeKey: "s1",
  subject,
  createdAtMs: 0,
  expiresAtMs: null,
  source: "prompt",
  label: grantLabel(subject),
  ...over,
});

const unit = (argv0: string, spine: string[] = [], familyArgs: string[] = []) => ({ argv0, spine, familyArgs });
const bash = (votes: GrantCall["votes"], over: Partial<GrantCall> = {}): GrantCall => ({
  tier: "ask",
  cluster: "bash",
  hatch: false,
  votes,
  toolName: "shell",
  ...over,
});
const ask = (u: ReturnType<typeof unit>, extra: object = {}) => ({ disposition: "ask", unit: u, ...extra });

describe("coveringGrants", () => {
  const push = row({ kind: "command", argv0: "git", spine: ["push"], args: [] });

  it("a command grant covers its family and any other arguments", () => {
    expect(coveringGrants([push], bash([ask(unit("git", ["push"]))]))).toEqual([push]);
    expect(coveringGrants([push], bash([ask(unit("git", ["pull"]))]))).toBeNull();
    expect(coveringGrants([push], bash([ask(unit("hg", ["push"]))]))).toBeNull();
  });
  it("family_args are part of the family: make deploy is not make test", () => {
    const deploy = row({ kind: "command", argv0: "make", spine: [], args: ["deploy"] });
    expect(coveringGrants([deploy], bash([ask(unit("make", [], ["deploy"]))]))).toEqual([deploy]);
    expect(coveringGrants([deploy], bash([ask(unit("make", [], ["test"]))]))).toBeNull();
    expect(coveringGrants([deploy], bash([ask(unit("make", [], []))]))).toBeNull();
  });
  it("a pipeline needs every ask unit covered", () => {
    const other = row({ kind: "command", argv0: "curl", spine: [], args: [] });
    const votes = [ask(unit("git", ["push"])), ask(unit("curl"))];
    expect(coveringGrants([push], bash(votes))).toBeNull();
    expect(coveringGrants([push, other], bash(votes))).toEqual([push, other]);
  });
  it("never covers a lifted ask (env prefix, xargs, non-literal, unparsed)", () => {
    for (const lift of ["env", "xargs", "nonliteral", "unparsed", "overflow", "readings"]) {
      expect(coveringGrants([push], bash([ask(unit("git", ["push"]), { lift })]))).toBeNull();
    }
  });
  it("never covers a hatch, a soft-deny, a block or an approve", () => {
    const votes = [ask(unit("git", ["push"]))];
    expect(coveringGrants([push], bash(votes, { hatch: true }))).toBeNull();
    for (const tier of ["deny", "block", "policyApprove", null] as const) {
      expect(coveringGrants([push], bash(votes, { tier }))).toBeNull();
    }
  });
  it("a redirect needs its own path grant", () => {
    const echo = row({ kind: "command", argv0: "echo", spine: [], args: [] });
    const redirect = { disposition: "ask", path: { cluster: "write" as const, path: "out.txt" } };
    expect(coveringGrants([echo], bash([ask(unit("echo")), redirect]))).toBeNull();
    const path = row({ kind: "path", cluster: "write", path: "out.txt", depth: "exact" });
    expect(coveringGrants([echo, path], bash([ask(unit("echo")), redirect]))).toEqual([echo, path]);
  });
  it("path grants: exact vs subtree, cluster-bound, fenced", () => {
    const exact = row({ kind: "path", cluster: "write", path: "src/a.ts", depth: "exact" });
    const tree = row({ kind: "path", cluster: "write", path: "src/lib", depth: "subtree" });
    const call = (path: string, cluster: "read" | "write" = "write"): GrantCall => ({
      tier: "ask",
      cluster,
      hatch: false,
      toolName: "write_file",
      votes: [{ disposition: "ask", path: { cluster, path } }],
    });
    expect(coveringGrants([exact], call("src/a.ts"))).toEqual([exact]);
    expect(coveringGrants([exact], call("src/a.ts/b"))).toBeNull();
    expect(coveringGrants([tree], call("src/lib/x/y.ts"))).toEqual([tree]);
    expect(coveringGrants([tree], call("src/library/x.ts"))).toBeNull();
    expect(coveringGrants([tree], call("src/lib/x.ts", "read"))).toBeNull();
    const fenced = row({ kind: "path", cluster: "write", path: "src", depth: "subtree" });
    expect(coveringGrants([fenced], call("src/a.ts"))).toBeNull();
  });
  it("mcp grants match server, account and tool; a tool grant matches an unattributed tool", () => {
    const grant = row({ kind: "mcp", server: "gmail", account: "work", tool: "send" });
    const call = (account: string, tool = "send"): GrantCall => ({
      tier: "ask",
      cluster: "mcp",
      hatch: false,
      votes: [],
      toolName: "mcp__gmail__send",
      mcp: { server: "gmail", account, tool },
    });
    expect(coveringGrants([grant], call("work"))).toEqual([grant]);
    expect(coveringGrants([grant], call("home"))).toBeNull();
    expect(coveringGrants([grant], call("work", "delete"))).toBeNull();
    const tool = row({ kind: "tool", name: "web_extract" });
    expect(
      coveringGrants([tool], { tier: "ask", cluster: "mcp", hatch: false, votes: [], toolName: "web_extract" }),
    ).toEqual([tool]);
  });
});

describe("grantOptionsFor", () => {
  it("offers the single ask family, never for soft-deny, hatch or lifted asks", () => {
    const votes = [ask(unit("npm", ["run"], ["build"]))];
    expect(grantOptionsFor(bash(votes)).map((o) => o.subject)).toEqual([
      { kind: "command", argv0: "npm", spine: ["run"], args: ["build"] },
    ]);
    expect(grantOptionsFor(bash(votes, { tier: "deny" }))).toEqual([]);
    expect(grantOptionsFor(bash(votes, { tier: "block" }))).toEqual([]);
    expect(grantOptionsFor(bash(votes, { hatch: true }))).toEqual([]);
    expect(grantOptionsFor(bash([ask(unit("npm"), { lift: "env" })]))).toEqual([]);
  });
  it("offers nothing for a pipeline of two families", () => {
    expect(grantOptionsFor(bash([ask(unit("git", ["push"])), ask(unit("curl"))]))).toEqual([]);
    expect(grantOptionsFor(bash([ask(unit("git", ["push"])), ask(unit("git", ["push"]))])).length).toBe(1);
  });
  it("a path ask offers exact plus an unfenced parent", () => {
    const options = grantOptionsFor({
      tier: "ask",
      cluster: "write",
      hatch: false,
      toolName: "write_file",
      votes: [{ disposition: "ask", path: { cluster: "write", path: "src/lib/a.ts" } }],
    });
    expect(options.map((o) => o.subject)).toEqual([
      { kind: "path", cluster: "write", path: "src/lib/a.ts", depth: "exact" },
      { kind: "path", cluster: "write", path: "src/lib", depth: "subtree" },
    ]);
    const top = grantOptionsFor({
      tier: "ask",
      cluster: "write",
      hatch: false,
      toolName: "write_file",
      votes: [{ disposition: "ask", path: { cluster: "write", path: "a.ts" } }],
    });
    expect(top).toHaveLength(1);
  });
  it("an MCP call offers server, account and tool", () => {
    const options = grantOptionsFor({
      tier: "ask",
      cluster: "mcp",
      hatch: false,
      votes: [],
      toolName: "mcp__gmail__send",
      mcp: { server: "gmail", account: "work", tool: "send" },
    });
    expect(options.map((o) => o.subject)).toEqual([{ kind: "mcp", server: "gmail", account: "work", tool: "send" }]);
  });
});

describe("ttl, scope visibility and fences", () => {
  it("parses durations; prompt defaults are 7 days except session", () => {
    expect(parseTtl("7d")).toBe(7 * 86_400_000);
    expect(parseTtl("90m")).toBe(5_400_000);
    expect(parseTtl(null)).toBeNull();
    expect(parseTtl("soon")).toBeNull();
    expect(DEFAULT_PROMPT_TTL).toEqual({ session: null, project: "7d", bot: "7d", global: "7d" });
  });
  it("expired rows are invisible; scopes isolate", () => {
    const subject: GrantSubject = { kind: "tool", name: "x" };
    const rows = [
      row(subject, { id: "mine", scope: "session", scopeKey: "s1" }),
      row(subject, { id: "other-session", scope: "session", scopeKey: "s2" }),
      row(subject, { id: "proj", scope: "project", scopeKey: "/p" }),
      row(subject, { id: "other-proj", scope: "project", scopeKey: "/q" }),
      row(subject, { id: "bot", scope: "bot", scopeKey: "helper" }),
      row(subject, { id: "glob", scope: "global", scopeKey: "" }),
      row(subject, { id: "old", scope: "global", scopeKey: "", expiresAtMs: 5 }),
    ];
    const ids = (who: { sessionId: string; projectPath: string; bot?: string }) =>
      visibleRows(rows, who, 10).map((r) => r.id);
    expect(ids({ sessionId: "s1", projectPath: "/p" })).toEqual(["mine", "proj", "glob"]);
    expect(ids({ sessionId: "s1", projectPath: "/p", bot: "helper" })).toEqual(["mine", "proj", "bot", "glob"]);
    expect(visibleRows(rows, { sessionId: "s1", projectPath: "/p" }, 1).map((r) => r.id)).toContain("old");
  });
  it("fences root-like subtrees except an explicit write of the workspace", () => {
    for (const p of [".", "/", "/Users", "src", "~", "$HOME"]) expect(fencedSubtree("read", p)).toBe(true);
    expect(fencedSubtree("write", ".")).toBe(false);
    expect(fencedSubtree("read", "/Users/me/project")).toBe(false);
    expect(fencedSubtree("read", "src/lib")).toBe(false);
  });
  it("subjects compare regardless of key order; bad rows are dropped", () => {
    expect(
      sameSubject({ kind: "command", argv0: "a", spine: [], args: [] }, {
        args: [],
        spine: [],
        argv0: "a",
        kind: "command",
      } as GrantSubject),
    ).toBe(true);
    expect(parseGrantRows("not json")).toEqual([]);
    expect(parseGrantRows('[{"id":1}]')).toEqual([]);
    expect(parseGrantRows("")).toEqual([]);
  });
});
