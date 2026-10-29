import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KernelPlexus } from "@inhuman.tools/harness-model";
import { mkdir, mkdtemp, readJson, writeFile, writeJson } from "fs-extra";
import { describe, expect, it } from "vitest";

import { buildPluginGraph, PackPluginCatalogHost } from "@/extensions";

import { reflectKernel } from "../daemon/kernel/fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { KernelToolCatalog } from "../toolkit/tool-table.js";

const DEMO_PACK = fileURLToPath(new URL("../toolkit/__tests__/fixtures/demo-pack", import.meta.url));
const PLUGINS_ROOT = fileURLToPath(new URL("../../../../../plugins", import.meta.url));

const PING = `(harness/choice :choices (list (harness/choice :name "from-plugin")))
`;

describe("pack plugins", () => {
  it("plugin confinement and shipped load", async () => {
    const catalogA = new KernelToolCatalog();
    const catalogB = new KernelToolCatalog();
    const reports: string[] = [];
    const hostA = new PackPluginCatalogHost({
      catalog: catalogA,
      kernelRoot: "/tmp",
      onError: (pluginName, error) => {
        reports.push(`${pluginName}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const hostB = new PackPluginCatalogHost({
      catalog: catalogB,
      kernelRoot: "/tmp",
    });
    let host;
    try {
      const badRow = {
        pluginName: "bad-pack",
        enabled: true,
        rootPath: "/tmp/does-not-exist",
        modules: ["./missing.js"],
      } as const;
      const demoRow = {
        pluginName: "demo-pack",
        enabled: true,
        rootPath: DEMO_PACK,
        modules: ["./plugin.js"],
      } as const;
      await hostA.sync([badRow, demoRow]);
      await hostA.sync([
        badRow,
        demoRow,
        {
          pluginName: "later-pack",
          enabled: false,
          rootPath: DEMO_PACK,
          modules: ["./plugin.js"],
        },
      ]);
      await hostB.sync([
        {
          pluginName: "other-pack",
          enabled: true,
          rootPath: DEMO_PACK,
          modules: ["./plugin.js"],
        },
      ]);
      const catalogASource = catalogA.catalogEntry("demo_ping")?.source;
      const catalogBSource = catalogB.catalogEntry("demo_ping")?.source;
      hostB[Symbol.dispose]();
      host = {
        missing: reports.filter((row) => row.startsWith("bad-pack:")).length,
        catalogA: catalogASource,
        catalogB: catalogBSource,
        catalogBAfterDispose: catalogB.catalogEntry("demo_ping"),
        catalogAAfter: catalogA.catalogEntry("demo_ping")?.source,
      };
    } finally {
      hostA[Symbol.dispose]();
    }

    const ghostRoot = await mkdtemp(join(tmpdir(), "harness-pack-ghost-"));
    await writeJson(join(ghostRoot, "package.json"), {
      name: "harness-kernel",
      private: true,
      dependencies: { ghost: "1.0.0" },
    });
    const ghostGraph = buildPluginGraph({ installRoot: ghostRoot });

    const leftoverRoot = await mkdtemp(join(tmpdir(), "harness-pack-left-"));
    await writeJson(join(leftoverRoot, "package.json"), {
      name: "harness-kernel",
      private: true,
      dependencies: {},
    });
    await writeJson(join(leftoverRoot, "config.json"), { connections: {} });
    await writePlugin(leftoverRoot, "fake-plug", {
      commands: { ping: PING },
      drivers: { ok: { importPath: "fake-plug/drivers/ok", abilityClaim: ["completion"] } },
    });
    const leftoverPlexus = KernelPlexus.bootstrap();
    reflectKernel(leftoverRoot, leftoverPlexus.root);
    const leftover = {
      plugin: leftoverPlexus.root.plugins["fake-plug"],
      ping: leftoverPlexus.root.commands.ping,
    };
    leftoverPlexus.doc.destroy();

    const system = await mkdtemp(join(tmpdir(), "harness-pack-bad-"));
    await writeJson(join(system, "package.json"), {
      name: "harness-kernel",
      private: true,
      dependencies: { "bad-pack": "0.0.0", "demo-pack": "0.0.0", "fake-plug": "1.0.0" },
    });
    await writeJson(join(system, "config.json"), {
      connections: { work: { driver: "ok", name: "Work" } },
      extensions: {
        "tools.inhuman": {
          drivers: [
            {
              name: "ghost",
              importPath: "fake-plug/drivers/ghost",
              abilityClaim: ["completion"],
            },
          ],
        },
      },
    });
    mkdirSync(join(system, "node_modules"), { recursive: true });

    const bad = join(system, "node_modules", "bad-pack");
    await mkdir(bad);
    await writeJson(join(bad, "package.json"), { name: "bad-pack", version: "0.0.0", type: "module" });
    await writeJson(join(bad, "plugin.json"), {
      name: "bad-pack",
      extensions: {
        "tools.inhuman": {
          plugins: [{ importPath: "./missing.js" }],
        },
      },
    });
    symlinkSync(DEMO_PACK, join(system, "node_modules", "demo-pack"));
    await writeFile(join(system, "escape.scm"), PING);
    await writePlugin(system, "fake-plug", {
      commands: {
        ping: { body: PING, importPath: "../escape.scm" },
        extra: { body: PING, importPath: "./commands/extra.scm" },
      },
      drivers: {
        ok: { importPath: "fake-plug/drivers/ok", abilityClaim: ["completion"] },
        nope: { importPath: "other-pkg/drivers/nope", abilityClaim: ["completion"] },
        path: { importPath: "./drivers/x", abilityClaim: ["completion"] },
      },
    });
    await writePlugin(system, "leftover-plug", { commands: { ping: PING } });

    using kernel = new KernelDaemon(system);
    await kernel.ready;
    expect({
      host,
      ghost: {
        presence: ghostGraph.presence,
        load: ghostGraph.load,
        error: ghostGraph.errors[0],
      },
      leftover,
      kernel: {
        missingJs: existsSync(join(bad, "missing.js")),
        readFile: kernel.catalog.catalogEntry("read_file") != null,
        demoPack: kernel.plexus.root.plugins["demo-pack"]?.modules,
        demoPing: kernel.plexus.root.pluginTool("demo_ping")?.question,
        taskCreate: kernel.plexus.root.pluginTool("task__create")?.question,
        leftoverPlug: kernel.plexus.root.plugins["leftover-plug"],
        ping: kernel.plexus.root.commands.ping,
        extra: kernel.plexus.root.commands.extra?.source,
        drivers: {
          ok: kernel.plexus.root.drivers.ok?.importPath,
          ghost: kernel.plexus.root.drivers.ghost,
          nope: kernel.plexus.root.drivers.nope,
          path: kernel.plexus.root.drivers.path,
        },
        work: kernel.plexus.root.connections.work?.name,
      },
    }).toEqual({
      host: {
        missing: 0,
        catalogA: undefined,
        catalogB: undefined,
        catalogBAfterDispose: undefined,
        catalogAAfter: undefined,
      },
      ghost: {
        presence: [],
        load: [],
        error: expect.stringContaining('"ghost"'),
      },
      leftover: { plugin: undefined, ping: undefined },
      kernel: {
        missingJs: false,
        readFile: true,
        demoPack: [],
        demoPing: undefined,
        taskCreate:
          "create **{{subject}}**?{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}",
        leftoverPlug: undefined,
        ping: undefined,
        extra: expect.stringContaining(`${join("fake-plug", "commands", "extra.scm")}`),
        drivers: {
          ok: "fake-plug/drivers/ok",
          ghost: undefined,
          nope: undefined,
          path: undefined,
        },
        work: "Work",
      },
    });

    const shipped = await mkdtemp(join(tmpdir(), "harness-shipped-"));
    const dirs = readdirSync(PLUGINS_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const deps: Record<string, string> = {};
    const names: string[] = [];
    mkdirSync(join(shipped, "node_modules"), { recursive: true });
    for (const entry of dirs) {
      const dir = join(PLUGINS_ROOT, entry.name);
      const manifest = (await readJson(join(dir, "plugin.json")).catch(() => null)) as {
        name?: string;
      } | null;
      const pkg = (await readJson(join(dir, "package.json")).catch(() => null)) as {
        name?: string;
      } | null;
      if (typeof manifest?.name !== "string" || typeof pkg?.name !== "string") continue;
      deps[pkg.name] = "0.0.0";
      names.push(manifest.name);
      const dest = join(shipped, "node_modules", pkg.name);
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(dir, dest);
    }
    await writeJson(join(shipped, "package.json"), {
      name: "harness-kernel",
      private: true,
      dependencies: deps,
    });
    await writeJson(join(shipped, "config.json"), { connections: {} });
    const shippedGraph = buildPluginGraph({ installRoot: shipped });
    const shippedPlexus = KernelPlexus.bootstrap();
    reflectKernel(shipped, shippedPlexus.root);
    expect({
      discovered: names.length > 0,
      errors: shippedGraph.errors,
      presence: [...shippedGraph.presence.map((row) => row.pluginName)].sort(),
      loaded: Object.keys(shippedPlexus.root.plugins).sort(),
    }).toEqual({
      discovered: true,
      errors: [],
      presence: [...names].sort(),
      loaded: [...names].sort(),
    });
    shippedPlexus.doc.destroy();
  }, 15_000);
});

type CommandBody = string | { readonly body: string; readonly importPath: string };

type DriverRow = {
  readonly importPath: string;
  readonly abilityClaim?: readonly string[];
};

async function writePlugin(
  root: string,
  npmName: string,
  spec: {
    readonly commands?: Record<string, CommandBody>;
    readonly drivers?: Record<string, DriverRow>;
  },
): Promise<string> {
  const pkg = join(root, "node_modules", npmName);
  await mkdir(join(pkg, "commands"), { recursive: true });
  await writeJson(join(pkg, "package.json"), { name: npmName, version: "1.0.0" });
  const declaredCommands: Record<string, { description: string; importPath: string }> = {};
  for (const [verb, body] of Object.entries(spec.commands ?? {})) {
    const row = typeof body === "string" ? { body, importPath: `./commands/${verb}.scm` } : body;
    const file = join(pkg, "commands", `${verb}.scm`);
    if (row.importPath.startsWith("./")) await writeFile(join(pkg, row.importPath), row.body);
    else await writeFile(file, row.body);
    declaredCommands[verb] = { description: verb, importPath: row.importPath };
  }
  await writeJson(join(pkg, "plugin.json"), {
    name: npmName,
    extensions: {
      "tools.inhuman": {
        commands: declaredCommands,
        drivers: Object.entries(spec.drivers ?? {}).map(([name, row]) => ({
          name,
          description: "",
          importPath: row.importPath,
          abilityClaim: [...(row.abilityClaim ?? [])],
          multiplicity: "add-as-secondary",
        })),
      },
    },
  });
  return pkg;
}
