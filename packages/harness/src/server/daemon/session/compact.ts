/**
 * The compact strategy loader bound to this package's shipped strategies.
 * The calculations and the actor live in the turn package; only the default
 * strategy paths are the harness's.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { programSourceLoader } from "@inhuman.tools/scheme-program/fs";
import { pinModuleLoader } from "@inhuman.tools/turn/resources";

import {
  loadCompactProgram as loadSessionCompactProgram,
  type CompactProgram as LoadedCompactProgram,
  type CompactStrategyResolve,
} from "@/session";

import { defaultCompactStrategySource, packageStrategyPath, resolveCompactStrategyPath } from "../../defaults/index.js";

const resolve: CompactStrategyResolve = {
  resolvePath: resolveCompactStrategyPath,
  defaultSource: defaultCompactStrategySource,
  packageStrategyPath,
  readFile: (path) => readFileSync(path, "utf8"),
};

/**
 * The loaded strategy. `source` is what `applyCompact` executes; `sourcePath`
 * is the module root for `(require …)`.
 */
export function loadCompactProgram(spec?: string, kernelFsRoot?: string): LoadedCompactProgram {
  const loaded = loadSessionCompactProgram(spec, kernelFsRoot, resolve);
  return loaded.sourcePath == null
    ? loaded
    : { ...loaded, moduleLoader: pinModuleLoader(programSourceLoader(dirname(loaded.sourcePath))) };
}
