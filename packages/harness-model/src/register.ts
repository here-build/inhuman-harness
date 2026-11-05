/**
 * Evaluate every `@syncing` class the documents can name.
 * A named import of `KernelPlexus` alone lets the bundler drop the rest;
 * `Plexus.connect` then throws `Invariant failed` on `entityClasses.get`.
 */
import * as pew from "@inhuman.tools/plexus-expectations";

import { registerModelExports } from "./register-models.js";

import * as models from "./index.js";

registerModelExports(models);
registerModelExports(pew);
