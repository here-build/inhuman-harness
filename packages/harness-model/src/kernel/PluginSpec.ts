/**
 * Authored plugin catalog on the kernel image. Install consent stays
 * {@link InstalledPlugin} — this record is the TUI-visible face. Null
 * `question` / `effect` / `caption` is uncovered; the TUI then falls
 * through. Mustache grain matches pretty-mcp.
 */
import { Model, model, state } from "@inhuman.tools/model";

import type { KernelRoot } from "./KernelRoot.js";

export type PluginToolFace = {
  readonly name: string;
  readonly question?: string | null;
  readonly effect?: string | null;
  readonly caption?: string | null;
};

@model("harness:plugin-tool-spec")
export class PluginToolSpec extends Model<any, PluginSpec | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.name;
  }

  @state accessor name: string = "";
  @state accessor question: string | null = null;
  @state accessor effect: string | null = null;
  @state accessor caption: string | null = null;
}

@model("harness:plugin-spec")
export class PluginSpec extends Model<any, KernelRoot | null> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.pluginName;
  }

  @state accessor pluginName: string = "";
  @state.childRecord accessor tools: Record<string, PluginToolSpec> = {};

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
