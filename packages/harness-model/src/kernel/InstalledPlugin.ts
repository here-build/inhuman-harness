import { Model, model, state } from "@inhuman.tools/model";

import type { KernelRoot } from "./KernelRoot.js";

@model("harness:installed-plugin")
export class InstalledPlugin extends Model<any, KernelRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.pluginName;
  }

  @state accessor pluginName: string = "";
  @state accessor sourceNpm: string = "";
  @state accessor sourceVersion: string = "";
  @state accessor rootPath: string = "";
  @state accessor enabled: boolean = true;
  /** False keeps this plugin's foreground bot off the foreground agent. */
  @state accessor foreground: boolean = true;
  /** Declared InhumanPlugin specifiers (`plugin.json` `plugins[].importPath`). */
  @state.list accessor modules: string[] = [];
  @state accessor installedAt: number = Date.now();
  /** Why part of this plugin's surface (e.g. a bot) did not load. */
  @state accessor problem: string | null = null;

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
