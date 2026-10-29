import { MCPToolJob, McpToolExpectation } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { formatMcpArgs, mcpConfirmViewport, mcpIdentity, parseMcpWireName, splitName } from "../mcp-identity.js";

test.each([
  ["Gmail_GetEmail", ["gmail", "get", "email"]],
  ["browser_click", ["browser", "click"]],
  ["queryGraphQL", ["query", "graphql"]],
  ["GetEmailByID", ["get", "email", "by", "id"]],
] as const)("splitName matches the catalog name-floor grain (%s)", (input, parts) => {
  expect(splitName(input)).toEqual([...parts]);
});

test.each([
  {
    name: "gmail get",
    job: { name: "mcp__gmail__Gmail_GetEmail", connectionKey: "gmail", serverToolName: "Gmail_GetEmail" },
    id: { server: "Gmail", action: "get email" },
  },
  {
    name: "arcade prefix",
    job: { name: "mcp__gmail__Arcade_ListApps", connectionKey: "gmail", serverToolName: "Arcade_ListApps" },
    id: { server: "Gmail", action: "arcade list apps" },
  },
  {
    name: "playwright",
    job: { name: "mcp__playwright__browser_click", connectionKey: "playwright", serverToolName: "browser_click" },
    id: { server: "Playwright", action: "browser click" },
  },
  {
    name: "github",
    job: { name: "mcp__github__actions_get", connectionKey: "github", serverToolName: "actions_get" },
    id: { server: "GitHub", action: "actions get" },
  },
  {
    name: "GraphQL",
    job: { connectionKey: "linear", serverToolName: "queryGraphQL" },
    id: { server: "Linear", action: "query GraphQL" },
  },
  {
    name: "ID",
    job: { connectionKey: "mail", serverToolName: "GetEmailByID" },
    id: { server: "Mail", action: "get email by ID" },
  },
])("mcpIdentity dims the connection ($name)", ({ job, id }) => {
  expect(
    mcpIdentity(
      new MCPToolJob({
        ...job,
        expectation: new McpToolExpectation({
          connectionId: job.connectionKey,
          serverToolName: job.serverToolName,
        }),
      }),
    ),
  ).toEqual(id);
});

test("mcpIdentity reads the wire name when job fields are empty", () => {
  expect({
    parsed: parseMcpWireName("mcp__mail__search"),
    identity: mcpIdentity(
      new MCPToolJob({
        name: "mcp__mail__search",
        expectation: new McpToolExpectation({ connectionId: "mcp" }),
      }),
    ),
  }).toEqual({
    parsed: { server: "mail", tool: "search" },
    identity: { server: "Mail", action: "search" },
  });
});

test("mcpConfirmViewport is 70vh minus three composer rows", () => {
  expect({
    24: mcpConfirmViewport(24),
    10: mcpConfirmViewport(10),
    5: mcpConfirmViewport(5),
  }).toEqual({ 24: 13, 10: 4, 5: 1 });
});

test("formatMcpArgs dumps options without a JSON wall for scalars", () => {
  expect({
    none: formatMcpArgs(null),
    empty: formatMcpArgs({}),
    scalar: formatMcpArgs({ email_id: "18c2a1b0f3e4d5c6" }),
    mixed: formatMcpArgs({
      recipient: "ada@example.com",
      body: "Hi Ada,\n\nInvoice attached.",
      cc: ["bookkeeping@here.build"],
    }),
  }).toEqual({
    none: "",
    empty: "",
    scalar: "email_id  18c2a1b0f3e4d5c6",
    mixed: ["recipient  ada@example.com", "body", "Hi Ada,\n\nInvoice attached.", "cc  bookkeeping@here.build"].join(
      "\n",
    ),
  });
});
