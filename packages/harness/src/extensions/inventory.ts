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
  pluginManifestSchema,
  type AdvertisedDriver,
  type LoadedCommand,
} from "./schemas/plugin-manifest.js";

export function readPluginInventory(
  root: string,
  disabled: ReadonlySet<string>,
): {
  readonly plugins: readonly z.infer<typeof consentedPluginSchema>[];
  readonly commands: readonly LoadedCommand[];
  readonly drivers: readonly AdvertisedDriver[];
} {
  const { presence, load } = buildPluginGraph({
    installRoot: root,
    isEnabled: (name) => !disabled.has(name),
  });
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
  for (const node of load) {
    for (const driver of readInhumanExtension(node.root).drivers) {
      if (!(isPackageFormSpecifier(driver.importPath) && packageNameOfSpecifier(driver.importPath) === node.npmName))
        continue;
      driversByName.set(driver.name, driver);
    }
  }
  return {
    plugins: presence.map((node) =>
      consentedPluginSchema.parse({
        pluginName: node.pluginName,
        sourceNpm: node.npmName,
        sourceVersion: node.version,
        rootPath: node.root,
        enabled: !disabled.has(node.pluginName),
        extensions: { "tools.inhuman": readInhumanExtension(node.root) },
      }),
    ),
    commands: [...commandsByVerb.values()],
    drivers: [...driversByName.values()],
  };
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
