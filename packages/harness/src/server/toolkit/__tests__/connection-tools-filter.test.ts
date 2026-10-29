import { SessionRoot } from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import { McpConnectionToolCatalogHost } from "@/runtime";
import { bindSessionCatalog } from "@/tool-catalog";

import { KernelToolCatalog, sessionCatalog } from "../tool-table.js";

function listed(...names: string[]) {
  return names.map((serverToolName) => ({
    serverToolName,
    parameters: { type: "object", properties: {} },
    class: "effect",
  }));
}

function mcpConnection(opts: { configuration?: Record<string, unknown>; live?: Record<string, unknown> }) {
  const spec = new ConnectionSpec({ driver: new DriverSpec({ abilityClaim: ["mcp"] }) });
  if (opts.configuration !== undefined) spec.configuration = opts.configuration;
  if (opts.live !== undefined) spec.live = opts.live;
  return spec;
}

describe("MCP catalog tools filter", () => {
  it("overlay/filter: hide excluded, only-exclude, toolSeverity, session toolBlocklist", () => {
    const excludedCatalog = new KernelToolCatalog();
    using excludedHost = new McpConnectionToolCatalogHost(excludedCatalog, {
      github: mcpConnection({
        configuration: { command: "npx", tools: ["get_*", "list_*", "!get_secret"] },
        live: { tools: listed("get_issue", "list_issues", "get_secret", "merge_pull_request") },
      }),
    });

    const onlyExcludeCatalog = new KernelToolCatalog();
    using onlyExcludeHost = new McpConnectionToolCatalogHost(onlyExcludeCatalog, {
      mail: mcpConnection({
        configuration: { tools: ["!send_*"] },
        live: { tools: listed("search", "send_message") },
      }),
      mute: mcpConnection({
        configuration: { tools: [] },
        live: { tools: listed("ping") },
      }),
    });

    const severityCatalog = new KernelToolCatalog();
    using severityHost = new McpConnectionToolCatalogHost(severityCatalog, {
      github: mcpConnection({
        configuration: {
          toolSeverity: {
            get_issue: "view",
            mark_all_notifications_read: "effect",
            merge_pull_request: "irreversible-effect",
          },
        },
        live: {
          tools: [
            { serverToolName: "get_issue", parameters: {}, class: "write" },
            { serverToolName: "mark_all_notifications_read", parameters: {}, class: "read" },
            { serverToolName: "merge_pull_request", parameters: {}, class: "effect" },
          ],
        },
      }),
    });

    const blockCatalog = new KernelToolCatalog();
    using blockHost = new McpConnectionToolCatalogHost(blockCatalog, {
      github: mcpConnection({ live: { tools: listed("get_issue", "merge_pull_request") } }),
    });
    void blockHost;
    const root = new SessionRoot({ sessionId: "s-block", path: "/tmp/block" });
    root.blockTool("github", "merge_pull_request", "session");
    bindSessionCatalog(root, blockCatalog);
    const view = sessionCatalog(root);

    expect({
      hideExcluded: {
        sources: excludedHost.connectionEntries.map((entry) => entry.source),
        merge: excludedCatalog.catalogEntry("mcp__github__merge_pull_request"),
        secret: excludedCatalog.catalogEntry("mcp__github__get_secret"),
      },
      onlyExclude: onlyExcludeHost.connectionEntries.map((entry) => entry.wireName),
      toolSeverity: Object.fromEntries(
        severityHost.connectionEntries.map((entry) => [
          entry.source.kind === "connection" ? entry.source.serverToolName : entry.wireName,
          entry.class,
        ]),
      ),
      sessionBlocklist: {
        getIssue: view?.catalogEntry("mcp__github__get_issue")?.source,
        sessionMerge: view?.catalogEntry("mcp__github__merge_pull_request"),
        kernelMerge: blockCatalog.catalogEntry("mcp__github__merge_pull_request")?.source,
      },
    }).toEqual({
      hideExcluded: {
        sources: [
          { kind: "connection", connectionKey: "github", serverToolName: "get_issue" },
          { kind: "connection", connectionKey: "github", serverToolName: "list_issues" },
        ],
        merge: undefined,
        secret: undefined,
      },
      onlyExclude: ["mcp__mail__search"],
      toolSeverity: {
        get_issue: "read",
        mark_all_notifications_read: "effect",
        merge_pull_request: "write",
      },
      sessionBlocklist: {
        getIssue: { kind: "connection", connectionKey: "github", serverToolName: "get_issue" },
        sessionMerge: undefined,
        kernelMerge: { kind: "connection", connectionKey: "github", serverToolName: "merge_pull_request" },
      },
    });
  });
});
