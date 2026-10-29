/**
 * Authored plugin catalog on the kernel image. Install consent stays
 * {@link InstalledPlugin} — this record is the TUI-visible face. Null
 * `question` / `effect` / `caption` is uncovered; the TUI then falls
 * through. Mustache grain matches pretty-mcp.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import type { KernelRoot } from "./KernelRoot.js";

export type PluginToolFace = {
  readonly name: string;
  readonly question?: string | null;
  readonly effect?: string | null;
  readonly caption?: string | null;
};

@syncing("harness:plugin-tool-spec")
export class PluginToolSpec extends PlexusModel<PluginSpec | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.name;
  }

  @syncing accessor name: string = "";
  @syncing accessor question: string | null = null;
  @syncing accessor effect: string | null = null;
  @syncing accessor caption: string | null = null;
}

@syncing("harness:plugin-spec")
export class PluginSpec extends PlexusModel<KernelRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.pluginName;
  }

  @syncing accessor pluginName: string = "";
  @syncing.child.record accessor tools: Record<string, PluginToolSpec> = {};

  constructor(
    opts?:
      | {
          pluginName?: string;
          tools?: Record<string, PluginToolSpec>;
        }
      | symbol,
  ) {
    super(opts);
  }
}

function faceText(value: string | null | undefined): string | null {
  return value ?? null;
}

/** Replace one plugin's tool faces. Leftover wire names on that spec are dropped. */
export function projectPluginSpec(root: KernelRoot, pluginName: string, tools: readonly PluginToolFace[]): PluginSpec {
  return root.replacePluginTools(pluginName, tools);
}

export function writePluginTools(root: KernelRoot, pluginName: string, tools: readonly PluginToolFace[]): PluginSpec {
  const spec = (root.pluginSpecs[pluginName] ??= new PluginSpec());
  spec.pluginName = pluginName;
  const keep = new Set<string>();
  for (const tool of tools) {
    if (tool.name === "") continue;
    keep.add(tool.name);
    const row = (spec.tools[tool.name] ??= new PluginToolSpec());
    row.name = tool.name;
    row.question = faceText(tool.question);
    row.effect = faceText(tool.effect);
    row.caption = faceText(tool.caption);
  }
  for (const name of Object.keys(spec.tools)) {
    if (!keep.has(name)) delete spec.tools[name];
  }
  return spec;
}
