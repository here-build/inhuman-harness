import { programDigest } from "./consent.js";
import type { BehaviorSelection } from "./manifest.js";
import { PluginSurfaceError } from "./surface-error.js";

export type BehaviorPin = {
  readonly plugin: string;
  readonly programPath: string;
  readonly source: string;
  readonly modules: readonly {
    readonly path: string;
    readonly source: string;
  }[];
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly revision: string;
  readonly bindings: BehaviorSelection["bindings"];
};

/** Pin every module the program loaded, not only the entry file. */
export function pinSources(
  plugin: string,
  programPath: string,
  modules: ReadonlyMap<string, string>,
  configuration: Readonly<Record<string, unknown>>,
  bindings: BehaviorSelection["bindings"],
): BehaviorPin {
  const source = modules.get(programPath) ?? "";
  PluginSurfaceError.invariant(source.trim() !== "", "pinned source unavailable");
  return {
    plugin,
    programPath,
    source,
    modules: [...modules].map(([path, text]) => ({ path, source: text })),
    configuration,
    revision: programDigest(modules),
    bindings,
  };
}
