import { prompt } from "@inhuman.tools/harness-commons";
import {
  jobContinuationOf,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model/session";
import { expect, it, onTestFinished } from "vitest";

import { KernelToolCatalog, type CatalogEntry } from "../../tool-catalog/index.js";
import { catalogRecipe } from "../../tool-catalog/recipes.js";
import { ToolCallHandler, agentCallFromWire } from "../handler.js";
import { workerToolAllowed } from "../worker-tools.js";

it.each(["custom", "scheme_repl", "web_search", "web_extract", "agent__ask", "mcp__test__read", "private"])(
  "freezes policy before %s becomes reachable",
  (name) => {
    const catalog = new KernelToolCatalog();
    const entry: CatalogEntry = {
      wireName: name,
      description: name,
      class: "effect",
      parameters: {},
      continuation: { kind: "auxiliary", note: "Resume" },
      isSideChannel: true,
      tapeHidden: true,
      source:
        name === "mcp__test__read" || name === "private"
          ? { kind: "connection", connectionKey: "test", serverToolName: name }
          : { kind: "pack", pluginName: "test" },
    };
    if (name === "private") catalog.privateWorkerEntries = [entry];
    else if (entry.source.kind === "connection") catalog.connectionHost = { connectionEntries: [entry] };
    else catalog.replacePack([entry]);
    onTestFinished(() => catalog[Symbol.dispose]());
    const policies: unknown[] = [];
    const call = {
      id: "call",
      type: "function" as const,
      function: { name, arguments: '{"query":"q","url":"https://example.test"}' },
    };
    const job = new ToolCallHandler({ catalog }).admit(call, catalog, {
      parent: {
        registerJob(child) {
          policies.push({ policy: jobContinuationOf(child), side: child.isSideChannel, hidden: child.tapeHidden });
        },
      },
    });
    catalog.replacePack([]);
    catalog.connectionHost = undefined;
    catalog.privateWorkerEntries = [];
    expect({ policy: jobContinuationOf(job), reachable: policies }).toEqual({
      policy: { kind: "auxiliary", note: "Resume" },
      reachable: [{ policy: { kind: "auxiliary", note: "Resume" }, side: true, hidden: true }],
    });
    if (name === "agent__ask") {
      catalog.replacePack([entry]);
      expect(jobContinuationOf(agentCallFromWire(call, catalog))).toEqual({ kind: "auxiliary", note: "Resume" });
    }
  },
);

it("continuation none and auxiliary cannot bypass a named worker's tool grants", () => {
  const catalog = new KernelToolCatalog();
  catalog.replaceRecipes([
    catalogRecipe({
      name: "worker",
      category: "internal",
      recipeScope: "session",
      tools: [],
      capabilities: [],
      invokes: [],
    }),
  ]);
  catalog.replacePack(
    ["none", "auxiliary"].map((kind) => ({
      wireName: kind,
      description: kind,
      class: "effect",
      parameters: {},
      source: { kind: "pack", pluginName: "test" } as const,
      continuation: kind === "none" ? { kind: "none" as const } : { kind: "auxiliary" as const },
    })),
  );
  const session = SessionPlexus.create("worker-policy");
  session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`task`, queue: [] });
  onTestFinished(() => {
    catalog[Symbol.dispose]();
    session.destroy();
  });
  expect(workerToolAllowed(catalog, "worker", "none", session.root)).toBe(false);
  expect(workerToolAllowed(catalog, "worker", "auxiliary", session.root)).toBe(false);
});
