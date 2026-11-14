import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import fs from "fs-extra";
import { z } from "zod";

import { buildPluginGraph } from "./graph.js";
import { isPackageFormSpecifier, packageNameOfSpecifier } from "./import-paths.js";
import { jailedInside } from "./jail.js";
import {
  consentedPluginSchema,
  inhumanExtensionSchema,
  loadedCommandSchema,
  packageJsonPeekSchema,
  pluginJsonNameSchema,
  pluginManifestSchema,
  type AdvertisedDriver,
  type LoadedCommand,
} from "./schemas/plugin-manifest.js";

type PublicPluginMcpServer = {
  readonly pluginName: string;
  readonly rootPath: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
};

export type PluginInventory = {
  readonly plugins: readonly z.infer<typeof consentedPluginSchema>[];
  readonly commands: readonly LoadedCommand[];
  readonly drivers: readonly AdvertisedDriver[];
  readonly publicMcpServers: readonly PublicPluginMcpServer[];
};

type InventoryNode = {
  readonly pluginName: string;
  readonly npmName: string;
  readonly version: string;
  readonly root: string;
};

function assembleInventory(
  presence: readonly InventoryNode[],
  load: readonly InventoryNode[],
  disabled: ReadonlySet<string>,
): PluginInventory {
  const commandsByVerb = new Map<string, LoadedCommand>();
  for (const node of load) {
    const commands = Object.entries(readInhumanExtension(node.root).commands).flatMap(([verb, declared]) => {
      if (verb === "") return [];
      if (declared.importPath.trim() === "") return [];
      const file = jailedInside(node.root, declared.importPath);
      if (file === null || !existsSync(file)) return [];
      try {
        return [
          loadedCommandSchema.parse({
            verb,
            description: declared.description,
            source: file,
            body: readFileSync(file, "utf8"),
          }),
        ];
      } catch {
        return [];
      }
    });
    for (const command of commands) {
      commandsByVerb.set(command.verb, command);
    }
  }
  const driversByName = new Map<string, AdvertisedDriver>();
  const publicMcpServers: PublicPluginMcpServer[] = [];
  for (const node of load) {
    const extension = readInhumanExtension(node.root);
    for (const server of extension.mcp) {
      if (server.visibility !== "public" || server.command === undefined) continue;
      publicMcpServers.push({
        pluginName: node.pluginName,
        rootPath: node.root,
        name: server.name,
        command: server.command,
        args: server.args ?? [],
      });
    }
    for (const driver of extension.drivers) {
      if (!(isPackageFormSpecifier(driver.importPath) && packageNameOfSpecifier(driver.importPath) === node.npmName))
        continue;
      driversByName.set(driver.name, driver);
    }
  }
  return {
    plugins: presence.map((node) => {
      const manifest = readPluginManifest(node.root);
      return consentedPluginSchema.parse({
        pluginName: node.pluginName,
        description: manifest.description,
        sourceNpm: node.npmName,
        sourceVersion: node.version,
        rootPath: node.root,
        enabled: !disabled.has(node.pluginName),
        extensions: { "tools.inhuman": manifest.extensions["tools.inhuman"] },
      });
    }),
    commands: [...commandsByVerb.values()],
    drivers: [...driversByName.values()],
    publicMcpServers,
  };
}

export function readPluginInventory(root: string, disabled: ReadonlySet<string>): PluginInventory {
  const { presence, load } = buildPluginGraph({
    installRoot: root,
    isEnabled: (name) => !disabled.has(name),
  });
  return assembleInventory(presence, load, disabled);
}

/** Read-only inventory over host-bundled runtime plugins for server kernels without disk node_modules. */
export function readBundledPluginInventory(
  packages: ReadonlyArray<{ readonly npmName: string; readonly rootPath: string }>,
  disabled: ReadonlySet<string>,
): PluginInventory {
  const presence: InventoryNode[] = [];
  for (const pkg of packages) {
    try {
      const rawManifest: unknown = fs.readJsonSync(join(pkg.rootPath, "plugin.json"));
      const named = pluginJsonNameSchema.safeParse(rawManifest);
      const manifest = pluginManifestSchema.safeParse(rawManifest);
      if (!named.success || !manifest.success || named.data.name.trim() === "") continue;
      let version = "0.0.0";
      try {
        const pkgJson = packageJsonPeekSchema.safeParse(fs.readJsonSync(join(pkg.rootPath, "package.json")));
        if (pkgJson.success && typeof pkgJson.data.version === "string" && pkgJson.data.version.trim() !== "") {
          version = pkgJson.data.version;
        }
      } catch {
        /* ignore missing package version */
      }
      presence.push({
        pluginName: named.data.name,
        npmName: pkg.npmName,
        version,
        root: pkg.rootPath,
      });
    } catch {
      /* skip malformed or absent bundled package */
    }
  }
  const load = presence.filter((node) => !disabled.has(node.pluginName));
  return assembleInventory(presence, load, disabled);
}

function readPluginManifest(pluginRoot: string): z.infer<typeof pluginManifestSchema> {
  try {
    return pluginManifestSchema.parse(fs.readJsonSync(join(pluginRoot, "plugin.json")));
  } catch {
    return pluginManifestSchema.parse({});
  }
}

function readInhumanExtension(pluginRoot: string): z.infer<typeof inhumanExtensionSchema> {
  return readPluginManifest(pluginRoot).extensions["tools.inhuman"];
}
