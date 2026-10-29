import { PlexusModel, syncing } from "@here.build/plexus";

import type { KernelRoot } from "./KernelRoot.js";

@syncing("harness:installed-plugin")
export class InstalledPlugin extends PlexusModel<KernelRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.pluginName;
  }

  @syncing accessor pluginName: string = "";
  @syncing accessor sourceNpm: string = "";
  @syncing accessor sourceVersion: string = "";
  @syncing accessor rootPath: string = "";
  @syncing accessor enabled: boolean = true;
  /** False keeps this plugin's foreground bot off the foreground agent. */
  @syncing accessor foreground: boolean = true;
  /** Declared InhumanPlugin specifiers (`plugin.json` `plugins[].importPath`). */
  @syncing.list accessor modules: string[] = [];
  @syncing accessor installedAt: number = Date.now();
  /** Why part of this plugin's surface (e.g. a bot) did not load. */
  @syncing accessor problem: string | null = null;

  constructor(
    opts?:
      | {
          pluginName?: string;
          sourceNpm?: string;
          sourceVersion?: string;
          sourcePath?: string;
          rootPath?: string;
          enabled?: boolean;
          foreground?: boolean;
          /** Declared `extensions.tools.inhuman.plugins[].importPath`. */
          modules?: readonly string[];
          installedAt?: number;
        }
      | symbol,
  ) {
    super(opts);
  }
}
