import { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_REVISION, DEFAULT_COMPACT_SOURCE } from "./compact-assets.js";
import { createModuleBundle } from "./module-bundle.js";
import type { CompactProgram } from "../session/compact.js";

export { DEFAULT_COMPACT_PROMPT, DEFAULT_COMPACT_REVISION, DEFAULT_COMPACT_SOURCE } from "./compact-assets.js";
export {
  createModuleBundle,
  pinModuleLoader,
  type ModuleBundle,
  type ModuleBundleInput,
  type ResourceIdentity,
} from "./module-bundle.js";

/** The installed strategy uses only its captured prompt module, including during replay. */
export function bundledCompactProgram(): CompactProgram {
  const resources = createModuleBundle({
    id: "inhuman:compact",
    revision: DEFAULT_COMPACT_REVISION,
    modules: { "compact.prompt": DEFAULT_COMPACT_PROMPT },
  });
  return Object.freeze({
    source: DEFAULT_COMPACT_SOURCE,
    sourcePath: "inhuman:compact/compact.scm",
    resource: { id: resources.id, revision: resources.revision },
    moduleLoader: resources.loader,
  });
}
