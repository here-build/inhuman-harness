import { describe, expect, it } from "vitest";

import { KernelToolCatalog } from "@/tool-catalog";

import { PackPluginCatalogHost } from "../pack-plugin-host.js";

describe("PackPluginCatalogHost", () => {
  it("sync is an empty lifecycle slot: it does not load modules or fill the catalog", async () => {
    const catalog = new KernelToolCatalog();
    const reports: string[] = [];
    const host = new PackPluginCatalogHost({
      catalog,
      kernelRoot: "/tmp",
      onError: (pluginName, error) => {
        reports.push(`${pluginName}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    await host.sync([
      {
        pluginName: "demo-pack",
        enabled: true,
        rootPath: "/tmp/does-not-exist",
        modules: ["./plugin.js"],
      },
    ]);
    expect({
      entries: catalog.catalogEntries(),
      reports,
    }).toEqual({ entries: [], reports: [] });
    host[Symbol.dispose]();
    expect(catalog.catalogEntries()).toEqual([]);
  });
});
