import { describe, expect, it } from "vitest";

import { filterMcpToolNames } from "../tool-filter.js";

const NAMES = ["get_issue", "list_issues", "write_file", "merge_pull_request", "get_secret"] as const;

describe("MCP tools globs", () => {
  it.each([
    { name: "missing field admits all", rules: undefined, keep: [...NAMES] },
    { name: "malformed field admits all", rules: "get_*", keep: [...NAMES] },
    { name: "empty list admits none", rules: [], keep: [] },
    { name: "star admits all", rules: ["*"], keep: [...NAMES] },
    {
      name: "only excludes imply star",
      rules: ["!write_*", "!merge_*"],
      keep: ["get_issue", "list_issues", "get_secret"],
    },
    {
      name: "include then exclude",
      rules: ["get_*", "!get_secret"],
      keep: ["get_issue"],
    },
    {
      name: "explicit includes ignore unlisted",
      rules: ["get_*", "!write_*"],
      keep: ["get_issue", "get_secret"],
    },
    {
      name: "order can re-admit",
      rules: ["*", "!merge_*", "merge_pull_request"],
      keep: [...NAMES],
    },
    {
      name: "later exclude wins",
      rules: ["*", "merge_*", "!merge_*"],
      keep: ["get_issue", "list_issues", "write_file", "get_secret"],
    },
    {
      name: "question mark is one char",
      rules: ["get_?????"],
      keep: ["get_issue"],
    },
    {
      name: "server name is case-sensitive",
      rules: ["get_*"],
      names: ["get_issue", "Get_issue"],
      keep: ["get_issue"],
    },
    {
      name: "only-exclude matches the server name",
      rules: ["!merge_*"],
      names: ["merge_pull_request", "get_issue"],
      keep: ["get_issue"],
    },
  ])("$name", ({ rules, names = NAMES, keep }) => {
    expect(filterMcpToolNames(names, rules)).toEqual(keep);
  });
});
