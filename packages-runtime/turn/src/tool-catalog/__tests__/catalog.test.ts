import { BotSpec } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  catalogRecipe,
  catalogTriggersReactLoop,
  invokeCyclePath,
  KernelToolCatalog,
  type CatalogEntry,
} from "../index.js";

function packEntry(wireName: string, pluginName: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    wireName,
    description: extra.description ?? wireName,
    parameters: extra.parameters ?? { type: "object", properties: {} },
    class: extra.class ?? "effect",
    source: extra.source ?? { kind: "pack", pluginName },
    execute: extra.execute,
    packMeta: extra.packMeta,
    representation: extra.representation,
    triggersReactLoop: extra.triggersReactLoop,
    isSideChannel: extra.isSideChannel,
    tapeHidden: extra.tapeHidden,
    exam: extra.exam,
  };
}

function connectionEntry(wireName: string, connectionKey: string, serverToolName: string): CatalogEntry {
  return {
    wireName,
    description: serverToolName,
    parameters: { type: "object", properties: {} },
    class: "read",
    source: { kind: "connection", connectionKey, serverToolName },
  };
}

describe("harness-tool-catalog", () => {
  it("starts empty: no builtins, no named-agent stdlib", () => {
    const catalog = new KernelToolCatalog();
    expect({
      entries: catalog.catalogEntries(),
      recipes: catalog.allRecipes(),
      compiled: catalog.compiledRecipes,
      addendum: catalog.TOOLS_SYSTEM_ADDENDUM,
    }).toEqual({ entries: [], recipes: [], compiled: [], addendum: "" });
  });

  it("accepts pack registrations; wireName is projection; source is the identity", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      packEntry("read_file", "toolkit", { class: "read" }),
      packEntry("mcp__looks_like_connection", "user-pack"),
    ]);
    const pack = catalog.catalogEntry("mcp__looks_like_connection");
    const read = catalog.catalogEntry("read_file");
    expect({
      names: catalog.catalogWireNames(),
      packSource: pack?.source,
      readClass: read?.class,
      missing: catalog.catalogEntry("write_file"),
    }).toEqual({
      names: ["read_file", "mcp__looks_like_connection"],
      packSource: { kind: "pack", pluginName: "user-pack" },
      readClass: "read",
      missing: undefined,
    });
  });

  it("connection source identity is connectionKey + serverToolName, not a parsed wireName", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([packEntry("shell", "shell", { class: "effect" })]);
    catalog.connectionHost = {
      connectionEntries: [connectionEntry("mcp__github__get_issue", "github", "get_issue")],
    };
    const row = catalog.catalogEntry("mcp__github__get_issue");
    expect({
      source: row?.source,
      notParsedFromWire: row?.source.kind === "connection" ? row.source.serverToolName : null,
      shellStillPack: catalog.catalogEntry("shell")?.source,
    }).toEqual({
      source: {
        kind: "connection",
        connectionKey: "github",
        serverToolName: "get_issue",
      },
      notParsedFromWire: "get_issue",
      shellStillPack: { kind: "pack", pluginName: "shell" },
    });
  });

  it("connection overwrites pack on the same wireName; behavior does not", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([packEntry("dup", "pack")]);
    catalog.connectionHost = {
      connectionEntries: [connectionEntry("dup", "mail", "dup")],
    };
    catalog.behaviorEntries = [packEntry("dup", "behavior"), packEntry("only-behavior", "behavior")];
    expect({
      dup: catalog.catalogEntry("dup")?.source,
      only: catalog.catalogEntry("only-behavior")?.source,
    }).toEqual({
      dup: { kind: "connection", connectionKey: "mail", serverToolName: "dup" },
      only: { kind: "pack", pluginName: "behavior" },
    });
  });

  it("recipes are real BotSpec models; authored overlay wins compiled", () => {
    const catalog = new KernelToolCatalog();
    catalog.replaceCompiledPlugins({
      compiledRecipes: [
        catalogRecipe({
          name: "reviewer",
          category: "internal",
          description: "stdlib",
        }),
      ],
    });
    catalog.replaceRecipes([
      catalogRecipe({
        name: "reviewer",
        category: "plugin",
        description: "user edit",
        invokes: [],
      }),
    ]);
    const recipe = catalog.recipe("reviewer");
    expect({
      description: recipe?.spec.description,
      model: recipe?.spec instanceof BotSpec,
      all: catalog.allRecipes().map((row) => row.spec.description),
    }).toEqual({
      description: "user edit",
      model: true,
      all: ["user edit"],
    });
  });

  it("replaceRecipes rejects invoke cycles", () => {
    const catalog = new KernelToolCatalog();
    expect(() =>
      catalog.replaceRecipes([
        catalogRecipe({ name: "a", category: "plugin", invokes: ["b"] }),
        catalogRecipe({ name: "b", category: "plugin", invokes: ["a"] }),
      ]),
    ).toThrow(/invoke cycle/);
    expect(invokeCyclePath([])).toBeNull();
  });

  it("stores representation on the row, apart from the react-loop flag", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      packEntry("write_file", "toolkit", { class: "write", representation: "both" }),
      packEntry("read_file", "toolkit", { class: "read", representation: "symbol" }),
      packEntry("scheme_repl", "scheme-repl", { representation: "tool" }),
      packEntry("update_metadata", "metadata", { representation: "both", triggersReactLoop: false }),
      packEntry("memory_save", "memory", {
        representation: "tool",
        packMeta: {
          kind: "bot-call",
          pluginName: "memory",
          target: "notes",
          background: false,
          lifetime: "turn",
          show: "result",
          supportsNotify: false,
        },
      }),
      packEntry("named_like_a_prior", "toolkit", { representation: "symbol" }),
      packEntry("loop_off", "meta", { triggersReactLoop: false }),
      packEntry("side_only", "meta", { isSideChannel: true }),
    ]);
    expect({
      representation: Object.fromEntries(
        catalog.catalogEntries().map((row) => [row.wireName, row.representation ?? null]),
      ),
      sideChannelLoop: catalogTriggersReactLoop(catalog, "update_metadata"),
      sideOnly: catalogTriggersReactLoop(catalog, "side_only"),
      absent: catalogTriggersReactLoop(catalog, "not_a_tool"),
    }).toEqual({
      representation: {
        write_file: "both",
        read_file: "symbol",
        scheme_repl: "tool",
        update_metadata: "both",
        memory_save: "tool",
        named_like_a_prior: "symbol",
        loop_off: null,
        side_only: null,
      },
      sideChannelLoop: false,
      sideOnly: false,
      absent: true,
    });
  });

  it("refuses a guarded mutation after dispose", () => {
    const catalog = new KernelToolCatalog();
    catalog[Symbol.dispose]();
    catalog[Symbol.dispose]();
    expect(catalog.disposed).toBe(true);
    expect(() => catalog.replacePack([])).toThrow("replacePack: disposed");
    expect(() => catalog.view()).toThrow("view: disposed");
  });
});
