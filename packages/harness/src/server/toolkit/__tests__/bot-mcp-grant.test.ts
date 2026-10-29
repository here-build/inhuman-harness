import { SessionRoot } from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { describe, expect, it } from "vitest";

import { mcpJsonOf, mcpWireName, McpConnectionToolCatalogHost } from "@/runtime";
import { catalogRecipe, type CatalogRecipe } from "@/tool-catalog";
import { workerToolAllowed as turnWorkerToolAllowed } from "@/tool-runtime";

import { KernelToolCatalog, workerToolAllowed } from "../tool-table.js";

function connection(name: string, configuration: Record<string, unknown>, tools: readonly string[]) {
  const spec = new ConnectionSpec({
    driver: new DriverSpec({ abilityClaim: ["mcp"] }),
  });
  spec.name = name;
  spec.configuration = configuration;
  spec.live = {
    tools: tools.map((serverToolName) => ({
      serverToolName,
      parameters: { type: "object", properties: {} },
      class: "effect",
    })),
  };
  return spec;
}

function recipe(
  name: string,
  recipeScope: "session" | "project" | "global",
  mcp: Parameters<typeof mcpJsonOf>[0],
  tools: readonly string[] = [],
): CatalogRecipe {
  const row = catalogRecipe({ name, recipeScope, category: "plugin", tools });
  row.spec.mcpJson = mcpJsonOf(mcp);
  return row;
}

describe("bot MCP grants", () => {
  it("admit and execute use the same ceiling as the session view, on a derived catalog too", () => {
    const catalog = new KernelToolCatalog();
    const session = new SessionRoot({ sessionId: "here", path: "/work" });
    catalog.replaceRecipes([recipe("house", "global", [{ server: "notes", tools: ["search"] }])]);
    using host = new McpConnectionToolCatalogHost(catalog, {
      "notes-id": connection("notes", { command: "echo" }, ["search", "write"]),
    });
    expect(host.connectionFaces.size).toBe(1);
    const view = catalog.view();
    const search = mcpWireName("notes-id", "search");
    const write = mcpWireName("notes-id", "write");
    expect({
      sameFunction: turnWorkerToolAllowed === workerToolAllowed,
      granted: turnWorkerToolAllowed(view, "house", search, session),
      ungranted: turnWorkerToolAllowed(view, "house", write, session),
    }).toEqual({ sameFunction: true, granted: true, ungranted: false });
  });

  it("names a server inside the bot's pool, with optional tool, account, and session limits", () => {
    const catalog = new KernelToolCatalog();
    const projectSearch = mcpWireName("desk-id", "search");
    const session = new SessionRoot({ sessionId: "here", path: "/work" });
    const elsewhere = new SessionRoot({ sessionId: "else", path: "/else" });
    catalog.replaceRecipes([
      recipe("house", "global", [{ server: "notes", tools: ["search"] }]),
      recipe("local", "project", [{ server: "notes", account: "desk" }]),
      recipe("stranger", "project", [{ server: "notes", account: "nope" }]),
      recipe("narrow", "project", [{ server: "notes", account: "desk", session: "other" }]),
      recipe("sitting", "session", [{ server: "notes" }]),
      recipe("pinned", "global", [], [projectSearch]),
    ]);
    using host = new McpConnectionToolCatalogHost(catalog, {
      "notes-id": connection("notes", { command: "echo" }, ["search", "write"]),
      "desk-id": connection("notes", { command: "echo", project: "/work", account: "desk", session: "s1" }, ["search"]),
    });
    const globalSearch = mcpWireName("notes-id", "search");
    const globalWrite = mcpWireName("notes-id", "write");
    expect({
      faces: host.connectionFaces.size,
      globalSearch: workerToolAllowed(catalog, "house", globalSearch, session),
      globalWrite: workerToolAllowed(catalog, "house", globalWrite, session),
      globalOnProject: workerToolAllowed(catalog, "house", projectSearch, session),
      projectSearch: workerToolAllowed(catalog, "local", projectSearch, session),
      projectOnGlobal: workerToolAllowed(catalog, "local", globalSearch, session),
      otherProject: workerToolAllowed(catalog, "local", projectSearch, elsewhere),
      wrongAccount: workerToolAllowed(catalog, "stranger", projectSearch, session),
      wrongSession: workerToolAllowed(catalog, "narrow", projectSearch, session),
      sessionBot: workerToolAllowed(catalog, "sitting", projectSearch, session),
      sessionOnGlobal: workerToolAllowed(catalog, "sitting", globalSearch, session),
      explicitWire: workerToolAllowed(catalog, "pinned", projectSearch, session),
    }).toEqual({
      faces: 2,
      globalSearch: true,
      globalWrite: false,
      globalOnProject: false,
      projectSearch: true,
      projectOnGlobal: false,
      otherProject: false,
      wrongAccount: false,
      wrongSession: false,
      sessionBot: true,
      sessionOnGlobal: false,
      explicitWire: true,
    });
  });
});
