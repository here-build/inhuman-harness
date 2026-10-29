/**
 * Evaluate every `@syncing` class the documents can name.
 * A named import of `KernelPlexus` alone lets the bundler drop the rest;
 * `Plexus.connect` then throws `Invariant failed` on `entityClasses.get`.
 */
import * as pew from "@inhuman.tools/plexus-expectations";

import * as models from "./index.js";

function keep(mod: Record<string, unknown>): void {
  for (const value of Object.values(mod)) {
    if (typeof value === "function") void (value as { modelName?: string }).modelName;
  }
}

keep(models as Record<string, unknown>);
keep(pew as Record<string, unknown>);
