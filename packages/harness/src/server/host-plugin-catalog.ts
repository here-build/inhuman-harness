import type { InhumanPlugin } from "@inhuman.tools/plugin-sdk";

import { readBundledPluginInventory, warmPluginDirectory, type PluginPackage } from "@/extensions";

import { KERNEL_SEED_PACKAGES, resolveSeedPackageRoot } from "./daemon/kernel/kernel-package.js";
import { botRevisions } from "./daemon/session/plugin-bots.js";

export type BundledPluginSpec = {
  readonly npmName: string;
  readonly rootPath: string;
};

export type HostRuntimePluginCatalogOptions = {
  readonly bundledPlugins?: readonly BundledPluginSpec[];
  readonly includeSeedPackages?: boolean;
  readonly runtimePlugins?: Readonly<Record<string, InhumanPlugin>>;
};

/**
 * Host-curated catalog of bundled Scheme plugins and in-process `InhumanPlugin`
 * extensions shared across all tenant kernels in the `"server"` contour.
 *
 * Calling `await catalog.warm()` once at server startup preloads all bundled plugin
 * manifests, commands, states, ABI sources, and pinned bot behavior graphs into
 * immutable memory caches so subsequent per-tenant kernel boots read zero plugin
 * files from disk.
 */
export class HostRuntimePluginCatalog {
  readonly bundledPlugins: readonly BundledPluginSpec[];
  readonly runtimePlugins: Readonly<Record<string, InhumanPlugin>>;
  #warmed = false;
  #knownNames: Set<string> | null = null;

  constructor(options: HostRuntimePluginCatalogOptions = {}) {
    const byNpm = new Map<string, BundledPluginSpec>();
    if (options.includeSeedPackages !== false) {
      for (const npmName of KERNEL_SEED_PACKAGES) {
        const rootPath = resolveSeedPackageRoot(npmName);
        if (rootPath !== null) {
          byNpm.set(npmName, { npmName, rootPath });
        }
      }
    }
    for (const pkg of options.bundledPlugins ?? []) {
      byNpm.set(pkg.npmName, { npmName: pkg.npmName, rootPath: pkg.rootPath });
    }
    this.bundledPlugins = [...byNpm.values()];
    this.runtimePlugins = { ...(options.runtimePlugins ?? {}) };
  }

  get warmed(): boolean {
    return this.#warmed;
  }

  async warm(): Promise<this> {
    for (const pkg of this.bundledPlugins) {
      try {
        warmPluginDirectory(pkg.rootPath);
      } catch {
        /* tolerate malformed optional bundled package during warm; inventory filters invalid manifests */
      }
    }
    const inventory = readBundledPluginInventory(this.bundledPlugins, new Set(), { immutable: true });
    const packages: PluginPackage[] = inventory.plugins.map((plugin) => ({
      name: plugin.pluginName,
      root: plugin.rootPath,
      foreground: true,
      immutable: true,
    }));
    await botRevisions(packages);
    const names = new Set<string>(inventory.plugins.map((plugin) => plugin.pluginName));
    for (const name of Object.keys(this.runtimePlugins)) {
      names.add(name);
    }
    this.#knownNames = names;
    this.#warmed = true;
    return this;
  }

  #ensureNames(): Set<string> {
    if (this.#knownNames !== null) return this.#knownNames;
    const inventory = readBundledPluginInventory(this.bundledPlugins, new Set(), { immutable: this.#warmed });
    const names = new Set<string>(inventory.plugins.map((plugin) => plugin.pluginName));
    for (const name of Object.keys(this.runtimePlugins)) {
      names.add(name);
    }
    this.#knownNames = names;
    return names;
  }

  has(name: string): boolean {
    return this.#ensureNames().has(name);
  }

  listNames(): string[] {
    return [...this.#ensureNames()].sort();
  }

  kernelOptions(): {
    readonly bundledPlugins: readonly BundledPluginSpec[];
    readonly runtimePlugins: Readonly<Record<string, InhumanPlugin>>;
  } {
    return {
      bundledPlugins: this.bundledPlugins,
      runtimePlugins: this.runtimePlugins,
    };
  }
}
