import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { ResponseCallOrder, type CallOrderFacts } from "../call-order.js";
import { McpToolExpectation } from "../expectations/McpToolExpectation.js";
import { WebSearchExpectation } from "../expectations/WebSearchExpectation.js";
import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { MCPToolJob } from "../jobs/MCPToolJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { WebSearchToolJob } from "../jobs/WebSearchToolJob.js";

const REMOTE = new Set(["github", "linear"]);
const classes: Record<string, string> = {
  mcp__github__get_issue: "read",
  mcp__github__list_issues: "read",
  mcp__github__create_issue: "write",
  mcp__linear__get_issue: "read",
  mcp__linear__create_issue: "write",
  mcp__local__get_file: "read",
  mcp__local__write_file: "write",
};

const facts: CallOrderFacts = {
  entryClass: (name) => classes[name],
  remoteMcp: (key) => REMOTE.has(key),
};

const system = (name: string, args?: Record<string, unknown>) =>
  new SystemToolJob({ toolCallId: name, name, ...(args == null ? {} : { argsJson: JSON.stringify(args) }) });

function mcp(connectionKey: string, serverToolName: string): MCPToolJob {
  return new MCPToolJob({
    toolCallId: `${connectionKey}/${serverToolName}`,
    name: `mcp__${connectionKey}__${serverToolName}`,
    connectionKey,
    serverToolName,
    expectation: new McpToolExpectation({ connectionId: connectionKey }),
  });
}

/** Place the calls in response order and return each one's predecessors. */
function orderOf(...jobs: Array<SystemToolJob | MCPToolJob | ProgrammaticJob | WebSearchToolJob | AgentCallJob>) {
  const order = new ResponseCallOrder(facts);
  for (const job of jobs) order.place(job);
  return jobs.map((job) => [...job.after]);
}

describe("response call order", () => {
  beforeEach(() => resetLocalIDs());

  it("runs shell, edit, shell in response order", () => {
    const first = system("shell");
    const edit = system("edit_file");
    const last = system("shell");
    expect(orderOf(first, edit, last)).toEqual([[], [first], [first, edit]]);
  });

  it("puts writes, local MCP, and Scheme programs on the same chain as shell", () => {
    const shell = system("shell");
    const write = system("write_file");
    const local = mcp("local", "get_file");
    const program = new ProgrammaticJob({ toolName: "scheme_repl" });
    expect(orderOf(shell, write, local, program)).toEqual([[], [shell], [shell, write], [shell, write, local]]);
  });

  it("lets two read-only calls to one remote server run together", () => {
    const a = mcp("github", "get_issue");
    const b = mcp("github", "list_issues");
    expect(orderOf(a, b)).toEqual([[], []]);
  });

  it("makes a write wait for an earlier read to the same server", () => {
    const read = mcp("github", "get_issue");
    const write = mcp("github", "create_issue");
    expect(orderOf(read, write)).toEqual([[], [read]]);
  });

  it("makes a read wait for an earlier write to its server, and later writes wait for everything", () => {
    const read1 = mcp("github", "get_issue");
    const write = mcp("github", "create_issue");
    const read2 = mcp("github", "list_issues");
    const write2 = mcp("github", "create_issue");
    expect(orderOf(read1, write, read2, write2)).toEqual([[], [read1], [write], [read1, write, read2]]);
  });

  it("does not order calls to different servers", () => {
    const github = mcp("github", "create_issue");
    const linear = mcp("linear", "create_issue");
    const github2 = mcp("github", "create_issue");
    expect(orderOf(github, linear, github2)).toEqual([[], [], [github]]);
  });

  it("keeps remote servers and the local chain independent of each other", () => {
    const shell = system("shell");
    const remote = mcp("github", "create_issue");
    const edit = system("edit_file");
    expect(orderOf(shell, remote, edit)).toEqual([[], [], [shell]]);
  });

  it("leaves read-only built-ins, web, and agent calls unordered", () => {
    const shell = system("shell");
    const read = system("read_file");
    const grep = system("grep");
    const search = new WebSearchToolJob({
      toolCallId: "w",
      name: "web_search",
      expectation: new WebSearchExpectation({ connectionId: "web_search" }),
    });
    const agent = new AgentCallJob({ toolCallId: "a", name: "agent__ask" });
    expect(orderOf(shell, read, grep, search, agent)).toEqual([[], [], [], [], []]);
  });

  it("treats an unnamed or mutating-looking remote tool as not read-only", () => {
    classes.mcp__github__sync = "read";
    classes.mcp__github__delete_issue = "read";
    const a = mcp("github", "sync");
    const b = mcp("github", "get_issue");
    const c = mcp("github", "delete_issue");
    // `sync` has no look-up stem; `delete_issue` is vetoed by the name floor even with class read.
    expect(orderOf(a, b, c)).toEqual([[], [a], [a, b]]);
  });

  it("treats a remote tool the catalog does not know as not read-only", () => {
    const unknown = mcp("github", "get_thing");
    const known = mcp("github", "get_issue");
    expect(orderOf(unknown, known)).toEqual([[], [unknown]]);
  });

  it("treats an unknown connection as local, and an unknown built-in as not read-only", () => {
    const shell = system("shell");
    const stranger = mcp("elsewhere", "get_file");
    const odd = system("frobnicate");
    expect(orderOf(shell, stranger, odd)).toEqual([[], [shell], [shell, stranger]]);
  });

  it("does not wait on a call that was sealed at admission", () => {
    const refused = new SystemToolJob({ toolCallId: "r", name: "shell", completed: true });
    const next = system("shell");
    expect(orderOf(refused, next)).toEqual([[], []]);
  });

  describe("a path read after a write to the same path", () => {
    it("waits for an earlier edit or write of that path, and only those", () => {
      const edit = system("edit_file", { path: "src/a.ts" });
      const other = system("write_file", { path: "src/b.ts" });
      const read = system("read_file", { path: "src/a.ts" });
      expect(orderOf(edit, other, read)).toEqual([[], [edit], [edit]]);
    });

    it("treats a directory read and a file inside it as the same path", () => {
      const edit = system("edit_file", { path: "/repo/src/a.ts" });
      const grep = system("grep", { path: "/repo/src", pattern: "x" });
      const sibling = system("list_dir", { path: "/repo/srcs" });
      expect(orderOf(edit, grep, sibling)).toEqual([[], [edit], []]);
    });

    it("lets a glob or a default-path grep wait for any earlier write", () => {
      const edit = system("edit_file", { path: "/repo/a.ts" });
      const glob = system("glob", { pattern: "**/*.ts" });
      expect(orderOf(edit, glob)).toEqual([[], [edit]]);
    });

    it("does not let a read run before a write it cannot compare with", () => {
      const edit = system("write_file", { path: "a.ts" });
      const read = system("read_file", { path: "/repo/a.ts" });
      expect(orderOf(edit, read)).toEqual([[], [edit]]);
    });

    it("does not wait for a later write, or for shell, or for a read of another path", () => {
      const shell = system("shell");
      const read = system("read_file", { path: "a.ts" });
      const later = system("edit_file", { path: "a.ts" });
      const elsewhere = system("read_file", { path: "b.ts" });
      expect(orderOf(shell, read, later, elsewhere)).toEqual([[], [], [shell], []]);
    });

    it("normalizes dot segments", () => {
      const edit = system("edit_file", { path: "src/./x/../a.ts" });
      const read = system("read_file", { path: "src/a.ts" });
      expect(orderOf(edit, read)).toEqual([[], [edit]]);
    });
  });
});
