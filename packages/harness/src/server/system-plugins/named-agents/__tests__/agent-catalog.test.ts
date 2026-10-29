/** No per-recipe `call__` wrappers. */
import { AGENT_SEND, AGENT_VOID, AskAgentSpec, SessionRoot } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { catalogRecipe, edgeCreatesCycle, invokeCyclePath, invokeDenied } from "@/tool-catalog";
import { peelAgentCallArgs } from "@/tool-runtime";

import { KernelToolCatalog, workerToolAllowed } from "../../../toolkit/tool-table.js";

describe("named-agent catalog", () => {
  it("catalog guts: no call__ wrappers; reject unknown/collisions/cycles; invoke recipe-scoped; peelAgentCallArgs", () => {
    const catalog = new KernelToolCatalog();
    catalog.replaceRecipes([
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        keepAlive: false,
        capabilities: [{ name: "ping", supportsNotify: true }],
        invokes: [],
      }),
    ]);
    expect({
      call: catalog.catalogEntry("call__echo__ping"),
      send: catalog.catalogEntry(AGENT_SEND)?.class,
    }).toEqual({ call: undefined, send: "effect" });

    const unknown = (): unknown => {
      try {
        catalog.replaceRecipes([
          catalogRecipe({
            name: "a",
            recipeScope: "session",
            category: "internal",
            capabilities: [{ name: "go" }],
            invokes: ["missing"],
          }),
        ]);
        return null;
      } catch (error) {
        return String(error);
      }
    };
    const selfCycle = (): unknown => {
      try {
        catalog.replaceRecipes([
          catalogRecipe({
            name: "a",
            recipeScope: "session",
            category: "internal",
            capabilities: [{ name: "go" }],
            invokes: ["a"],
          }),
        ]);
        return null;
      } catch (error) {
        return String(error);
      }
    };
    const pair = [
      catalogRecipe({
        name: "a",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: ["b"],
      }),
      catalogRecipe({
        name: "b",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: ["a"],
      }),
    ];
    const pairCycle = (): unknown => {
      try {
        catalog.replaceRecipes(pair);
        return null;
      } catch (error) {
        return String(error);
      }
    };
    catalog.replaceRecipes([
      catalogRecipe({
        name: "a",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: [],
      }),
      catalogRecipe({
        name: "b",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "go" }],
        invokes: [],
      }),
    ]);
    expect({
      unknown: unknown(),
      selfCycle: selfCycle(),
      pairPath: invokeCyclePath(pair),
      pairCycle: pairCycle(),
      ab: edgeCreatesCycle(catalog.recipes, "a", "b"),
      aa: edgeCreatesCycle(catalog.recipes, "a", "a"),
    }).toEqual({
      unknown: expect.stringMatching(/unknown "missing"/),
      selfCycle: expect.stringMatching(/cycle/),
      pairPath: ["a", "b", "a"],
      pairCycle: expect.stringMatching(/cycle/),
      ab: false,
      aa: true,
    });

    const recipes = [
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping", supportsNotify: true }],
        invokes: [],
      }),
      catalogRecipe({
        name: "other",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping" }],
        invokes: ["echo"],
      }),
    ];
    const peeled = peelAgentCallArgs(JSON.stringify({ spec: "echo", message: "hi", oneShot: true, readonly: true }));
    expect({
      invoke: {
        client: invokeDenied(recipes, "", "echo"),
        worker: invokeDenied(recipes, "echo", "other"),
        declared: invokeDenied(recipes, "other", "echo"),
      },
      peel: {
        oneShot: peeled.oneShot,
        readonly: peeled.readonly,
        dump: JSON.parse(peeled.argsJson),
        defaultOneShot: peelAgentCallArgs(JSON.stringify({ spec: "echo", message: "hi" })).oneShot,
      },
    }).toEqual({
      invoke: {
        client: undefined,
        worker: "echo cannot invoke other",
        declared: undefined,
      },
      peel: {
        oneShot: true,
        readonly: true,
        dump: { spec: "echo", message: "hi" },
        defaultOneShot: false,
      },
    });
  });

  it("AskAgentSpec face name keeps the one-shot floor; tools overlay grants domain wires", () => {
    const catalog = new KernelToolCatalog();
    const overlay = new SessionRoot({ sessionId: "s", path: "/tmp" });
    overlay.agent.spec = new AskAgentSpec({ name: "analyze", tools: ["read_file"] });
    const inherit = new SessionRoot({ sessionId: "s2", path: "/tmp" });
    inherit.agent.spec = new AskAgentSpec({ name: "analyze", inheritCallerTools: true });
    const peeled = peelAgentCallArgs(
      JSON.stringify({
        message: "ir",
        constitution: "You analyze.",
        name: "analyze",
        inheritCallerTools: true,
        responseSchema: { type: "object" },
      }),
    );
    expect({
      overlay: {
        scheme: workerToolAllowed(catalog, "analyze", "scheme_repl", overlay),
        read: workerToolAllowed(catalog, "analyze", "read_file", overlay),
        write: workerToolAllowed(catalog, "analyze", "write_file", overlay),
        voided: workerToolAllowed(catalog, "analyze", AGENT_VOID, overlay),
      },
      inherit: {
        read: workerToolAllowed(catalog, "analyze", "read_file", inherit),
        glob: workerToolAllowed(catalog, "analyze", "glob", inherit),
        voided: workerToolAllowed(catalog, "analyze", AGENT_VOID, inherit),
      },
      peel: {
        faceName: peeled.faceName,
        inheritCallerTools: peeled.inheritCallerTools,
        dump: JSON.parse(peeled.argsJson),
      },
    }).toEqual({
      overlay: { scheme: true, read: true, write: false, voided: false },
      inherit: { read: true, glob: true, voided: false },
      peel: { faceName: "analyze", inheritCallerTools: true, dump: { message: "ir" } },
    });
  });
});
