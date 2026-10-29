import { describe, expect, it } from "vitest";

import { classifyMcpToolName, mcpReadFloorAllows } from "../mcp-name-floor.js";

describe("MCP name floor", () => {
  it.each([
    ["get_issue", "stem"],
    ["list_trash", "stem"],
    ["read_reply", "stem"],
    ["query-docs", "stem"],
    ["log_missed_query", "stem"],
    ["get_or_create", "veto"],
    ["create_or_update_file", "veto"],
    ["merge_pull_request", "veto"],
    ["query-graphql", "graphql"],
    ["queryGraphQL", "graphql"],
    ["run_graphql_query", "graphql"],
    ["reply", "one_word"],
    ["ForwardTrash", "one_word"],
    ["write_and_reply", "one_word"],
    ["Gmail_ForwardEmail", "middle"],
    ["issue_write", "middle"],
    ["awaitReply", "middle"],
    ["mark_all_notifications_read", "stem"],
    ["browser_click", "middle"],
  ] as const)("%s → %s", (name, verdict) => {
    expect(classifyMcpToolName(name).verdict).toBe(verdict);
    expect(mcpReadFloorAllows(name)).toBe(verdict === "stem");
  });
});

describe("MCP name floor: a read word beside a mutating word is not a look-up", () => {
  it.each([
    "query_and_drop_table",
    "find_and_kill_process",
    "transfer_funds_and_get_receipt",
    "search_and_replace",
    "fetchAndExec",
    "getAndPost",
    "list_then_terminate_instances",
    "read_and_overwrite",
    "run_query",
    "query",
    "get_and_publish",
    "list_and_deploy",
  ])("%s never auto-runs on a stem", (name) => {
    expect(mcpReadFloorAllows(name)).toBe(false);
  });

  it.each(["get_issue", "list_pull_requests", "search_code", "fetch_url", "find_references", "query-docs"])(
    "%s still reads",
    (name) => {
      expect(mcpReadFloorAllows(name)).toBe(true);
    },
  );
});
