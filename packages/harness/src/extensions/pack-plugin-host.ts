/**
 * Kernel-lifetime slot for pack catalog fills.
 *
 * Empty on purpose: this package does not load JS modules from
 * `plugin.json` `plugins[]`. Catalog contributions are registered from
 * outside. Sync and dispose leave the catalog alone.
 */
import type { KernelRoot } from "@inhuman.tools/harness-model";

import type { KernelToolCatalog } from "@/tool-catalog";

export type PackPluginRow = {
  readonly pluginName: string;
  readonly enabled: boolean;
  readonly rootPath: string;
  readonly modules: readonly string[];
};

type PackPluginOps = {
  readonly catalog: KernelToolCatalog;
  readonly kernelRoot: string;
  /** Kernel image for `PluginSpec` projection. Catalog-only hosts omit this. */
  readonly kernel?: KernelRoot;
  readonly onError?: (pluginName: string, error: unknown) => void;
};

export class PackPluginCatalogHost implements Disposable {
  constructor(_ops: PackPluginOps) {}

  async sync(_rows: readonly PackPluginRow[]): Promise<void> {}

  [Symbol.dispose](): void {}
}
