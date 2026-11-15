import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { buildPluginGraph } from "./graph.js";
import { isPackageFormSpecifier, packageNameOfSpecifier } from "./import-paths.js";
import { jailedInside } from "./jail.js";
import { hasCachedPluginText, isImmutablePluginRoot, readPluginText } from "./manifest.js";
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

function readJsonFile(path: string, immutable: boolean): unknown {
  const text = immutable || isImmutablePluginRoot(path) ? readPluginText(path, true) : readFileSync(path, "utf8");
  return JSON.parse(text) as unknown;
}

const bundledInventoryCache = new Map<string, PluginInventory>();

function assembleInventory(
  presence: readonly InventoryNode[],
  load: readonly InventoryNode[],
  disabled: ReadonlySet<string>,
  immutable: boolean,
): PluginInventory {
  const commandsByVerb = new Map<string, LoadedCommand>();
  for (const node of load) {
    const nodeImmutable = immutable || isImmutablePluginRoot(node.root);
    const commands = Object.entries(readInhumanExtension(node.root, nodeImmutable).commands).flatMap(
      ([verb, declared]) => {
        if (verb === "") return [];
        if (declared.importPath.trim() === "") return [];
        const file = jailedInside(node.root, declared.importPath);
        if (file === null || (!hasCachedPluginText(file) && !existsSync(file))) return [];
        try {
          return [
            loadedCommandSchema.parse({
              verb,
              description: declared.description,
              source: file,
              body: nodeImmutable ? readPluginText(file, true) : readFileSync(file, "utf8"),
            }),
          ];
        } catch {
          return [];
        }
      },
    );
    for (const command of commands) {
      commandsByVerb.set(command.verb, command);
    }
  }
  const driversByName = new Map<string, AdvertisedDriver>();
  const publicMcpServers: PublicPluginMcpServer[] = [];
  for (const node of load) {
    const extension = readInhumanExtension(node.root, immutable || isImmutablePluginRoot(node.root));
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
      const manifest = readPluginManifest(node.root, immutable || isImmutablePluginRoot(node.root));
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
  return assembleInventory(presence, load, disabled, false);
}

/** Read-only inventory over host-bundled runtime plugins for server kernels without disk node_modules. */
export function readBundledPluginInventory(
  packages: ReadonlyArray<{ readonly npmName: string; readonly rootPath: string }>,
  disabled: ReadonlySet<string>,
  options?: { readonly immutable?: boolean },
): PluginInventory {
  const allImmutable = options?.immutable === true || packages.every((pkg) => isImmutablePluginRoot(pkg.rootPath));
  const cacheKey = allImmutable
    ? `${packages.map((p) => `${p.npmName}\0${p.rootPath}`).join("\n")}::${[...disabled].sort().join("\0")}`
    : null;
  if (cacheKey !== null) {
    const cached = bundledInventoryCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const presence: InventoryNode[] = [];
  for (const pkg of packages) {
    const pkgImmutable = options?.immutable === true || isImmutablePluginRoot(pkg.rootPath);
    try {
      const rawManifest = readJsonFile(join(pkg.rootPath, "plugin.json"), pkgImmutable);
      const named = pluginJsonNameSchema.safeParse(rawManifest);
      const manifest = pluginManifestSchema.safeParse(rawManifest);
      if (!named.success || !manifest.success || named.data.name.trim() === "") continue;
      let version = "0.0.0";
      try {
        const pkgJson = packageJsonPeekSchema.safeParse(readJsonFile(join(pkg.rootPath, "package.json"), pkgImmutable));
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
  const result = assembleInventory(presence, load, disabled, options?.immutable === true);
  if (cacheKey !== null) {
    bundledInventoryCache.set(cacheKey, result);
  }
  return result;
}

function readPluginManifest(pluginRoot: string, immutable: boolean): z.infer<typeof pluginManifestSchema> {
  try {
    return pluginManifestSchema.parse(readJsonFile(join(pluginRoot, "plugin.json"), immutable));
  } catch {
    return pluginManifestSchema.parse({});
  }
}

function readInhumanExtension(pluginRoot: string, immutable: boolean): z.infer<typeof inhumanExtensionSchema> {
  return readPluginManifest(pluginRoot, immutable).extensions["tools.inhuman"];
}
